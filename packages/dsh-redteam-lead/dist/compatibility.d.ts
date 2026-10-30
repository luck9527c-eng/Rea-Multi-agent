/** 适配器契约版本（binding.json 的 `adapter.contract_version`）。 */
export declare const CONTRACT_VERSION = 1;
/** 项目内 skill 副本的相对路径（skill 自己的规则：只用副本，不用全局路径）。 */
export declare const SKILL_COPY_RELATIVE = ".agents/skills/reverse-project-management";
/** 摘要覆盖不到的地方（缺副本、缺目录、缺岗位目录）。 */
export interface CompatibilityGap {
    code: string;
    detail: string;
    nextStep: string;
}
/** 被摘要覆盖的一个文件：项目内相对路径（`/` 分隔）+ 小写 sha256。 */
export interface DigestFile {
    path: string;
    sha256: string;
}
/** 岗位目录文件的物理身份（绝对路径 + 摘要）。 */
export interface CatalogIdentity {
    path: string;
    sha256: string;
}
/** `computeDigests()` 的产物：三个摘要 + 覆盖清单 + 缺口。 */
export interface Digests {
    ruleDigest: string | null;
    scriptDigest: string | null;
    catalogDigest: string | null;
    files: {
        rule: DigestFile[];
        script: DigestFile[];
        catalog: CatalogIdentity | null;
    };
    gaps: CompatibilityGap[];
}
/** `computeDigests()` 的入参（三个都可缺；缺 projectRoot 时只会留下缺口）。 */
export interface ComputeDigestsInput {
    projectRoot?: string;
    catalogPath?: string;
    skillRoot?: string;
}
/** 摘要键（与 `digests[key]` 的三字段一一对应）。 */
export type DigestKey = 'ruleDigest' | 'scriptDigest' | 'catalogDigest';
/** `re/team/binding.json` 的读取结果：要么有对象，要么明说为什么没有。 */
export type BindingRead = {
    present: true;
    binding: Record<string, unknown>;
    path: string;
    reason?: string;
} | {
    present: false;
    binding: null;
    path: string;
    reason?: string;
};
/** 一个摘要键的 declared/actual 对照。 */
export interface DigestDifference {
    key: DigestKey;
    declared: unknown;
    actual: string | null;
}
/** `binding` 投影（`checkCompatibility()` 的 `binding` 字段）。 */
export interface BindingProjection {
    present: boolean;
    path: string;
    matched: boolean;
    differences: DigestDifference[];
    reason?: string;
    adapter_contract_version: unknown;
}
/** 兼容性信号闭集（只报告，不静默替换副本）。 */
export type BindingSignal = 'BINDING_MISSING' | 'BINDING_MATCH' | 'REBIND_REQUIRED';
/** `checkCompatibility()` 的产物。 */
export interface CompatibilityReport {
    contract_version: number;
    digests: Digests;
    gaps: CompatibilityGap[];
    binding: BindingProjection;
    needsReview: boolean;
    signal: BindingSignal;
    nextStep?: string;
    differences?: DigestDifference[];
}
/** `checkCompatibility()` 的入参：显式传入的 `binding` 优先于读文件。 */
export interface CheckCompatibilityInput {
    projectRoot?: string;
    binding?: Record<string, unknown>;
    catalogPath?: string;
}
/**
 * 计算三个内容摘要。缺文件不抛：摘要置 null 并给出 gap。
 * @param {{projectRoot: string, catalogPath?: string, skillRoot?: string}} input
 */
export declare function computeDigests(input?: ComputeDigestsInput): Promise<Digests>;
/**
 * 读 `re/team/binding.json`。缺失或坏 JSON 都返回 `present:false`，不抛。
 * @param {string} projectRoot
 */
export declare function readBinding(projectRoot: unknown): Promise<BindingRead>;
/**
 * 计算摘要并与 binding 比对。
 *
 * - 没有 binding → `BINDING_MISSING`（首次 bind 之前的正常状态）；
 * - 摘要一致 → `BINDING_MATCH`，`needsReview:false`；
 * - 任一摘要不一致或缺失 → `REBIND_REQUIRED`，`needsReview:true`，并列出差异。
 *
 * 不一致时**只报告信号**，不改项目副本、不换规则（D8：报告缺口，不静默替换）。
 *
 * @param {{projectRoot: string, binding?: object, catalogPath?: string}} input
 */
export declare function checkCompatibility(input?: CheckCompatibilityInput): Promise<CompatibilityReport>;
