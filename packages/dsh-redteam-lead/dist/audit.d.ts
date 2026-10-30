/**
 * 审计日志 `re/team/audit.jsonl`（append-only）。
 *
 * 契约（「操作阶段与部分失败」）：
 * - 审计是 **best-effort**：写失败不逆转已有证据判定，也不抛异常；
 *   调用方据返回值把 `audit_written=false` 写进回执，并附一条诊断。
 * - 每行是一个 JSON 对象，字段固定为 `at/kind/route/task/member/requester/verdict`。
 * - append-only：只追加、不重写、不回滚；一行一条记录。
 *
 * 需要「必需回执写失败」时走 `partial` 信封，那不是审计的职责（审计失败仍可以 ok）。
 */
import type { Clock } from './types.js';
/** 项目内审计文件路径（统一 `/`）。 */
export declare const AUDIT_PATH = "re/team/audit.jsonl";
/**
 * 固定列顺序。缺省填 null，未知字段丢弃 —— 保证 JSONL 每行列一致、可直接被工具消费。
 */
export declare const AUDIT_FIELDS: readonly string[];
/** 一条审计记录：`kind` 必填，其余列可选（缺省写 null）。 */
export interface AuditEntry {
    kind: string;
    route?: string | null;
    task?: string | null;
    member?: string | null;
    requester?: string | null;
    verdict?: string | null;
    at?: string | null;
}
/** 审计的时钟选项：`deps.clock` 形状，或一个返回毫秒的函数。 */
export interface AuditOptions {
    clock?: Pick<Clock, 'isoNow'> | (() => number);
}
/** 审计写入结果（**绝不抛出**）。 */
export type AuditResult = {
    written: true;
    line: string;
} | {
    written: false;
    error: string;
};
/**
 * 追加一条审计记录。
 *
 * **绝不抛出**：任何失败都以 `{ written: false, error }` 返回，由调用方写入 `audit_written=false`。
 */
export declare function appendAudit(root: string, entry: AuditEntry, options?: AuditOptions): Promise<AuditResult>;
