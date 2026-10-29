/**
 * 入参校验（JSON Schema 子集）与规范化。
 *
 * 形状只认 `docs/specs/rt-tools.schema.json` 的 `$defs`；本模块不复述、不改写规格。
 * 支持关键字：$ref（仅 `#/$defs/<name>`）、type、required、properties、additionalProperties、
 * items、enum、const、oneOf、anyOf、allOf、not、if/then/else、pattern、minLength、maxLength、
 * minimum、maximum、minItems、maxItems、uniqueItems、format（date-time）。
 * `if/then/else` 与 `not` 是规格数据里实际用到的（rosterInput 的 bind/takeover 分支、
 * result 信封的 ok 分支、review 的 outcome 门槛），缺了它们校验器会静默放行非法输入。
 *
 * 规范化顺序按编排契约：拒绝重复集合项 → 填默认值 → 规范化项目根 → 集合语义数组排序
 * →（调用方）对 tool/action/project/session/epoch 与输入按键排序求 SHA256。
 * 正文文本保留实际内容，不做 trim。
 *
 * 本模块不做 I/O：项目根的真实化通过注入的 `normalizeRoot` 完成。
 */
/**
 * 一条校验问题（`path` 是 JSON Pointer 形式的位置）。
 *
 * `params` 只在某些关键字上出现（规格不需要它，人读诊断才需要），因此是可选的松散对象。
 */
export interface Issue {
    path: string;
    keyword: string;
    message: string;
    params?: unknown;
}
/** `validateInput()` 的返回值。 */
export interface ValidationResult {
    ok: boolean;
    issues: Issue[];
}
/** `normalizeInput()` 的入参。 */
export interface NormalizeInputOptions {
    /** 整份 schema（含 `$defs`）或 `$defs` 映射本身。 */
    schemaDefs?: unknown;
    /** 定义名，如 `rosterInput`。 */
    defName?: string;
    input?: unknown;
    /** 项目根真实化；由调用方注入（本模块不做 I/O）。 */
    normalizeRoot?: (raw: string) => string | Promise<string>;
}
/** `normalizeInput()` 的返回值。 */
export interface NormalizeInputResult {
    ok: boolean;
    issues: Issue[];
    value: unknown;
}
/** `operationInputHash()` 的上下文；值原样进哈希载荷，因此按写入方给什么就收什么。 */
export interface OperationHashContext {
    tool?: unknown;
    action?: unknown;
    project?: unknown;
    session?: unknown;
    epoch?: unknown;
}
/**
 * 按键排序的 JSON 编码（UTF-8 语义），用于哈希与深比较。
 * 正文文本原样保留。
 *
 * 契约要求返回字符串：调用方只喂 JSON 值，而 `JSON.stringify` 对 JSON 值恒返回字符串
 * （只有 `undefined`/函数/Symbol 才返回 `undefined`，那不是本模块的入参）。
 */
export declare function canonicalJson(value: unknown): string;
/**
 * 按 `$defs` 中的定义校验入参。
 * @param schemaDefs 整份 schema（含 `$defs`）或 `$defs` 映射本身
 * @param defName 定义名，如 `rosterInput`
 */
export declare function validateInput(schemaDefs: unknown, defName: string, value: unknown): ValidationResult;
/**
 * 规范化的第一步：拒绝重复集合项（语义为集合 = `uniqueItems: true` 的数组）。
 * @returns issues
 */
export declare function detectDuplicateSetItems(schemaDefs: unknown, defName: string, value: unknown): Issue[];
/**
 * 规范化第二步：按 schema 的 `default` 注解填默认值。
 * schema 的 default 只是注解，只有显式调用本函数才会生效（契约要求处理器显式填默认值）。
 * @returns 填好默认值的新对象（不改调用方入参）
 */
export declare function applyDefaults(schemaDefs: unknown, defName: string, value: unknown): unknown;
/**
 * 规范化第四步：把语义为集合的数组（`uniqueItems: true`）按规范 JSON 排序，
 * 让同一集合的不同书写顺序得到同一哈希。
 * @returns 排序后的新对象
 */
export declare function sortSetArrays(schemaDefs: unknown, defName: string, value: unknown): unknown;
/**
 * 校验 + 规范化：拒绝重复集合项 → 校验形状 → 填默认值 → 规范化项目根 → 集合排序。
 */
export declare function normalizeInput(options?: NormalizeInputOptions): Promise<NormalizeInputResult>;
/**
 * 操作输入哈希：`{tool, action, project, session, epoch, input}` 按键排序后编码成 UTF-8 JSON 求 SHA256。
 *
 * 正文文本保留实际内容；身份上下文字段由调用方按该操作首次捕获的授权上下文传入。
 * 上下文各字段原样进哈希载荷（只做 JSON 编码），因此这里按调用方给什么就收什么。
 *
 * @param input 已规范化的输入
 * @returns 小写十六进制 SHA256
 */
export declare function operationInputHash(input: unknown, context?: OperationHashContext): string;
