/**
 * 锚点闭集校验（六类）。
 *
 * 契约（编排契约「锚点与封存绑定」、规格「锚点闭集」）：
 * - `anchor_ref` 统一指向 `run_id/path/locator`；`path` 必须登记在该 RUN 的 `artifacts`。
 * - 完整类型信息记录在所指产物里，插件只读校验 —— 这里校验的是**产物内最低定位字段**的投影，
 *   即 `locator` 里必须齐备的键。`locator` 是 `$defs.text`，因此本模块把文本解析成键值表：
 *   支持 `k=v; k2=v2` 与 JSON 对象两种写法（两者等价）。
 * - **函数名、URL、evidence ID 单独不成立**：每类都有 missing-required 拒绝路径。
 *
 * 本模块是纯函数（`parseLocator` / `validateAnchorRef` / `validateAnchorSet` / `mergeRequiredKinds`），
 * 不读文件、不碰 adapter；调用方负责取 RUN 的 artifacts 清单。
 */
import type { Diagnostic } from './types.js';
/** 六类锚点，顺序与 `$defs.anchorKind` 一致。 */
export declare const ANCHOR_KINDS: readonly string[];
/**
 * 每类的最低定位字段（编排契约表逐行落地）。
 *
 * - `all`：必须齐备的键。
 * - `anyOf`：**至少有一组**键要齐备（例如 va/rva/file_offset 三选一；行号或字节范围二选一）。
 * - `conditional`：`when` 存在时追加要求。
 * - `hashes`：值必须是 64 位小写十六进制（目标/内容身份，不允许占位符）。
 */
/** 一类锚点的最低定位字段规则（上表的一行）。 */
interface KindRule {
    all?: readonly string[];
    anyOf?: readonly (readonly string[])[];
    conditional?: ReadonlyArray<{
        when: string;
        all?: readonly string[];
        anyOf?: readonly (readonly string[])[];
    }>;
    hashes?: readonly string[];
}
export declare const REQUIRED_FIELDS_BY_KIND: Readonly<Record<string, KindRule>>;
/** `parseLocator` 的结果：可解析就给键值表，否则给一句人读原因。 */
type ParsedLocator = {
    ok: true;
    fields: Record<string, string>;
} | {
    ok: false;
    reason: string;
};
/**
 * 解析 `locator` 文本为键值表。
 *
 * @param {unknown} locator
 * @returns {{ ok: true, fields: Record<string, string> } | { ok: false, reason: string }}
 */
export declare function parseLocator(locator: unknown): ParsedLocator;
/** `validateAnchorRef` 的调用方上下文（`runIds` 缺省表示不校验 RUN 归属）。 */
interface AnchorRefContext {
    runIds?: string[];
    artifactsForRun?: (runId: string) => string[];
}
/** 单条锚点的校验结果。 */
type AnchorRefVerdict = {
    ok: true;
} | {
    ok: false;
    code: 'SUBMISSION_INVALID';
    issues: Diagnostic[];
};
/**
 * 校验单条 `anchor_ref`。
 *
 * @param {unknown} ref
 * @param {{ runIds?: string[], artifactsForRun?: (runId: string) => string[] }} [context]
 * @returns {{ ok: true } | { ok: false, code: 'SUBMISSION_INVALID', issues: Array<{code:string, reason:string, next_step:string}> }}
 */
export declare function validateAnchorRef(ref: unknown, context?: AnchorRefContext): AnchorRefVerdict;
/** `validateAnchorSet` 的入参（`refs` 保持 `unknown[]`：逐条再收窄）。 */
interface AnchorSetInput {
    refs?: unknown[];
    requiredKinds?: string[];
    runIds?: string[];
    artifactsForRun?: (runId: string) => string[];
}
/** 锚点集合的校验结果。 */
type AnchorSetVerdict = {
    ok: true;
} | {
    ok: false;
    code: 'SUBMISSION_INVALID';
    issues: Diagnostic[];
};
/**
 * 校验一组锚点：逐条 + 闭集（requiredKinds 必须全部出现）。
 *
 * @param {{ refs?: unknown[], requiredKinds?: string[], runIds?: string[],
 *           artifactsForRun?: (runId: string) => string[] }} input
 */
export declare function validateAnchorSet(input?: AnchorSetInput): AnchorSetVerdict;
/** `mergeRequiredKinds` 的入参：两组可能缺省/形状不对的要求清单。 */
interface RequiredKindsInput {
    anchorsRequired?: unknown;
    evidenceRequired?: unknown;
}
/** 合并后的要求：去重排序的 kind 与被跳过的未知 kind 诊断。 */
interface MergedKinds {
    kinds: string[];
    issues: Diagnostic[];
}
/**
 * 合并锚点要求：岗位默认 ∪ 契约 `evidence_required`，去重并稳定排序。
 *
 * 未知 kind **不静默丢弃**：进入 `issues`，由调用方决定拒绝。
 *
 * @param {{ anchorsRequired?: unknown, evidenceRequired?: unknown }} input
 * @returns {{ kinds: string[], issues: Array<{code:string, reason:string, next_step:string}> }}
 */
export declare function mergeRequiredKinds(input?: RequiredKindsInput): MergedKinds;
export {};
