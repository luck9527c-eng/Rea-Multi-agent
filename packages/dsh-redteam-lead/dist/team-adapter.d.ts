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
/** 已用席位（唯一可读的容量事实）的结果。`used === null` = 数不到，不是 0。 */
export interface UsedSeatsResult {
    ok: boolean;
    used: number | null;
    code?: string;
    reason?: string;
    nextStep?: string;
}
/** `createTeamAdapter()` 的入参：两种形态（装配上下文 / 显式注入）的并集，全部按 `unknown` 收。 */
export interface TeamAdapterOptions {
    ctx?: unknown;
    services?: unknown;
    exec?: unknown;
    /**
     * `config` / `projectRoot` 只为与装配层（`index.ts` 的两个适配器共用一份 options）保持同一形状：
     * T23 起团队适配器**不读项目文件、也不读 profile 配置里的容量段**，只有 `exec.agent` 与
     * `services.agentTeams` 会被用到。
     */
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
    membership(agent?: unknown): Promise<MembershipResult>;
    listMembers(agent?: unknown): Promise<ListMembersResult>;
    spawnTeammate(request?: SpawnTeammateRequest): Promise<SpawnTeammateResult>;
    sendMessage(request?: SendMessageRequest): Promise<SendMessageResult>;
    interruptAgent(request?: InterruptRequest): Promise<InterruptResult>;
    usedSeats(): Promise<UsedSeatsResult>;
    createTask(request?: CreateTaskRequest): Promise<CreateTaskResult>;
    updateTask(request?: UpdateTaskRequest): Promise<UpdateTaskResult>;
    getTask(taskId?: unknown): Promise<GetTaskResult>;
    listTasks(): Promise<ListTasksResult>;
}
/**
 * 建一个 teamAdapter。
 *
 * 支持两种入参形态：
 * - `createTeamAdapter({ ctx })`：从装配上下文取 `services` / `exec`；
 * - `createTeamAdapter({ services, exec, agent })`：显式注入。
 *
 * `config` / `projectRoot` 仍然接受（装配层给两个适配器同一份 options），但不再被读取：
 * T23 起团队适配器不读项目里的容量声明文件，也不读 profile 配置里的容量段。
 */
export declare function createTeamAdapter(input?: TeamAdapterOptions): TeamAdapterApi;
