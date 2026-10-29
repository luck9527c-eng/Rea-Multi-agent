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
/** 本模块用到的那一小撮 `fs/promises` 函数（测试可用替身替换，见 `options.io`）。 */
export type AtomicIo = Pick<typeof import('node:fs/promises'), 'mkdir' | 'readFile' | 'rename' | 'rm' | 'writeFile'>;
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
/** `writeJsonAtomic()` 的入参。 */
export interface WriteJsonOptions extends AtomicRetryOptions, AtomicIoOptions {
    ensureParent?: boolean;
}
/** `writeJsonAtomic()` 的返回。 */
export interface AtomicWriteResult {
    path: string;
    sha256: string;
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
 * `rename` 命中瞬时 `EPERM`/`EACCES`/`EBUSY` 时按短退避**有界**重试（默认 3 次）；
 * 其它错误不重试，耗尽后抛原始错误。
 *
 * @param filePath 目标绝对路径
 * @param value 可 JSON 序列化的值
 */
export declare function writeJsonAtomic(filePath: string, value: unknown, options?: WriteJsonOptions): Promise<AtomicWriteResult>;
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
