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
import { appendLine } from './atomic.js';
import { recordOf, thrownMessage } from './guards.js';
import { resolveInProject } from './paths.js';
/** 项目内审计文件路径（统一 `/`）。 */
export const AUDIT_PATH = 're/team/audit.jsonl';
/**
 * 固定列顺序。缺省填 null，未知字段丢弃 —— 保证 JSONL 每行列一致、可直接被工具消费。
 */
export const AUDIT_FIELDS = Object.freeze([
    'at',
    'kind',
    'route',
    'task',
    'member',
    'requester',
    'verdict',
]);
function isoNowOf(clock) {
    if (clock && typeof clock === 'object' && typeof clock.isoNow === 'function')
        return clock.isoNow();
    if (typeof clock === 'function')
        return new Date(clock()).toISOString();
    return new Date().toISOString();
}
function column(value) {
    if (value === undefined || value === null)
        return null;
    if (typeof value === 'string')
        return value;
    if (typeof value === 'number' || typeof value === 'boolean')
        return String(value);
    return JSON.stringify(value);
}
/**
 * 追加一条审计记录。
 *
 * **绝不抛出**：任何失败都以 `{ written: false, error }` 返回，由调用方写入 `audit_written=false`。
 */
export async function appendAudit(root, entry, options = {}) {
    try {
        if (typeof root !== 'string' || root.length === 0) {
            return { written: false, error: '缺少项目根，无法写入审计' };
        }
        if (!entry || typeof entry !== 'object') {
            return { written: false, error: '审计条目必须是对象' };
        }
        if (typeof entry.kind !== 'string' || entry.kind.trim() === '') {
            return { written: false, error: '审计条目缺少 kind（非空字符串）' };
        }
        const at = typeof entry.at === 'string' && entry.at.length > 0 ? entry.at : isoNowOf(options.clock);
        // 列清单是固定的七列，这里按列名读同一个条目对象（`entry` 的类型只声明了这七列）。
        const source = recordOf(entry);
        const record = {};
        for (const field of AUDIT_FIELDS) {
            record[field] = field === 'at' ? at : column(source[field]);
        }
        const line = `${JSON.stringify(record)}\n`;
        // 追加走 `atomic.appendLine()`：append-only 与「原子替换」是两种语义，例外写在
        // CONVENTIONS「原子写与追加」里，这里是唯一的追加入口（业务模块不得自己 import appendFile）。
        const filePath = resolveInProject(root, AUDIT_PATH);
        await appendLine(filePath, line);
        return { written: true, line };
    }
    catch (error) {
        return { written: false, error: thrownMessage(error) };
    }
}
