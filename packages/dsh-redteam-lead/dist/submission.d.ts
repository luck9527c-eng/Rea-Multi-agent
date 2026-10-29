/**
 * `submission.json` 校验：形状、身份、路径与「读取后再核对」。
 *
 * 契约（编排契约「交付、开始和结果分类」「路径、锁与资源」）：
 * - 提交统一为 `submission.json`，必填：`schema_version`、dispatch/attempt/task、
 *   `contract_sha256`、`outcome`、`summary`、`run_ids`、`artifacts[{path,sha256}]`、
 *   `anchor_refs`、`blocker`、`state_recovery_ref`、`submitted_at`。
 * - `submission_ref` 必须位于**当前 attempt** 的工作目录（`re/team/work/<dispatch>/<attempt>/`）；
 *   越界/绝对路径是 `PATH_INVALID`，内容/哈希/身份不符是 `SUBMISSION_INVALID`。
 * - 重算 `submission_sha256` 与传入值比对，**读取后再核对一次**（防止校验后换内容）。
 *
 * 本模块是 I/O 边界之一（由调用方注入 `fs`/`atomic`/`paths`），但判定部分（`validateSubmission`）
 * 是纯函数，可单独测试。
 */
import type { Diagnostic, FsLike } from './types.js';
/** 提交记录版本。 */
export declare const SUBMISSION_SCHEMA_VERSION = 1;
/** 提交文件固定名。 */
export declare const SUBMISSION_FILE = "submission.json";
/** attempt 工作区的根（`re/team/work/<dispatch>/<attempt>/`）。 */
export declare const WORK_DIR = "re/team/work";
/** 七类 outcome（`$defs.outcome`）。 */
export declare const OUTCOMES: readonly string[];
/** 交付分类里需要「已完成运行」的几类（岗位成功锚点要求适用）。 */
export declare const RUN_BEARING_OUTCOMES: readonly string[];
/** `submission.json` 的必填字段（契约逐字）。 */
export declare const SUBMISSION_FIELDS: readonly string[];
/**
 * attempt 工作区相对路径。
 * @param {string} dispatchId
 * @param {string} attemptId
 * @returns {string}
 */
export declare function attemptDir(dispatchId: string, attemptId: string): string;
/**
 * 相对路径是否位于该 attempt 的工作目录内（不含目录本身）。
 * @param {string} relativePath
 * @param {string} dispatchId
 * @param {string} attemptId
 * @returns {boolean}
 */
export declare function isInsideAttempt(relativePath: string, dispatchId: string, attemptId: string): boolean;
/** `validateSubmission` 的结果：通过时给出原对象，否则给出逐条诊断。 */
type SubmissionVerdict = {
    ok: true;
    submission: Record<string, unknown>;
} | {
    ok: false;
    code: 'SUBMISSION_INVALID';
    issues: Diagnostic[];
};
/**
 * 纯校验：形状、字段、枚举与内部一致性（不读盘，不做跨文件核对）。
 *
 * @param {unknown} value
 * @returns {{ ok: true, submission: object } | { ok: false, code: 'SUBMISSION_INVALID',
 *   issues: Array<{code:string, reason:string, next_step:string}> }}
 */
export declare function validateSubmission(value: unknown): SubmissionVerdict;
/** `readVerifiedSubmission` 的入参：调用方注入 `paths`/`fs`/`atomic`（本模块不直接 I/O）。 */
interface ReadVerifiedSubmissionInput {
    /** 已规范化的项目根。 */
    root: string;
    /** 项目内相对路径（未校验，本函数先验形状与归属）。 */
    submissionRef: unknown;
    /** 调用方传入的 `submission_sha256`。 */
    expectedSha256: unknown;
    dispatchId: unknown;
    attemptId: unknown;
    /** `src/paths.mjs`（或等价实现）。 */
    paths: typeof import('./paths.js');
    /** `fs/promises` 形状（需 `readFile`）。 */
    fs: FsLike;
    /** `src/atomic.mjs`。 */
    atomic: typeof import('./atomic.js');
}
/** `readVerifiedSubmission` 的结果。 */
type VerifiedSubmission = {
    ok: true;
    submission: Record<string, unknown>;
    bytes: Buffer;
    sha256: string;
    relative_path: string;
} | {
    ok: false;
    code: 'PATH_INVALID' | 'SUBMISSION_INVALID';
    issues: Diagnostic[];
};
/**
 * 读取并核对提交：路径归属 → 字节哈希 → 形状 → **再读一次**核对字节未变。
 *
 * @param {object} input
 * @param {string} input.root 已规范化的项目根
 * @param {string} input.submissionRef 项目内相对路径
 * @param {string} input.expectedSha256 调用方传入的 submission_sha256
 * @param {string} input.dispatchId
 * @param {string} input.attemptId
 * @param {object} input.paths `src/paths.mjs`（或等价实现）
 * @param {object} input.fs `fs/promises` 形状（需 readFile）
 * @param {object} input.atomic `src/atomic.mjs`
 * @returns {Promise<{ ok: true, submission: object, bytes: Buffer, sha256: string, relative_path: string }
 *   | { ok: false, code: 'PATH_INVALID' | 'SUBMISSION_INVALID', issues: Array<object> }>}
 */
export declare function readVerifiedSubmission(input: ReadVerifiedSubmissionInput): Promise<VerifiedSubmission>;
export {};
