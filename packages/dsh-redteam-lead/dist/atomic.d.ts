/**
 * 原子写、独占创建、追加一行与字节哈希。
 *
 * 契约要求（「路径、锁与资源」「操作阶段与部分失败」）：
 * - JSON/提交/回执使用**同目录临时文件 + 原子替换**；
 * - 不可变文件使用**独占创建**，已有内容不一致则视为冲突；
 * - **追加**（审计 JSONL）用 `appendLine()`：只追加、不重写，见 CONVENTIONS「原子写与追加」；
 * - 读取提交与复制时重新核对哈希，防止「校验后换内容」；
 * - 不回滚、不删除已保留的证据，冲突只前向修复。
 *
 * 冲突统一用 `OPERATION_CONFLICT`：契约的错误码表里没有更细的文件级码，
 * 而「同一身份下内容不一致」正是该码的语义（编排契约「稳定错误码」）。
 *
 * 本模块是 I/O 边界：只做字节搬运与校验，不做业务判断。
 */
/** 本模块用到的那一小撮 `fs/promises` 函数（测试可用替身替换，见 `options.io`）。 */
export type AtomicIo = Pick<typeof import('node:fs/promises'), 'appendFile' | 'mkdir' | 'readFile' | 'rename' | 'rm' | 'writeFile'>;
/** 可注入的 I/O 覆写（只给需要替换的函数即可）。 */
export interface AtomicIoOptions {
    io?: Partial<AtomicIo> | null;
}
/** 「替换 / 独占创建」的有界重试参数。 */
export interface AtomicRetryOptions {
    attempts?: number;
    delayMs?: number;
    sleep?: (ms: number) => Promise<void>;
    codes?: readonly string[];
}
/** `writeJsonAtomic()` / `writeTextAtomic()` 的入参。 */
export interface WriteJsonOptions extends AtomicRetryOptions, AtomicIoOptions {
    ensureParent?: boolean;
}
/** `appendLine()` 的入参。 */
export interface AppendLineOptions extends AtomicIoOptions {
    ensureParent?: boolean;
}
/** `writeJsonAtomic()` / `writeTextAtomic()` 的返回。 */
export interface AtomicWriteResult {
    path: string;
    sha256: string;
    bytes: number;
}
/** `appendLine()` 的返回（追加没有摘要：既有字节不属于本次写入）。 */
export interface AppendLineResult {
    path: string;
    bytes: number;
}
/** `createExclusive()` 的入参。 */
export interface CreateExclusiveOptions extends AtomicRetryOptions, AtomicIoOptions {
}
/** `createExclusive()` 的返回。 */
export interface CreateExclusiveResult {
    created: boolean;
    existed: boolean;
    sameContent: boolean;
}
/** `copyVerify()` 的入参。 */
export interface CopyVerifyOptions {
    /** 调用方先前记录（例如提交哈希）的摘要，用于发现「校验后换内容」。 */
    expectedSha256?: string;
    ensureParent?: boolean;
}
/** `verifyFileHash()` / `copyVerify()` 的返回。 */
export interface HashBytesResult {
    sha256: string;
    bytes: number;
}
/**
 * 只对这三个码做重试：Windows 上并发写同一目录 / 杀软与索引器持有句柄会让
 * `fs.rename` 与 `open(..., 'wx')` 偶发 `EPERM`、`EACCES`、`EBUSY`。
 *
 * 这是**真实**的健壮性缺陷（T5/T6/T7 都观察到门禁约 1/6 次飘红），不是测试噪音；
 * 但重试面必须窄：`EEXIST`（幂等/冲突信号）、`ENOENT`（目标真的不存在）与哈希不一致
 * 都是**有意义的失败**，重试只会把确定性错误变成随机行为。
 */
export declare const TRANSIENT_REPLACE_CODES: readonly string[];
/** 有界重试：最多尝试 3 次（含第一次）。 */
export declare const DEFAULT_REPLACE_ATTEMPTS = 3;
/**
 * 计算字节摘要。
 * @returns 小写十六进制 SHA256
 */
export declare function sha256Bytes(bytes: Uint8Array): string;
/**
 * 流式计算文件摘要（大文件不整读进内存）。
 */
export declare function sha256File(filePath: string): Promise<string>;
/**
 * 原子写 JSON：同目录临时文件 → `fs.rename` 替换。父目录自动创建。
 *
 * 输出固定为 2 空格缩进 + 结尾换行，便于 diff 与人工核对。
 *
 * @param filePath 目标绝对路径
 * @param value 可 JSON 序列化的值
 */
export declare function writeJsonAtomic(filePath: string, value: unknown, options?: WriteJsonOptions): Promise<AtomicWriteResult>;
/**
 * 原子写**纯文本**（Markdown、日志片段等）：与 `writeJsonAtomic` 同一条临时文件 +
 * 原子替换路径，只是不做 JSON 序列化、也不追加结尾换行——调用方给的字节是什么就写什么。
 *
 * 存在的理由：`CONVENTIONS` 要求所有跨进程/磁盘写入都走本模块。INDEX.md 这类文本文件
 * 以前在业务模块里手搓 `writeFile(temp)` + `rename`，既绕过了统一的重试策略，也把
 * 「清临时文件」写成可选调用而静默失效。
 *
 * @param filePath 目标绝对路径
 * @param text 要写入的完整文本（UTF-8）
 */
export declare function writeTextAtomic(filePath: string, text: string, options?: WriteJsonOptions): Promise<AtomicWriteResult>;
/**
 * 追加一行文本（append-only）。
 *
 * **为什么这里用 `appendFile` 而不是「临时文件 + 原子替换」**：追加与替换是两种不同的写入
 * 语义。审计日志 `re/team/audit.jsonl` 只追加、不重写、不回滚（契约「操作阶段与部分失败」），
 * 而「读全文 → 改 → 原子替换」会把并发的两次追加变成「后写覆盖先写」，直接破坏 append-only。
 * `fs.appendFile` 用 `O_APPEND`，一次 `write(2)` 只落在文件末尾。
 *
 * 这是本模块里**唯一**的追加入口：业务模块不要自己 import `appendFile`（见 CONVENTIONS
 * 「原子写与追加」里记录的例外）。
 *
 * @param filePath 目标绝对路径
 * @param line 一行文本；缺结尾换行时自动补一个（保证 JSONL 每行一条）
 */
export declare function appendLine(filePath: string, line: string, options?: AppendLineOptions): Promise<AppendLineResult>;
/**
 * 尝试独占创建（`O_EXCL`）：**已存在即 `false`，不读取、不比较、不覆盖**。
 *
 * 这是 `createExclusive()` 与项目锁共用的原语。两者对「已存在」的语义不同：
 * - `createExclusive()`：已存在且内容一致 = 幂等成功，不一致 = `OPERATION_CONFLICT`；
 * - 项目锁：已存在**永远**是冲突信号（`PROJECT_BUSY`），不需要为了比较内容多读一次
 *   那个可能正被别的进程改写的锁文件。
 *
 * `writeFile(..., {flag:'wx'})` 命中瞬时 `EPERM`/`EACCES`/`EBUSY` 时有界重试；
 * `EEXIST` **绝不**重试（它是幂等/冲突信号，不是抖动）。
 *
 * @param filePath 目标绝对路径；父目录自动创建
 * @returns 是否由本次调用创建（`false` = 之前已存在）
 */
export declare function tryCreateExclusive(filePath: string, contents: string | Uint8Array, options?: CreateExclusiveOptions): Promise<boolean>;
/**
 * 独占创建不可变文件（`wx`）。
 *
 * 已存在且内容完全一致 → 幂等成功（`created=false`）；内容不同 → `OPERATION_CONFLICT`，
 * 且**不覆盖**原文件。
 *
 * 底层是 `tryCreateExclusive()`：只有「已存在」才需要读回来比较内容。
 *
 * @param filePath 目标绝对路径
 */
export declare function createExclusive(filePath: string, contents: string | Uint8Array, options?: CreateExclusiveOptions): Promise<CreateExclusiveResult>;
/**
 * 核对文件哈希；不符或缺文件时抛 `OPERATION_CONFLICT`。
 *
 * 这是「校验后换内容」的唯一检测点：复制完成、归档前后、读取提交前都应重新核对。
 *
 * @param expectedSha256 小写十六进制
 */
export declare function verifyFileHash(filePath: string, expectedSha256: string): Promise<HashBytesResult>;
/**
 * 复制并核对哈希：源哈希 → 同目录临时副本 → 校验副本字节 → 原子替换到目标 → 再核对目标。
 *
 * 任一步不符即冲突，且**目标位置不会出现错误字节**（临时文件已清理）。
 */
export declare function copyVerify(sourcePath: string, destPath: string, options?: CopyVerifyOptions): Promise<HashBytesResult>;
