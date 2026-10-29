/**
 * 原子写、独占创建与字节哈希。
 *
 * 契约要求（「路径、锁与资源」「操作阶段与部分失败」）：
 * - JSON/提交/回执使用**同目录临时文件 + 原子替换**；
 * - 不可变文件使用**独占创建**，已有内容不一致则视为冲突；
 * - 读取提交与复制时重新核对哈希，防止「校验后换内容」；
 * - 不回滚、不删除已保留的证据，冲突只前向修复。
 *
 * 冲突统一用 `OPERATION_CONFLICT`：契约的错误码表里没有更细的文件级码，
 * 而「同一身份下内容不一致」正是该码的语义（编排契约「稳定错误码」）。
 *
 * 本模块是 I/O 边界：只做字节搬运与校验，不做业务判断。
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ContractError } from './errors.js';
import { thrownCode } from './guards.js';
function conflict(message, nextStep, details) {
    return new ContractError({ code: 'OPERATION_CONFLICT', message, nextStep, details });
}
/**
 * 只对这三个码做重试：Windows 上并发写同一目录 / 杀软与索引器持有句柄会让
 * `fs.rename` 与 `open(..., 'wx')` 偶发 `EPERM`、`EACCES`、`EBUSY`。
 *
 * 这是**真实**的健壮性缺陷（T5/T6/T7 都观察到门禁约 1/6 次飘红），不是测试噪音；
 * 但重试面必须窄：`EEXIST`（幂等/冲突信号）、`ENOENT`（目标真的不存在）与哈希不一致
 * 都是**有意义的失败**，重试只会把确定性错误变成随机行为。
 */
export const TRANSIENT_REPLACE_CODES = Object.freeze(['EPERM', 'EACCES', 'EBUSY']);
/** 有界重试：最多尝试 3 次（含第一次）。 */
export const DEFAULT_REPLACE_ATTEMPTS = 3;
/** 短退避基数：第 n 次失败后等 `n * 5ms`（最坏 15ms，不拖慢门禁）。 */
const DEFAULT_REPLACE_DELAY_MS = 5;
/** 默认 I/O 实现；测试可注入 `options.io`（形状与 `fs/promises` 子集一致）。 */
const DEFAULT_IO = Object.freeze({ mkdir, readFile, rename, rm, writeFile });
function ioOf(options = {}) {
    const io = options.io;
    return io === undefined || io === null ? DEFAULT_IO : { ...DEFAULT_IO, ...io };
}
function sleepFor(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
function isTransientReplaceError(error, codes) {
    const code = thrownCode(error);
    return code !== null && codes.includes(code);
}
/**
 * 有界重试一次「替换 / 独占创建」动作。
 *
 * 契约：只对 `codes`（默认 {@link TRANSIENT_REPLACE_CODES}）重试；最多 `attempts` 次；
 * 耗尽后抛**原始错误对象**（不包装、不改码、不吞）；非瞬时错误第一次就直接抛。
 */
async function replaceWithRetry(run, options = {}) {
    const configuredAttempts = options.attempts;
    const attempts = typeof configuredAttempts === 'number' && Number.isSafeInteger(configuredAttempts) && configuredAttempts > 0
        ? configuredAttempts
        : DEFAULT_REPLACE_ATTEMPTS;
    const configuredDelay = options.delayMs;
    const delayMs = typeof configuredDelay === 'number' && Number.isSafeInteger(configuredDelay) && configuredDelay >= 0
        ? configuredDelay
        : DEFAULT_REPLACE_DELAY_MS;
    const codes = Array.isArray(options.codes) ? options.codes : TRANSIENT_REPLACE_CODES;
    const sleep = typeof options.sleep === 'function' ? options.sleep : sleepFor;
    for (let attempt = 1;; attempt += 1) {
        try {
            return await run();
        }
        catch (error) {
            if (!isTransientReplaceError(error, codes) || attempt >= attempts)
                throw error;
            await sleep(delayMs * attempt);
        }
    }
}
/**
 * 计算字节摘要。
 * @returns 小写十六进制 SHA256
 */
export function sha256Bytes(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}
/**
 * 流式计算文件摘要（大文件不整读进内存）。
 */
export async function sha256File(filePath) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filePath))
        hash.update(chunk);
    return hash.digest('hex');
}
/** 同目录唯一临时名：与目标同库同卷，保证 rename 是原子替换。 */
function tempSibling(filePath) {
    return join(dirname(filePath), `.${process.pid}-${randomBytes(6).toString('hex')}.tmp`);
}
async function ensureParent(filePath, io = DEFAULT_IO) {
    await io.mkdir(dirname(filePath), { recursive: true });
}
/**
 * 原子写 JSON：同目录临时文件 → `fs.rename` 替换。父目录自动创建。
 *
 * 输出固定为 2 空格缩进 + 结尾换行，便于 diff 与人工核对。
 *
 * `rename` 命中瞬时 `EPERM`/`EACCES`/`EBUSY` 时按短退避**有界**重试（默认 3 次）；
 * 其它错误不重试，耗尽后抛原始错误。
 *
 * @param filePath 目标绝对路径
 * @param value 可 JSON 序列化的值
 */
export async function writeJsonAtomic(filePath, value, options = {}) {
    const { ensureParent: createParent = true } = options;
    const io = ioOf(options);
    const text = `${JSON.stringify(value, null, 2)}\n`;
    const bytes = Buffer.from(text, 'utf8');
    if (createParent)
        await ensureParent(filePath, io);
    const temp = tempSibling(filePath);
    try {
        await replaceWithRetry(async () => {
            await io.writeFile(temp, bytes);
            await io.rename(temp, filePath);
        }, options);
    }
    catch (error) {
        await io.rm(temp, { force: true }).catch(() => { });
        throw error;
    }
    return { path: filePath, sha256: sha256Bytes(bytes), bytes: bytes.length };
}
/**
 * 独占创建不可变文件（`wx`）。
 *
 * 已存在且内容完全一致 → 幂等成功（`created=false`）；内容不同 → `OPERATION_CONFLICT`，
 * 且**不覆盖**原文件。
 *
 * `writeFile(..., {flag:'wx'})`（即 `O_EXCL`）命中瞬时 `EPERM`/`EACCES`/`EBUSY` 时有界重试；
 * `EEXIST` **绝不**重试（它是幂等/冲突信号，不是抖动）。
 *
 * @param filePath 目标绝对路径
 */
export async function createExclusive(filePath, contents, options = {}) {
    const io = ioOf(options);
    await ensureParent(filePath, io);
    const bytes = typeof contents === 'string' ? Buffer.from(contents, 'utf8') : contents;
    try {
        await replaceWithRetry(() => io.writeFile(filePath, bytes, { flag: 'wx' }), options);
        return { created: true, existed: false, sameContent: true };
    }
    catch (error) {
        if (thrownCode(error) !== 'EEXIST')
            throw error;
    }
    const existing = await io.readFile(filePath);
    if (existing.equals(bytes)) {
        return { created: false, existed: true, sameContent: true };
    }
    throw conflict(`不可变文件已存在且内容不一致: ${filePath}`, '保留既有文件；若确实需要新内容，换一个新的 RUN/operation 标识而不是覆盖证据', { path: filePath, existing_sha256: sha256Bytes(existing), incoming_sha256: sha256Bytes(bytes) });
}
/**
 * 核对文件哈希；不符或缺文件时抛 `OPERATION_CONFLICT`。
 *
 * 这是「校验后换内容」的唯一检测点：复制完成、归档前后、读取提交前都应重新核对。
 *
 * @param expectedSha256 小写十六进制
 */
export async function verifyFileHash(filePath, expectedSha256) {
    let actual;
    try {
        actual = await sha256File(filePath);
    }
    catch (error) {
        throw conflict(`无法读取待核对文件: ${filePath}（${thrownCode(error) ?? 'unknown'}）`, '确认文件仍存在且可读；缺失即视为校验失败，不要继续后续步骤', { path: filePath, code: thrownCode(error) });
    }
    if (actual !== expectedSha256) {
        throw conflict(`文件哈希与预期不一致: ${filePath}`, '重新读取原始来源确认内容；不要用当前文件继续封存或登记', { path: filePath, expected_sha256: expectedSha256, actual_sha256: actual });
    }
    const info = await stat(filePath);
    return { sha256: actual, bytes: info.size };
}
/**
 * 复制并核对哈希：源哈希 → 同目录临时副本 → 校验副本字节 → 原子替换到目标 → 再核对目标。
 *
 * 任一步不符即冲突，且**目标位置不会出现错误字节**（临时文件已清理）。
 */
export async function copyVerify(sourcePath, destPath, options = {}) {
    const { expectedSha256, ensureParent: createParent = true } = options;
    let sourceHash;
    let sourceSize;
    try {
        sourceHash = await sha256File(sourcePath);
        sourceSize = (await stat(sourcePath)).size;
    }
    catch (error) {
        throw conflict(`无法读取源文件: ${sourcePath}（${thrownCode(error) ?? 'unknown'}）`, '确认源文件存在且可读后重试', { path: sourcePath, code: thrownCode(error) });
    }
    if (expectedSha256 !== undefined && sourceHash !== expectedSha256) {
        throw conflict(`源文件哈希与预期不一致: ${sourcePath}`, '源内容已改变：回到原始提交/证据重新取值，不要沿用旧摘要继续', { path: sourcePath, expected_sha256: expectedSha256, actual_sha256: sourceHash });
    }
    if (createParent)
        await ensureParent(destPath);
    const temp = tempSibling(destPath);
    try {
        await copyFile(sourcePath, temp);
        const copiedHash = await sha256File(temp);
        if (copiedHash !== sourceHash) {
            throw conflict(`复制后的字节与源不一致: ${sourcePath}`, '同一份证据在复制过程中发生变化：重做复制，不要登记本次结果', { path: sourcePath, source_sha256: sourceHash, copied_sha256: copiedHash });
        }
        await rename(temp, destPath);
        const finalHash = await sha256File(destPath);
        if (finalHash !== sourceHash) {
            throw conflict(`写入后的目标字节与源不一致: ${destPath}`, '目标在替换后被改动：重新复制并核对', { path: destPath, source_sha256: sourceHash, final_sha256: finalHash });
        }
    }
    catch (error) {
        await rm(temp, { force: true }).catch(() => { });
        throw error;
    }
    return { sha256: sourceHash, bytes: sourceSize };
}
