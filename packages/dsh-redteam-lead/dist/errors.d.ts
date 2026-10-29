/**
 * 稳定错误码与契约错误。
 *
 * 错误码集合只有唯一来源：`docs/specs/orchestration-contract.md` 的「稳定错误码」表，
 * 与 `docs/specs/rt-tools.schema.json` 的 `$defs.errorCode` 枚举逐字一致。
 * 任何新增码都必须先改规格；本模块不接受自造码，也不把宿主异常码（如 `ENOENT`）当契约码。
 *
 * 本模块无 I/O、无副作用，可被任何上层模块直接引用。
 */
/** 稳定错误码的五个分组（只用于生成人读诊断与默认状态推导，不改变码本身）。 */
export declare const ERROR_GROUPS: Readonly<{
    inputPermission: readonly string[];
    access: readonly string[];
    dispatch: readonly string[];
    delivery: readonly string[];
    conclude: readonly string[];
}>;
/**
 * 全部稳定错误码，按契约表原顺序（输入与权限 → 接入 → 派发前置 → 交付与恢复 → 收口）。
 */
export declare const ERROR_CODES: readonly string[];
/** 由码推导的默认状态（信封层用）。 */
export type EnvelopeStatus = 'error' | 'blocked' | 'partial';
/** `ContractError` 的构造入参。`code` 由构造函数在运行期校验，故此处标成可选。 */
export interface ContractErrorInput {
    code?: string;
    message?: string;
    nextStep?: string;
    details?: Record<string, unknown> | null;
    status?: EnvelopeStatus | null;
    retryable?: boolean;
    cause?: unknown;
}
/**
 * 判断是否为已登记的稳定错误码。
 */
export declare function isErrorCode(value: unknown): value is string;
/**
 * 契约错误：内部各层抛它，由信封层转成 `status=error|blocked|partial` 的合法结果。
 *
 * 字段与契约表一致：`code`（稳定码）、`message`（原因）、`nextStep`（下一步）、`details`（具体对象）。
 * 另带两个可选字段供信封层使用：`status`（覆盖由码推导的默认状态）与 `retryable`
 * （仅表示允许以同一 operation ID 重入，不代表自动重试）。
 */
export declare class ContractError extends Error {
    /** 稳定错误码（构造时已校验）。 */
    readonly code: string;
    /** 下一步（永不为空）。 */
    nextStep: string;
    /** 进程内机读的具体对象；**不可上 wire**（$defs.diagnostic 是封闭三字段）。 */
    details: Record<string, unknown>;
    /** 覆盖由码推导的默认状态；`null` 表示沿用默认。 */
    status: EnvelopeStatus | null;
    /** 允许以同一 operation ID 重入（不代表自动重试）。 */
    retryable: boolean;
    constructor(input?: ContractErrorInput);
}
/**
 * 识别本模块定义的契约错误（不认鸭子类型的普通对象，也不认带 `code` 的宿主异常）。
 */
export declare function isContractError(value: unknown): value is ContractError;
