/**
 * T6 派发契约：构建、持久化、任务板摘要与交付信封。
 *
 * 契约（编排契约「交付、开始和结果分类」「锚点与封存绑定」「操作阶段与部分失败」）：
 *
 * - **完整契约先落盘**：`re/team/dispatches/<dispatch-id>.json`，不可变、独占创建。
 *   文件字节的 SHA256 就是 `contract_sha256`（因此契约文件**不**内嵌自己的哈希）。
 *   重试（`retry_of`）新增 attempt 时写 `<dispatch-id>.<attempt-id>.json`，不改旧文件。
 * - **任务板只放摘要**：`subject` ≤200、`description` ≤16384（宿主按 trim 后 UTF-16 计）。
 * - **交付信封按引用**：消息里只有 dispatch/attempt/task/revision、契约路径 + SHA256、
 *   工作目录与项目规则入口；正文永不进消息。计量口径是宿主实际那一串
 *   `[{type:'text',text:'Team message from <name>:'}, ...content]` 的 UTF-8 字节（D9），
 *   上限 65536，实现按字节算并留余量（超长契约通过引用交付，不截断）。
 * - **本 attempt 的工作目录**：`re/team/work/<dispatch-id>/<attempt-id>`；任何越界、
 *   绝对路径、`..`、反斜杠、ADS、junction 逃逸都是 `PATH_INVALID`。
 * - **baseline_ref 必须有真实目标字节哈希**：首次目标尚无 seal 时 `preexisting_seals=[]`，
 *   但不能拿空清单代替目标身份。
 *
 * 本模块是纯构建 + 少量明确的 I/O 边界（`persistContract` / `ensureWorkDir` /
 * `captureBaseline` / attempt 记录），I/O 一律走 `atomic` / `paths`。
 */
import * as defaultPaths from './paths.js';
import type { Diagnostic } from './types.js';
/** 不可变契约目录。 */
export declare const DISPATCHES_DIR = "re/team/dispatches";
/** attempt 本地记录目录（dispatch/attempt → task/member 的恢复关联）。 */
export declare const ATTEMPTS_DIR = "re/team/attempts";
/** 成员工作区根。 */
export declare const WORK_DIR_BASE = "re/team/work";
/** 宿主任务板字段上限（编排契约「派发契约字段」）。 */
export declare const MAX_SUBJECT_CHARS = 200;
export declare const MAX_DESCRIPTION_CHARS = 16384;
/** `send_message` 单条上限与余量（D9：计量含 `Team message from <name>:` 前缀，比较是 `>`）。 */
export declare const MAX_MESSAGE_BYTES = 65536;
export declare const MESSAGE_HEADROOM_BYTES = 4096;
/** 路线状态枚举（`$defs.routeStatus`）。 */
export declare const ROUTE_STATUSES: readonly string[];
/** 只有这两种状态是「已建立、尚未收口的可执行问题」。 */
export declare const DISPATCHABLE_ROUTE_STATUSES: readonly string[];
/** 契约里必须写死的三条行为规矩（编排契约「派发契约字段」）。 */
export declare const WORK_RULES: readonly string[];
/**
 * 岗位目录条目 —— **wire shape 的唯一权威**。
 *
 * `catalog.ts` 直接 import 这一份（不再自带第二份 `CatalogPost`），派发/契约两侧因此是同一形状。
 * 字段类型由 `catalog.validateCatalog()` 的 `post.*` 不变量证明：`id` 是 `$defs.id` 形状的字符串，
 * 四个能力集合是字符串数组；`focus`/`priority` 只透传（契约不解释它们的语义）。
 */
export interface CatalogPost {
    id: string;
    display_name?: string | null;
    focus?: string | null;
    priority?: unknown;
    required: readonly string[];
    optional: readonly string[];
    anchors_required: readonly string[];
    prohibited: readonly string[];
    enabled?: boolean;
    disabled_reason?: string | null;
}
/** 路线记录（项目 skill 的 `re/routes/<id>.json`）；按字段读，不假设完整形状。 */
export type RouteRecord = Record<string, unknown>;
/** 契约里的 `baseline_ref`（T7 快照直接内联；具体键由 baseline 模块决定）。 */
export type BaselineRef = Record<string, unknown>;
/** `mergeRequirements` 的产物（只追加的四个集合；`buildContract` 允许传 `{}`）。 */
export interface MergedRequirements {
    evidence_required?: string[];
    prohibited?: string[];
    capability_needs?: string[];
    optional?: string[];
}
/** `classifyRoute` 的判定：只有可派发时才带 `status` 与 `target_ids`。 */
export type RouteClassification = {
    dispatchable: true;
    code: null;
    reason: string;
    next_step: string;
    status: string;
    target_ids: string[];
} | {
    dispatchable: false;
    code: string;
    reason: string;
    next_step: string;
};
/** `buildTaskSummary` 的入参。 */
export interface TaskSummaryInput {
    postId: string;
    routeId: string;
    targetIds: unknown;
    dispatchId: string;
    attemptId: string;
    operationId: string;
    contractRef: string;
    contractSha256: string;
    workDir: string;
    objective: unknown;
    attemptIndex?: number;
}
/** `measureMessageBytes` 的入参（`blocks` 是宿主 content 块数组）。 */
export interface MessageMeasureInput {
    callerName: unknown;
    blocks: unknown;
}
/** `buildDeliveryEnvelope` 的入参：必填字段缺一即 `INVALID_ARGUMENT`。 */
export interface DeliveryEnvelopeInput {
    callerName?: unknown;
    member?: unknown;
    dispatchId?: unknown;
    attemptId?: unknown;
    taskId?: unknown;
    taskRevision?: unknown;
    routeId?: unknown;
    postId?: unknown;
    contractRef?: unknown;
    contractSha256?: unknown;
    workDir?: unknown;
    runIdReservation?: unknown;
    objective?: unknown;
    rulesEntry?: unknown;
    skillCopyPath?: unknown;
    maxBytes?: number;
    headroomBytes?: number;
}
/** 交付信封：成功带可直接发送的 blocks；失败只带字节数与原因（码固定）。 */
export type DeliveryEnvelope = {
    ok: true;
    blocks: {
        type: string;
        text: string;
    }[];
    text: string;
    bytes: number;
    envelope_id: string;
    dedupe_key: string;
    limit: number;
    headroom: number;
    trimmed: string[];
    variant: string;
} | {
    ok: false;
    code: 'DELIVERY_FAILED';
    bytes: number;
    limit: number;
    reason: string;
};
/** `buildMemberPrompt` 的入参。 */
export interface MemberPromptInput {
    post: unknown;
    rulesEntry: unknown;
    skillCopyPath?: unknown;
}
/** `buildWorkRules` 的入参。 */
export interface WorkRulesInput {
    workDir: unknown;
}
/** `assertAttemptDir` / `assertAttemptPath` 的入参。 */
export interface AttemptDirInput {
    root: string;
    dispatchId: unknown;
    attemptId: unknown;
    candidate: unknown;
}
/** `assertAttemptPath` 的入参（`label` 只出现在拒绝文本里）。 */
export interface AttemptPathInput extends AttemptDirInput {
    label?: string;
}
/** `ensureWorkDir` 的入参（`paths` 默认用本模块的默认实现）。 */
export interface EnsureWorkDirInput {
    root: string;
    dispatchId: unknown;
    attemptId: unknown;
    paths?: typeof defaultPaths;
}
/** 派发时冻结的内容摘要（取自 `compatibility.computeDigests()`；没有可冻结的内容时对应项为 null）。 */
export interface ContractDigests {
    ruleDigest: string | null;
    scriptDigest: string | null;
    catalogDigest: string | null;
}
/** `buildContract` 的入参（必填项由 `requireField` 在运行期拒绝）。 */
export interface BuildContractInput {
    dispatchId?: unknown;
    attemptId?: unknown;
    attemptIndex?: unknown;
    operationId?: unknown;
    createdAt?: unknown;
    projectRoot?: unknown;
    binding?: unknown;
    post?: CatalogPost | null;
    route?: RouteRecord | null;
    targets?: readonly unknown[];
    baselineRef?: BaselineRef | null;
    objective?: unknown;
    requirements?: MergedRequirements;
    capabilityMatch?: unknown;
    resources?: unknown;
    dependsOnTasks?: readonly unknown[];
    timeboxMs?: unknown;
    deliveryTimeoutMs?: unknown;
    workDir?: unknown;
    runIdReservation?: unknown;
    contractRef?: string;
    retryOf?: unknown;
    caller?: unknown;
    /** 派发门 1 的兼容性摘要：契约据此冻结规则版本，收口侧据此发现执行期规则漂移（D8）。 */
    digests?: ContractDigests | null;
}
/** `readStartAck` 的入参。 */
export interface StartAckInput {
    root: string;
    dispatchId: unknown;
    attemptId: unknown;
}
/** `serializeContract` 的产物：文本 + 文件字节数 + 文本的 SHA256。 */
export interface SerializedContract {
    text: string;
    bytes: number;
    sha256: string;
}
/** `buildContract` 的产物：契约对象、引用路径与序列化结果。 */
export interface BuiltContract extends SerializedContract {
    contract: Record<string, unknown>;
    ref: string;
}
/** `persistContract` 的产物。 */
export interface PersistedContract {
    ref: string;
    path: string;
    sha256: string;
    bytes: number;
    created: boolean;
}
/** `persistContract` 的入参（`atomic` 就是 `deps.atomic` 的形状）。 */
export interface PersistContractInput {
    root: string;
    ref: string;
    text: string;
    atomic: typeof import('./atomic.js');
    paths?: typeof defaultPaths;
}
/** `projectAdapter` 在本模块只用到 `readSeals()`。 */
export interface SealsReader {
    readSeals(): Promise<unknown>;
}
/** `captureBaseline` 的入参。 */
export interface CaptureBaselineInput {
    root: string;
    targetIds: unknown;
    projectAdapter: SealsReader;
    atomic: Pick<typeof import('./atomic.js'), 'sha256File'>;
    paths?: typeof defaultPaths;
    now?: unknown;
    dependencyRunIds?: readonly string[];
    /** 所依赖既有已封存 RUN 的产物身份（T17）：`[{path, sha256}]`。 */
    artifacts?: unknown;
}
/** `captureBaseline` 的产物：失败带稳定码，成功带内联基准。 */
export type BaselineCapture = {
    ok: true;
    baseline_ref: BaselineRef;
} | {
    ok: false;
    code: string;
    reason: string;
    next_step: string;
    diagnostics: Diagnostic[];
};
/** 键排序后的稳定 JSON（用于摘要与去重，不用于人读文件）。 */
export declare function canonicalJson(value: unknown): string;
/**
 * 由 operation_id 稳定派生 dispatch_id（`^D-[a-z0-9][a-z0-9_-]{0,63}$`）。
 *
 * 同一 operation 必须得到同一 dispatch（否则重入会写第二份契约）；不同 operation
 * 用 8 位摘要区分，避免截断后撞名。
 *
 * `operationId` 按 `unknown` 收：形状由本函数自己拒绝（与迁移前的 `nonEmpty` 判定一致）。
 */
export declare function dispatchIdFor(operationId: unknown): string;
/**
 * 尝试序号 → `A-000001`（`$defs.attemptId`）。序号从 1 开始。
 */
export declare function attemptIdOf(index: unknown): string;
/**
 * 契约文件的项目内路径。第 1 次尝试沿用 `<dispatch-id>.json`（ticket 的固定路径），
 * 重试追加 attempt 后缀，绝不覆盖首份契约。
 */
export declare function contractRefFor(dispatchId: unknown, attemptId: unknown, attemptIndex?: unknown): string;
/** attempt 本地记录路径（dispatch/attempt → task/member 的恢复关联）。 */
export declare function attemptRefFor(dispatchId: unknown, attemptId: unknown): string;
/** 本次尝试的工作目录（项目内相对路径，无尾随 `/`：`$defs.path` 不允许空段）。 */
export declare function workDirFor(dispatchId: unknown, attemptId: unknown): string;
/** 提交清单的默认落点（必须在本 attempt 目录内）。 */
export declare function submissionRefFor(dispatchId: unknown, attemptId: unknown): string;
/** RUN ID 预留（`^RUN-[A-Za-z0-9_-]+$`）；真正封存由 Lead 在收口时做。 */
export declare function runIdReservationFor(dispatchId: unknown, attemptId: unknown): string;
/**
 * 路线的目标集合。项目 skill 的记录允许 `target_ids` 或 `targets`（字符串或对象）两种登记，
 * 两种都认；都不存在时返回空数组（由调用方拒绝）。
 */
export declare function routeTargetIds(route: unknown): string[];
/** 路线内容摘要（完整内容的 SHA256，用于契约里的「路线版本」）。 */
export declare function routeDigest(route: unknown): string;
/**
 * 判定一条路线是否是「已由 Lead 按 skill 建立、尚未收口的可执行问题」。
 *
 * 不是真值判定：这里只读记录，不推断结论；返回的 `code` 是 caller 用来无副作用拒绝的稳定码。
 * `route` 就是 `projectAdapter.readRoute()` 的内容（按字段读，形状不完整也算拒绝）。
 */
export declare function classifyRoute(route: unknown): RouteClassification;
/** 契约里的路线投影：版本（摘要）+ 问题/判据/预算 + 依赖，不复制事实层。 */
export declare function routeProjection(route: unknown): Record<string, unknown>;
/**
 * 岗位目录默认要求 ∪ 任务追加要求。**只追加**：传空数组不会删掉模板需求
 * （编排契约「工具输入与输出」：`evidence_required`/`prohibited`/`capability_needs` 都只追加）。
 *
 * `post` 是岗位目录条目（`required`/`optional`/`anchors_required`/`prohibited`），
 * `input` 是任务输入；两者都按字段读，非对象按空处理。
 */
export declare function mergeRequirements(post: unknown, input?: unknown): MergedRequirements;
/**
 * 任务板 `subject`/`description`：只放摘要（路线/派发/尝试标记、契约摘要哈希、operation_id）。
 *
 * 长度按 trim 后的 UTF-16 长度计算；objective 只截取开头，正文永远留在契约文件里。
 */
export declare function buildTaskSummary({ postId, routeId, targetIds, dispatchId, attemptId, operationId, contractRef, contractSha256, workDir, objective, attemptIndex, }: TaskSummaryInput): {
    subject: string;
    description: string;
};
/**
 * 宿主实际计量的字节数：`[{type:'text',text:'Team message from <name>:'}, ...blocks]` 的 UTF-8 字节（D9）。
 */
export declare function measureMessageBytes({ callerName, blocks }: MessageMeasureInput): number;
/**
 * 组装交付信封。消息只含引用与摘要，超长契约不受消息长度限制：
 * 依次尝试带 objective 摘录、更短的摘录、只留身份与哈希；仍然超限才 `DELIVERY_FAILED`。
 *
 * 入参见 `deliveryArgs()`（内部使用）：必填字段缺一即 `INVALID_ARGUMENT`。
 */
export declare function buildDeliveryEnvelope(input?: DeliveryEnvelopeInput): DeliveryEnvelope;
/** 组成成员 bootstrap prompt：只载入角色、项目规则入口与「等待任务」，不载契约。 */
export declare function buildMemberPrompt({ post, rulesEntry, skillCopyPath }: MemberPromptInput): string;
/** 契约里的三条行为规矩（含本次工作目录）。 */
export declare function buildWorkRules({ workDir }: WorkRulesInput): string[];
/**
 * 校验 `work_dir` 恰好是本次尝试的分配目录。
 */
export declare function assertAttemptDir({ root, dispatchId, attemptId, candidate }: AttemptDirInput): Promise<string>;
/**
 * 校验任意路径（典型是 `submission_ref`）严格落在本次尝试目录内。
 */
export declare function assertAttemptPath({ root, dispatchId, attemptId, candidate, label, }: AttemptPathInput): Promise<string>;
/** 建（或复用）本次尝试的工作目录，返回项目内相对路径。 */
export declare function ensureWorkDir({ root, dispatchId, attemptId, paths, }: EnsureWorkDirInput): Promise<string>;
/**
 * 组装完整派发契约（不可变文件的内容）。
 *
 * 契约**不内嵌自己的 `contract_sha256`** —— 哈希就是文件字节的 SHA256，
 * 回执/交付信封/台账里引用它，因此「回执里的哈希与文件字节一致」永远成立。
 */
export declare function buildContract(input?: BuildContractInput): BuiltContract;
/**
 * 读回成员写下的 `start.json`（`delivered` 不代表已开始）。
 *
 * 只有文件存在、能解析、`attempt` 与本次一致且 `at` 是带时区的 ISO 时间时，才返回该时间；
 * 其余一律 `null`（尚未开始，或确认书不合法）。
 */
export declare function readStartAck({ root, dispatchId, attemptId }: StartAckInput): Promise<string | null>;
/**
 * 序列化契约：2 空格缩进 + 结尾换行，返回文本与**文件字节**的 SHA256。
 *
 * 契约文件不内嵌 `contract_sha256` —— 否则无法满足「回执里的哈希与文件字节一致」。
 */
export declare function serializeContract(contract: unknown): SerializedContract;
/**
 * 不可变写入契约：独占创建；同内容幂等；异内容 `OPERATION_CONFLICT`（不覆盖既有证据）。
 */
export declare function persistContract({ root, ref, text, atomic, paths, }: PersistContractInput): Promise<PersistedContract>;
/**
 * 冻结本次派发的基准：目标 ID + 真实字节哈希、相关既有 seal 的路径与哈希、依赖产物身份。
 *
 * 「真实目标哈希」优先用**实际字节**算出（并核对登记值），登记值与字节不一致即
 * `BASELINE_MISMATCH`；既没登记哈希也没有可读样本时同样拒绝 ——
 * `preexisting_seals=[]` 只表示「首次目标尚无 seal」，不表示「没有目标身份」。
 */
export declare function captureBaseline(input: CaptureBaselineInput): Promise<BaselineCapture>;
