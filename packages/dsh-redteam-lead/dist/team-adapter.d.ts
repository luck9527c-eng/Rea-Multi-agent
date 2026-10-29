/** 适配器契约版本（写进 re/team/binding.json 的 `adapter.contract_version`）。 */
export declare const CONTRACT_VERSION = 1;
/** 同上，长名字别名，便于下游按字段名取值。 */
export declare const ADAPTER_CONTRACT_VERSION = 1;
/** 适配器诊断（`code`/`detail` 必有，`nextStep`/`hostCode` 视分支而定）。 */
export interface AdapterDiagnostic {
    code: string;
    detail: string;
    nextStep?: string;
    hostCode?: string | null;
}
/** 失败分支的公共形状：`ok:false` + 稳定码 + 人读原因（SEAMS 第 6 节）。 */
export interface FailureBranch {
    ok: false;
    code: string;
    reason: string;
    retryable?: boolean;
    nextStep?: string;
    diagnostics?: AdapterDiagnostic[];
}
/**
 * 把成功分支的负载字段在失败分支上声明为可选。
 *
 * 失败时这些字段**可能**缺席（大多数分支），也可能带部分负载（例如 `updateTask` 的
 * `actualRevision`）；声明成可选正好覆盖两种情况，并且让 `x.ok === true` 之后收窄成
 * 必有字段，避免下游到处写非空判断。
 */
export type FailureOf<P extends object> = FailureBranch & {
    [K in keyof P]?: P[K];
};
/** 名册一行（`listMembers()` 投影）。 */
export interface TeamMemberRow {
    id: string;
    name: string;
    role: string;
    status: string;
}
/** `membership()` 投影的成员身份。宿主给什么就投影什么（下游用 `recordOf` 收窄）。 */
export interface MembershipMember {
    id: unknown;
    name: unknown;
    role: unknown;
    root: unknown;
}
/** `spawnTeammate()` 投影出的成员（SEAMS §3 的 `{id, name, role, status}` + 可选诊断）。 */
export interface SpawnedMember {
    id: string;
    name: string;
    role: string;
    status: string;
    diagnostics?: unknown[];
}
/** 宿主任务视图 → SEAMS §3 的 task 形状（`ownerName` 投影成 `owner`）。 */
export interface TeamTask {
    id: string;
    revision: number;
    status: string;
    owner: string | null;
    subject: string;
    description: string;
    blockedBy: string[];
    ready: boolean;
    writeScopes: string[];
}
/** 容量声明里的一个缺口（绝不猜上限）。 */
export interface CapacityGap {
    code: string;
    detail: string;
    nextStep: string;
}
/** 席位（`used` 恒可数；`total`/`remaining` 只来自显式声明）。 */
export interface MemberSlots {
    known: boolean;
    remaining: number | null;
    total: number | null;
    used: number | null;
}
/** activation 池（只声明上限；当前占用不可观测）。 */
export interface ActivationSlots {
    known: boolean;
    remaining: number | null;
    total: number | null;
}
/** 容量来源与声明身份。 */
export interface CapacityEvidence {
    source: string;
    declaredAt?: unknown;
    declaredBy?: unknown;
    maxMembers?: number;
    maxActiveSubagents?: number;
    usedSeats: number | null;
}
/** `capacity()` 的返回：两支都带容量投影（服务缺席时也要说清「数不到已用席位」）。 */
export interface TeamCapacityResult {
    ok: boolean;
    code?: string;
    reason?: string;
    memberSlots: MemberSlots;
    activations: ActivationSlots;
    evidence: CapacityEvidence;
    gaps: CapacityGap[];
}
/** `re/team/capacity.json` 校验通过后的声明。 */
export interface DeclaredCapacityKnown {
    known: true;
    maxMembers: number;
    maxActiveSubagents: number;
    declaredAt: unknown;
    declaredBy: unknown;
    source: string;
    path: string;
}
/** 声明缺失/非法：只给缺口，不给数字。 */
export interface DeclaredCapacityMissing {
    known: false;
    gap: CapacityGap;
}
/** `readDeclaredCapacity()` 的产物。 */
export type DeclaredCapacity = DeclaredCapacityKnown | DeclaredCapacityMissing;
/** `createTeamAdapter()` 的入参：两种形态（装配上下文 / 显式注入）的并集，全部按 `unknown` 收。 */
export interface TeamAdapterOptions {
    ctx?: unknown;
    services?: unknown;
    exec?: unknown;
    config?: unknown;
    agent?: unknown;
    projectRoot?: unknown;
    /** SEAMS §1 的装配表会一并传下来；本适配器不解释它。 */
    deps?: unknown;
}
/** `spawnTeammate()` 的入参（形状由调用方给，适配器只做校验）。 */
export interface SpawnTeammateRequest {
    name?: unknown;
    prompt?: unknown;
    description?: unknown;
    context?: unknown;
    provider?: unknown;
    signal?: AbortSignal;
}
/** `sendMessage()` 的入参。 */
export interface SendMessageRequest {
    target?: unknown;
    message?: unknown;
    content?: unknown;
    signal?: AbortSignal;
}
/** `interruptAgent()` 的入参。 */
export interface InterruptRequest {
    target?: unknown;
}
/** `createTask()` 的入参。 */
export interface CreateTaskRequest {
    subject?: unknown;
    description?: unknown;
    blockedBy?: unknown;
    writeScopes?: unknown;
}
/** `updateTask()` 的入参（`expectedRevision` 是「变更前」的 revision）。 */
export interface UpdateTaskRequest {
    taskId?: unknown;
    expectedRevision?: unknown;
    action?: unknown;
    owner?: unknown;
    subject?: unknown;
    description?: unknown;
    blockedBy?: unknown;
    writeScopes?: unknown;
}
/** `membership()` 的结果。 */
export type MembershipResult = {
    ok: true;
    member: MembershipMember;
} | FailureOf<{
    member: MembershipMember;
}>;
/** `listMembers()` 的结果。 */
export type ListMembersResult = {
    ok: true;
    members: TeamMemberRow[];
} | FailureOf<{
    members: TeamMemberRow[];
}>;
/** `spawnTeammate()` 的结果。 */
export type SpawnTeammateResult = {
    ok: true;
    member: SpawnedMember | null;
} | FailureOf<{
    member: SpawnedMember | null;
}>;
/** `sendMessage()` 的结果。 */
export type SendMessageResult = {
    ok: true;
    messageId: unknown;
} | FailureOf<{
    messageId: unknown;
}>;
/** `interruptAgent()` 的结果（`previousStatus` 只可能是 running|inactive，D10）。 */
export type InterruptResult = {
    ok: true;
    previousStatus: string;
} | FailureOf<{
    previousStatus: string;
}>;
/** `createTask()` 的结果。 */
export type CreateTaskResult = {
    ok: true;
    task: TeamTask | null;
} | FailureOf<{
    task: TeamTask | null;
}>;
/** `updateTask()` 的结果（CAS 冲突时额外带宿主给的实际 revision）。 */
export type UpdateTaskResult = {
    ok: true;
    task: TeamTask | null;
    actualRevision?: number | null;
} | FailureOf<{
    task: TeamTask | null;
    actualRevision: number | null;
}>;
/** `getTask()` 的结果。 */
export type GetTaskResult = {
    ok: true;
    task: TeamTask | null;
} | FailureOf<{
    task: TeamTask | null;
}>;
/** `listTasks()` 的结果。 */
export type ListTasksResult = {
    ok: true;
    tasks: (TeamTask | null)[];
} | FailureOf<{
    tasks: (TeamTask | null)[];
}>;
/** `createTeamAdapter()` 返回的实例（`types.ts` 的 `TeamAdapter` 就是这个形状）。 */
export interface TeamAdapterApi {
    contract_version: number;
    CONTRACT_VERSION: number;
    hasService(): boolean;
    readDeclaredCapacity(root?: unknown): Promise<DeclaredCapacity>;
    membership(agent?: unknown): Promise<MembershipResult>;
    listMembers(agent?: unknown): Promise<ListMembersResult>;
    spawnTeammate(request?: SpawnTeammateRequest): Promise<SpawnTeammateResult>;
    sendMessage(request?: SendMessageRequest): Promise<SendMessageResult>;
    interruptAgent(request?: InterruptRequest): Promise<InterruptResult>;
    capacity(): Promise<TeamCapacityResult>;
    createTask(request?: CreateTaskRequest): Promise<CreateTaskResult>;
    updateTask(request?: UpdateTaskRequest): Promise<UpdateTaskResult>;
    getTask(taskId?: unknown): Promise<GetTaskResult>;
    listTasks(): Promise<ListTasksResult>;
}
/**
 * 读并校验项目里的容量声明 `re/team/capacity.json`。
 * 文件缺失/JSON 坏/字段不合法都返回 `{known:false, gap}`，不抛。
 * @param {string} projectRoot 项目根
 */
export declare function readDeclaredCapacity(projectRoot: unknown): Promise<DeclaredCapacity>;
/**
 * 建一个 teamAdapter。
 *
 * 支持两种入参形态：
 * - `createTeamAdapter({ ctx })`：从装配上下文取 `services` / `exec` / `config` / `root`；
 * - `createTeamAdapter({ services, exec, agent, config, projectRoot })`：显式注入。
 */
export declare function createTeamAdapter(input?: TeamAdapterOptions): TeamAdapterApi;
