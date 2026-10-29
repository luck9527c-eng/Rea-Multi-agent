import type { CatalogPost } from './contract.js';
export type { CatalogPost };
/** 合法目标类别；与 rt-tools.schema.json 的 `$defs.kinds` 一致。 */
export declare const TARGET_KINDS: readonly string[];
/** 具体模板 ID；mixed 是组合规则，不是岗位列表。 */
export declare const CONCRETE_TEMPLATES: readonly string[];
/** 规范化后的能力族定义（目录里 `capabilities[<name>]` 的一项）。 */
export interface CatalogCapability extends Record<string, unknown> {
    binding_required: boolean;
    any_tool?: unknown[];
    any_provider?: unknown;
    all_capabilities?: unknown[];
    source_ref?: unknown;
    readiness_ref?: unknown;
}
/** 规范化后的模板段。 */
export interface CatalogTemplates {
    binary: unknown[];
    game: unknown[];
    webapp: unknown[];
    mixed: {
        composition: unknown;
        min_target_kinds: unknown;
    } | undefined;
}
/** `normalizeCatalog()` 的产物（`defaultCatalog()`/`loadCatalog()` 的返回形状）。 */
export interface NormalizedCatalog {
    schema_version: unknown;
    catalog_version: unknown;
    defaults: Record<string, unknown>;
    capabilities: Record<string, CatalogCapability>;
    posts: CatalogPost[];
    templates: CatalogTemplates;
    on_demand_posts: unknown[];
    reserved_posts: unknown[];
    capability_defaults_source: unknown;
}
/** 一条目录不变量错误。 */
export interface CatalogError {
    code: string;
    invariant: string;
    detail: string;
}
/** `validateCatalog()` 的返回。 */
export interface CatalogValidation {
    ok: boolean;
    errors: CatalogError[];
}
/** 模板组合的失败形状（`ok:false` + 已清空的岗位集合）。 */
export interface ComposeTemplateInvalid {
    ok: false;
    code: string;
    reason: string;
    next_step: string;
    posts: CatalogPost[];
    reserved_posts: CatalogPost[];
    on_demand_posts: CatalogPost[];
    available_post_count: number;
    errors?: CatalogError[];
}
/** 模板组合的成功形状。 */
export interface ComposeTemplateOk {
    ok: true;
    template_id: string;
    target_kinds: unknown[];
    posts: CatalogPost[];
    reserved_posts: CatalogPost[];
    on_demand_posts: CatalogPost[];
    available_post_count: number;
}
/** `composeTemplate()` 的返回（按 `ok` 判别的两种形状）。 */
export type ComposeTemplateResult = ComposeTemplateOk | ComposeTemplateInvalid;
/**
 * 规范化并冻结一份目录。调用者应只通过本函数取得目录，避免拿到可变数据源。
 * @param raw 已解析的目录 JSON
 */
export declare function normalizeCatalog(raw: unknown): NormalizedCatalog;
/** 包内自带副本。每次调用都重新读取，避免模块级可变缓存。 */
export declare function defaultCatalog(): NormalizedCatalog;
/**
 * 校验并加载目录。目录是数据源而不是用户输入，坏了属于包缺陷，因此抛错而不是返回信封。
 * @param source 已解析对象
 */
export declare function loadCatalog(source: unknown): NormalizedCatalog;
/**
 * 对目录做全部静态不变量校验。纯函数：不修改入参，返回错误清单而不是抛异常。
 */
export declare function validateCatalog(catalog: unknown): CatalogValidation;
/**
 * 组合模板，返回候选岗位集合（不造岗、不去重之外的任何补充）。
 *
 * - 具体模板：`binary | game | webapp`；若调用者给了 target_kinds，必须与模板一致。
 * - mixed：至少两个**不同** target_kinds，取各自模板岗位的并集，按 post_id 去重。
 * - on_demand_posts 不自动入模板；reserved_posts 单列且不计入可用岗位数。
 *
 * @param templateId 模板 ID
 * @param targetKinds 目标类别（binary/game/webapp 的子集）
 * @param catalog 已加载/未加载的目录；默认读包内副本
 */
export declare function composeTemplate(templateId: string, targetKinds?: unknown, catalog?: unknown): ComposeTemplateResult;
/** 按 ID 取岗位（含 disabled / on_demand / reserved），目录缺该 ID 时返回 null。 */
export declare function findPost(postId: string, catalog?: unknown): CatalogPost | null;
