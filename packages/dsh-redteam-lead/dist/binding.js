/**
 * 项目/会话绑定与名册的持久化（`re/team/binding.json`、`re/team/roster.json`）以及 epoch 归档。
 *
 * 这一层只做「事实落到哪里、字节是什么」，不做编排决策：
 * - 项目身份（`project_id`）与会话身份（`session_id`/`team_id`）的推导；
 * - binding/roster 的原子写；
 * - INDEX 手写区指针（**只在缺指针时追加**，不重写其他内容，也不自行创建 INDEX）；
 * - takeover 的 epoch 归档（复制旧 binding/roster/resources 到 `re/team/history/epoch-N/`，**不删原件**）；
 * - `recovery_ref` 的内容核查（不要用布尔值替代真实核查记录）。
 *
 * 写入全部走 `atomic.writeJsonAtomic`（同目录临时文件 + 原子替换）；路径先过 `paths` 校验。
 * `deps` 里的 `atomic/paths/fs/clock` 优先于本模块的直接 import，便于测试注入。
 */
import * as fsp from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import * as atomicModule from './atomic.js';
import * as pathsModule from './paths.js';
import { ContractError } from './errors.js';
import { isRecord, thrownCode, thrownMessage } from './guards.js';
/** 项目内固定路径（统一 `/`）。 */
export const BINDING_PATH = 're/team/binding.json';
export const ROSTER_PATH = 're/team/roster.json';
export const RESOURCES_PATH = 're/team/resources.json';
export const HISTORY_DIR = 're/team/history';
export const INDEX_PATH = 'INDEX.md';
/** binding/roster 的 schema 版本（契约版本 1）。 */
export const BINDING_SCHEMA_VERSION = 1;
/** INDEX 手写区里标记本插件条目的标题（已存在时不重复加）。 */
export const INDEX_HEADING = '## 编排记录（redteam-lead）';
/** 恢复核查记录的最小长度：太短的文本不可能覆盖「停止/处置/剩余风险」。 */
const RECOVERY_MIN_CHARS = 20;
/**
 * 恢复核查记录必须覆盖的三类事实。关键词只做**完整性检查**，不替代人的判断：
 * 记录本身仍然要由 Lead 真实核查后写入（契约「自检、会话接管与 Lead 循环」）。
 */
const RECOVERY_SIGNALS = Object.freeze([
    {
        code: 'RECOVERY_STOP_UNVERIFIED',
        label: '旧 Lead/执行者已停止或隔离',
        pattern: /停止|终止|结束|退出|隔离|下线|stopped|terminated|isolated|offline|killed/iu,
    },
    {
        code: 'RECOVERY_DISPOSITION_MISSING',
        label: '遗留进程/资源处置',
        pattern: /进程|端口|后台|资源|句柄|会话|process|port|resource|handle|session/iu,
    },
    {
        code: 'RECOVERY_RISK_MISSING',
        label: '剩余风险与限制',
        pattern: /风险|残留|限制|risk|residual|limitation/iu,
    },
]);
function deps0(deps) {
    const value = deps ?? {};
    return {
        atomic: value.atomic ?? atomicModule,
        paths: value.paths ?? pathsModule,
        fs: value.fs ?? fsp,
        clock: value.clock ?? { now: () => Date.now(), isoNow: () => new Date().toISOString() },
    };
}
function isoNow(deps) {
    const clock = deps0(deps).clock;
    if (clock && typeof clock.isoNow === 'function')
        return clock.isoNow();
    if (clock && typeof clock.now === 'function')
        return new Date(clock.now()).toISOString();
    return new Date().toISOString();
}
function sha256Bytes(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}
function nonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}
/** 项目身份哈希只关心「同一个目录」，所以折叠分隔符与大小写（Windows 语义）。 */
function identityKeyOf(root) {
    return String(root).replaceAll('\\', '/').replace(/\/+$/u, '').toLowerCase();
}
/** JSON 对象的判别谓词（等价于 `parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)` 的取反）。 */
function isPlainJsonObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/**
 * 推导项目身份。
 *
 * 优先采用项目记录里显式声明的标识（`project_id` / `id` / `project_name` / `name`）；
 * 没有显式标识时用规范根的内容哈希推导一个稳定值，保证同一目录跨会话一致、不同目录不同。
 * 规格没有定义 `project_id` 的来源，这里是本包的约定（见 T5 报告）。
 *
 * @param {{ root: string, projectRecord?: object | null }} input
 * @returns {string}
 */
export function projectIdFor(input = {}) {
    const record = input.projectRecord;
    if (isRecord(record) && !Array.isArray(record)) {
        for (const key of ['project_id', 'projectId', 'id', 'project_name', 'name']) {
            const value = record[key];
            if (nonEmptyString(value))
                return value.trim();
        }
    }
    const root = input.root;
    if (!nonEmptyString(root)) {
        throw new ContractError({
            code: 'PATH_INVALID',
            message: '推导 project_id 需要项目根',
            nextStep: '先调用 normalizeProjectRoot 得到规范根，再推导项目身份',
        });
    }
    return `proj-${sha256Bytes(Buffer.from(identityKeyOf(root), 'utf8')).slice(0, 12)}`;
}
export function sessionIdentityFrom(input = {}) {
    const identity = isRecord(input.identity) ? input.identity : {};
    const exec = isRecord(input.exec) ? input.exec : {};
    const config = isRecord(input.config) ? input.config : {};
    const teamId = nonEmptyString(identity.root) ? identity.root : null;
    const candidates = [
        exec.sessionId,
        exec.session_id,
        isRecord(exec.session) ? exec.session.id : undefined,
        isRecord(exec.agent) ? exec.agent.sessionId : undefined,
        config.sessionId,
    ];
    const explicit = candidates.find((value) => nonEmptyString(value));
    const sessionId = explicit !== undefined ? String(explicit) : teamId;
    return {
        session_id: sessionId ?? null,
        team_id: teamId ?? null,
        source: explicit !== undefined ? 'exec' : (teamId === null ? 'unavailable' : 'team-root'),
    };
}
export function checkSessionMatch(bindingValue, current = {}) {
    if (!bindingValue || typeof bindingValue !== 'object')
        return { ok: true, reason: null };
    const record = isRecord(bindingValue) ? bindingValue : {};
    const pairs = [
        ['team_id', record.team_id, current.teamId],
        ['session_id', record.session_id, current.sessionId],
    ];
    for (const [field, stored, live] of pairs) {
        if (!nonEmptyString(stored) || !nonEmptyString(live))
            continue;
        if (stored !== live) {
            return {
                ok: false,
                reason: `已存 binding 的 ${field}=${stored} 与当前调用 ${live} 不一致（旧会话/旧 epoch 的绑定不能直接继续）`,
            };
        }
    }
    return { ok: true, reason: null };
}
export async function readJsonIfPresent(root, relative, deps) {
    const { fs, paths } = deps0(deps);
    let target;
    try {
        target = paths.resolveInProject(root, relative);
    }
    catch (error) {
        return { present: false, value: null, sha256: null, reason: `${relative}: ${thrownMessage(error)}` };
    }
    let bytes;
    try {
        bytes = await fs.readFile(target);
    }
    catch (error) {
        const missing = thrownCode(error) === 'ENOENT';
        return {
            present: false,
            value: null,
            sha256: null,
            reason: missing
                ? `${relative} 不存在（尚未创建）`
                : `${relative} 读不了：${error instanceof Error ? error.message : String(error)}`,
        };
    }
    const digest = sha256Bytes(bytes);
    const text = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes);
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (error) {
        return {
            present: false,
            value: null,
            sha256: digest,
            reason: `${relative} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
        };
    }
    if (!isPlainJsonObject(parsed)) {
        return { present: false, value: null, sha256: digest, reason: `${relative} 不是 JSON 对象` };
    }
    return { present: true, value: parsed, sha256: digest };
}
async function writeProjectJson(root, relative, value, deps) {
    const { atomic, paths } = deps0(deps);
    const target = await paths.assertSafeWriteTarget(root, relative);
    return atomic.writeJsonAtomic(target, value);
}
/**
 * 原子写 `re/team/binding.json`。
 * @returns {Promise<{path: string, sha256: string, bytes: number}>}
 */
export async function writeBinding(root, value, deps) {
    return writeProjectJson(root, BINDING_PATH, value, deps);
}
/**
 * 原子写 `re/team/roster.json`。
 * @returns {Promise<{path: string, sha256: string, bytes: number}>}
 */
export async function writeRoster(root, value, deps) {
    return writeProjectJson(root, ROSTER_PATH, value, deps);
}
/** 读 INDEX.md；不存在返回 null（不创建）。 */
async function readIndex(root, deps) {
    const { fs, paths } = deps0(deps);
    const target = paths.resolveInProject(root, INDEX_PATH);
    try {
        const bytes = await fs.readFile(target);
        return { present: true, text: Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes) };
    }
    catch (error) {
        if (thrownCode(error) === 'ENOENT')
            return { present: false, text: null };
        throw new ContractError({
            code: 'PATH_INVALID',
            message: `读不了 INDEX.md：${error instanceof Error ? error.message : String(error)}`,
            nextStep: '确认项目根可读；INDEX.md 是项目 skill 的记录，不要用全局副本重建它',
        });
    }
}
export async function linkIndexPointers(root, entries, deps) {
    const { fs, paths } = deps0(deps);
    const wanted = [...new Set((Array.isArray(entries) ? entries : []).filter(nonEmptyString))];
    for (const entry of wanted)
        paths.assertProjectRelative(entry);
    const index = await readIndex(root, deps);
    if (!index.present) {
        return {
            written: false,
            unchanged: false,
            added: [],
            path: INDEX_PATH,
            reason: 'INDEX.md 不存在：先用项目 skill 建立 INDEX，再绑定团队（不由插件重 init）',
        };
    }
    const added = wanted.filter((entry) => !index.text.includes(entry));
    if (added.length === 0) {
        return { written: false, unchanged: true, added: [], path: INDEX_PATH };
    }
    const base = index.text.endsWith('\n') ? index.text : `${index.text}\n`;
    const bullets = added.map((entry) => `- [${path.basename(entry, '.json')}](${entry})`).join('\n');
    const heading = index.text.includes(INDEX_HEADING) ? '' : `\n${INDEX_HEADING}\n`;
    const next = `${base}${heading}\n${bullets}\n`;
    // 原子替换：同目录临时文件 + rename（atomic 模块只提供 JSON 写入，INDEX 是 Markdown）。
    const target = await paths.assertSafeWriteTarget(root, INDEX_PATH);
    const temp = path.join(path.dirname(target), `.${process.pid}-${Date.now().toString(16)}.index.tmp`);
    try {
        await fs.writeFile(temp, Buffer.from(next, 'utf8'));
        await fs.rename(temp, target);
    }
    catch (error) {
        await fs.rm?.(temp, { force: true });
        throw new ContractError({
            code: 'PATH_INVALID',
            message: `追加 INDEX 指针失败：${error instanceof Error ? error.message : String(error)}`,
            nextStep: '确认 INDEX.md 可写且未被别的进程占用；binding/roster 已写好，可重试链接',
        });
    }
    const check = await fs.readFile(target);
    const text = Buffer.isBuffer(check) ? check.toString('utf8') : String(check);
    if (!text.startsWith(index.text)) {
        throw new ContractError({
            code: 'RECOVERY_REQUIRED',
            message: 'INDEX.md 追加后既有内容不完整（前缀不一致）',
            nextStep: '用版本控制核对 INDEX.md，恢复手写区原文后重新链接；不要接受被重写过的 INDEX',
        });
    }
    return { written: true, unchanged: false, added, path: INDEX_PATH, bytes: Buffer.byteLength(next, 'utf8') };
}
/** `re/team/history/epoch-<n>` 的项目内相对路径。 */
export function historyEpochDir(epoch) {
    return `${HISTORY_DIR}/epoch-${epoch}`;
}
/**
 * 归档当前 epoch 的编排记录：把 binding/roster/resources 复制到
 * `re/team/history/epoch-<n>/`（逐字节核对哈希），**不删除**原文件。
 *
 * @param {string} root 已规范化的绝对根
 * @param {{ epoch: number, recoveryRef: string, reason?: string }} input
 * @param {object} [deps]
 * @returns {Promise<{epoch: number, history_dir: string, manifest_path: string,
 *   files: Array<{path: string, archived_path: string, sha256: string, bytes: number}>}>}
 */
export async function archiveEpoch(root, input = {}, deps) {
    const { atomic, paths } = deps0(deps);
    const epoch = input.epoch;
    // `Number.isSafeInteger()` 对非数字恒为 false，故这里补的类型判断不改变放行/拒绝的边界。
    if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 1) {
        throw new ContractError({
            code: 'INVALID_ARGUMENT',
            message: `归档 epoch 必须是正整数：${JSON.stringify(epoch)}`,
            nextStep: '用已存 binding 的 epoch 归档；没有 binding 时不需要归档',
        });
    }
    const dir = historyEpochDir(epoch);
    const files = [];
    for (const relative of [BINDING_PATH, ROSTER_PATH, RESOURCES_PATH]) {
        let exists = true;
        try {
            await deps0(deps).fs.stat(paths.resolveInProject(root, relative));
        }
        catch {
            exists = false;
        }
        if (!exists)
            continue;
        const source = paths.resolveInProject(root, relative);
        const archivedPath = `${dir}/${path.posix.basename(relative)}`;
        const target = await paths.assertSafeWriteTarget(root, archivedPath);
        const copied = await atomic.copyVerify(source, target);
        files.push({ path: relative, archived_path: archivedPath, sha256: copied.sha256, bytes: copied.bytes });
    }
    const manifestPath = `${dir}/archive.json`;
    const manifest = {
        schema_version: 1,
        epoch,
        reason: nonEmptyString(input.reason) ? input.reason : 'takeover',
        recovery_ref: nonEmptyString(input.recoveryRef) ? input.recoveryRef : null,
        archived_at: isoNow(deps),
        files,
    };
    const manifestTarget = await paths.assertSafeWriteTarget(root, manifestPath);
    await atomic.writeJsonAtomic(manifestTarget, manifest);
    return { epoch, history_dir: dir, manifest_path: manifestPath, files, archived_at: manifest.archived_at };
}
/**
 * 检查一份恢复核查记录的内容是否覆盖「停止/隔离」「遗留处置」「剩余风险」。
 *
 * 这是**完整性下限**，不是可信度证明：记录仍须由 Lead 真实核查后写入。
 * 空文本、`true`、单个布尔字段都无法通过（T5：不靠一个布尔值替代核查）。
 *
 * @param {unknown} text
 * @returns {{ ok: boolean, missing: Array<{code: string, detail: string}> }}
 */
export function checkRecoveryRecord(text) {
    if (typeof text !== 'string' || text.trim().length === 0) {
        return {
            ok: false,
            missing: [
                { code: 'RECOVERY_RECORD_MISSING', detail: 'recovery_ref 指向的文件没有可读的核查正文' },
                ...RECOVERY_SIGNALS.map((signal) => ({
                    code: signal.code,
                    detail: `核查记录必须写明：${signal.label}`,
                })),
            ],
        };
    }
    const missing = [];
    if (text.trim().length < RECOVERY_MIN_CHARS) {
        missing.push({
            code: 'RECOVERY_RECORD_TOO_SHORT',
            detail: `核查记录只有 ${text.trim().length} 个字符，写不出停止/处置/风险三项事实（至少 ${RECOVERY_MIN_CHARS}）`,
        });
    }
    for (const signal of RECOVERY_SIGNALS) {
        if (!signal.pattern.test(text)) {
            missing.push({ code: signal.code, detail: `核查记录缺少：${signal.label}` });
        }
    }
    return { ok: missing.length === 0, missing };
}
/**
 * 读并核查 `recovery_ref` 指向的项目内文件。
 *
 * 返回判别联合，不抛：
 * - `{ok:true, recovery_ref, sha256, bytes}`
 * - `{ok:false, code:'INVALID_ARGUMENT', reason}`：路径非法或文件不存在
 * - `{ok:false, code:'RECOVERY_REQUIRED', reason, missing}`：文件在，但内容不满足核查要求
 *
 * @param {string} root 已规范化的绝对根
 * @param {unknown} recoveryRef
 * @param {object} [deps]
 */
export async function readRecoveryRef(root, recoveryRef, deps) {
    const { fs, paths } = deps0(deps);
    if (!nonEmptyString(recoveryRef)) {
        return {
            ok: false,
            code: 'INVALID_ARGUMENT',
            reason: 'takeover 必须提供 recovery_ref（旧 Lead/执行者停止或隔离的真实核查记录）',
        };
    }
    let target;
    try {
        target = paths.resolveInProject(root, recoveryRef);
    }
    catch (error) {
        return { ok: false, code: 'INVALID_ARGUMENT', reason: `${recoveryRef}: ${thrownMessage(error)}` };
    }
    let bytes;
    try {
        bytes = await fs.readFile(target);
    }
    catch (error) {
        const missing = thrownCode(error) === 'ENOENT';
        return {
            ok: false,
            code: 'INVALID_ARGUMENT',
            reason: missing
                ? `recovery_ref 指向的文件不存在：${recoveryRef}`
                : `recovery_ref 读不了：${recoveryRef}（${error instanceof Error ? error.message : String(error)}）`,
        };
    }
    const text = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes);
    const checked = checkRecoveryRecord(text);
    if (!checked.ok) {
        return {
            ok: false,
            code: 'RECOVERY_REQUIRED',
            reason: `${recoveryRef} 的内容不满足恢复核查要求：${checked.missing.map((item) => item.detail).join('；')}`,
            missing: checked.missing,
        };
    }
    return { ok: true, recovery_ref: recoveryRef, sha256: sha256Bytes(bytes), bytes: bytes.length };
}
