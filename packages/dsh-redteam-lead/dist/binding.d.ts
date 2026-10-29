import * as atomicModule from './atomic.js';
import * as pathsModule from './paths.js';
import type { Clock, FsLike } from './types.js';
/** 项目内固定路径（统一 `/`）。 */
export declare const BINDING_PATH = "re/team/binding.json";
export declare const ROSTER_PATH = "re/team/roster.json";
export declare const RESOURCES_PATH = "re/team/resources.json";
export declare const HISTORY_DIR = "re/team/history";
export declare const INDEX_PATH = "INDEX.md";
/** binding/roster 的 schema 版本（契约版本 1）。 */
export declare const BINDING_SCHEMA_VERSION = 1;
/** INDEX 手写区里标记本插件条目的标题（已存在时不重复加）。 */
export declare const INDEX_HEADING = "## \u7F16\u6392\u8BB0\u5F55\uFF08redteam-lead\uFF09";
/**
 * 本模块用到的 `deps.fs` 子集：`fs/promises` 的薄封装。
 *
 * 写盘一律走 `deps.atomic`（含临时文件清理），所以这里**不需要** `rm`：以前那版把它声明成
 * 可选并写成 `fs.rm?.()`，可选调用在替身 fs 上静默跳过，会留下临时文件。
 */
export type BindingFs = FsLike;
/**
 * 本模块接受的 `deps`（`ctx.deps` 的一个子集）。
 *
 * 全部可选：`index.ts` 先建骨架再挂模块，测试也常只注入一两个键；
 * 每个键在 `deps0` 里回落到本包真实实现。
 */
export interface BindingDeps {
    atomic?: typeof atomicModule;
    paths?: typeof pathsModule;
    fs?: BindingFs;
    clock?: Clock;
}
/** `projectIdFor()` 的入参：两个字段都按未知读，运行期逐个收窄。 */
export interface ProjectIdInput {
    root?: unknown;
    projectRecord?: unknown;
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
export declare function projectIdFor(input?: ProjectIdInput): string;
/**
 * 会话身份：`team_id` 取宿主报告的团队根 ID（`TeamId` = root Session id），
 * `session_id` 优先取宿主显式会话字段，取不到时回落到同一个根 ID。
 *
 * 两者都只来自可信执行上下文（`identity` + `exec`），**不接受入参自报**。
 *
 * @param {{ identity?: object | null, exec?: object | null, config?: object | null }} input
 * @returns {{ session_id: string | null, team_id: string | null, source: string }}
 */
/** `sessionIdentityFrom()` 的入参：三个来源都按未知读（宿主形状不归本包解释）。 */
export interface SessionIdentityInput {
    identity?: unknown;
    exec?: unknown;
    config?: unknown;
}
/** 会话身份的三字段结果。 */
export interface SessionIdentity {
    session_id: string | null;
    team_id: string | null;
    source: string;
}
export declare function sessionIdentityFrom(input?: SessionIdentityInput): SessionIdentity;
/**
 * 旧绑定与当前调用是否同一会话/团队。
 *
 * 不一致时**不允许**继续任何变更（v0 不自动跨 Lead 会话迁移），必须显式 takeover。
 * 绑定里缺字段（null）视为「未知」，不据此判定不匹配。
 *
 * @param {object | null} bindingValue
 * @param {{ sessionId?: string | null, teamId?: string | null }} current
 * @returns {{ ok: boolean, reason: string | null }}
 */
/** `checkSessionMatch()` 的「当前调用」一侧（两个字段都可缺，缺即未知）。 */
export interface SessionMatchCurrent {
    sessionId?: unknown;
    teamId?: unknown;
}
/** 会话一致性结论。 */
export interface SessionMatchResult {
    ok: boolean;
    reason: string | null;
}
export declare function checkSessionMatch(bindingValue: unknown, current?: SessionMatchCurrent): SessionMatchResult;
/**
 * 读项目内 JSON 文件；缺失、坏 JSON、非对象都返回 `present:false`（不抛），
 * 便于上层把「没有」与「坏了」写进诊断。
 *
 * @param {string} root 已规范化的绝对根
 * @param {string} relative 项目内相对路径（`/` 分隔）
 * @param {object} [deps]
 * @returns {Promise<{present: boolean, value: object | null, sha256: string | null, reason?: string}>}
 */
/** `readJsonIfPresent()` 的结果：`present:false` 时 `reason` 说明「没有」还是「坏了」。 */
export interface JsonPresence {
    present: boolean;
    value: Record<string, unknown> | null;
    sha256: string | null;
    reason?: string;
}
export declare function readJsonIfPresent(root: unknown, relative: unknown, deps?: BindingDeps | null): Promise<JsonPresence>;
/** `writeJsonAtomic` 的产物（`atomic` 模块的契约）。 */
interface JsonWriteReceipt {
    path: string;
    sha256: string;
    bytes: number;
}
/**
 * 原子写 `re/team/binding.json`。
 * @returns {Promise<{path: string, sha256: string, bytes: number}>}
 */
export declare function writeBinding(root: unknown, value: unknown, deps?: BindingDeps | null): Promise<JsonWriteReceipt>;
/**
 * 原子写 `re/team/roster.json`。
 * @returns {Promise<{path: string, sha256: string, bytes: number}>}
 */
export declare function writeRoster(root: unknown, value: unknown, deps?: BindingDeps | null): Promise<JsonWriteReceipt>;
/**
 * 把 binding/roster 指针追加到 INDEX 的**手写区**（文件末尾的新块）。
 *
 * 规则（T5 验收）：
 * - 已有指针不重复追加；两条都在 → 完全不写盘（`unchanged:true`）。
 * - 既有字节原样保留在开头；写完再读回核对前缀，防止「追加」变成「重写」。
 * - INDEX 不存在时不自行创建（项目不兼容应由兼容性检查报告，不在这里重 init）。
 *
 * @param {string} root 已规范化的绝对根
 * @param {string[]} entries 需要出现的项目内相对路径
 * @param {object} [deps]
 * @returns {Promise<{written: boolean, unchanged: boolean, added: string[], path: string, reason?: string, bytes?: number}>}
 */
/** `linkIndexPointers()` 的结果（`written:false` 时用 `unchanged`/`reason` 区分「已齐」与「没写成」）。 */
export interface IndexLinkResult {
    written: boolean;
    unchanged: boolean;
    added: string[];
    path: string;
    reason?: string;
    bytes?: number;
}
export declare function linkIndexPointers(root: unknown, entries: unknown, deps?: BindingDeps | null): Promise<IndexLinkResult>;
/** `re/team/history/epoch-<n>` 的项目内相对路径。 */
export declare function historyEpochDir(epoch: number): string;
/** 归档的单个文件记录。 */
export interface ArchivedEpochFile {
    path: string;
    archived_path: string;
    sha256: string;
    bytes: number;
}
/** `archiveEpoch()` 的入参（三个字段都按未知读，逐个收窄）。 */
export interface ArchiveEpochInput {
    epoch?: unknown;
    recoveryRef?: unknown;
    reason?: unknown;
}
/** `archiveEpoch()` 的结果。 */
export interface ArchiveEpochResult {
    epoch: number;
    history_dir: string;
    manifest_path: string;
    files: ArchivedEpochFile[];
    archived_at: string;
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
export declare function archiveEpoch(root: unknown, input?: ArchiveEpochInput, deps?: BindingDeps | null): Promise<ArchiveEpochResult>;
/** 一条恢复核查缺口。 */
export interface RecoveryMissing {
    code: string;
    detail: string;
}
/** `checkRecoveryRecord()` 的结果。 */
export interface RecoveryRecordCheck {
    ok: boolean;
    missing: RecoveryMissing[];
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
export declare function checkRecoveryRecord(text: unknown): RecoveryRecordCheck;
/** `readRecoveryRef()` 的成功分支。 */
export interface RecoveryRefOk {
    ok: true;
    recovery_ref: string;
    sha256: string;
    bytes: number;
}
/** `readRecoveryRef()` 的失败分支（`missing` 只在内容不满足核查要求时出现）。 */
export interface RecoveryRefFailure {
    ok: false;
    code: string;
    reason: string;
    missing?: RecoveryMissing[];
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
export declare function readRecoveryRef(root: unknown, recoveryRef: unknown, deps?: BindingDeps | null): Promise<RecoveryRefOk | RecoveryRefFailure>;
export {};
