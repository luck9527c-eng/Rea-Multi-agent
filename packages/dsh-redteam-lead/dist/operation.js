/**
 * operation 台账：按 operation ID 重放与续做。
 *
 * 契约（「操作阶段与部分失败」「稳定错误码」）：
 * - operation ID 在项目内唯一，绑定**规范化输入的哈希**。
 * - 相同 ID + 相同哈希 → 恢复或重放，不重复创建成员/任务/封存/历史。
 * - 相同 ID + 不同哈希 → `OPERATION_CONFLICT`，绝不覆盖既有台账。
 * - 阶段闭集与契约表逐字一致：`prepared → member_ready → task_created → assigned →
 *   delivered → integrating → facts_committed → completed`，外加 `needs_recovery`。
 * - 每步「先存意图、后存实际 ID」由调用方保证；本模块只负责原子落盘与冲突判定。
 *
 * 台账文件：`re/team/operations/<operation_id>.json`（`$defs.id` 保证文件名安全）。
 * 并发由项目锁协调（调用方持有 `re/team/lock`），本模块只做读-改-写。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ContractError } from './errors.js';
import { isRecord, thrownCode } from './guards.js';
import { writeJsonAtomic } from './atomic.js';
/** 项目内台账目录。 */
export const OPERATIONS_DIR = 're/team/operations';
/**
 * 操作阶段闭集，按契约表顺序（含 `completed`；失败态用 `needs_recovery`）。
 * 注意 `$defs.failureData` 的阶段集合另有 `preflight` 且不含 `completed`（见 envelope.mjs）。
 */
export const OPERATION_PHASES = Object.freeze([
    'prepared',
    'member_ready',
    'task_created',
    'assigned',
    'delivered',
    'integrating',
    'facts_committed',
    'completed',
    'needs_recovery',
]);
/** `$defs.id` */
const OPERATION_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,95}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const DEFAULT_CLOCK = {
    now: () => Date.now(),
    isoNow: () => new Date().toISOString(),
};
function normalizeClock(clock) {
    if (!clock)
        return DEFAULT_CLOCK;
    if (typeof clock === 'function') {
        return { now: clock, isoNow: () => new Date(clock()).toISOString() };
    }
    return {
        now: typeof clock.now === 'function' ? clock.now : DEFAULT_CLOCK.now,
        isoNow: typeof clock.isoNow === 'function' ? clock.isoNow : () => new Date(clock.now()).toISOString(),
    };
}
function invalid(message, nextStep) {
    return new ContractError({ code: 'INVALID_ARGUMENT', message, nextStep });
}
function recoveryRequired(message, nextStep, details) {
    return new ContractError({ code: 'RECOVERY_REQUIRED', message, nextStep, details });
}
function assertOperationId(operationId) {
    if (typeof operationId !== 'string' || !OPERATION_ID_PATTERN.test(operationId)) {
        throw invalid(`operation_id 形状非法: ${JSON.stringify(operationId)}`, '使用 $defs.id 允许的小写字母/数字/下划线/短横线形状');
    }
    return operationId;
}
function assertPhase(phase) {
    if (typeof phase !== 'string' || !OPERATION_PHASES.includes(phase)) {
        throw invalid(`未知操作阶段: ${JSON.stringify(phase)}`, `阶段只能取 ${OPERATION_PHASES.join('|')}`);
    }
    return phase;
}
function assertInputHash(inputHash) {
    if (typeof inputHash !== 'string' || !SHA256_PATTERN.test(inputHash)) {
        throw invalid(`规范化输入哈希必须是 64 位小写十六进制: ${JSON.stringify(inputHash)}`, '用 validate.operationInputHash() 计算输入哈希');
    }
    return inputHash;
}
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/**
 * 台账文件绝对路径。
 * @param root 已规范化的绝对根
 */
export function operationRecordPath(root, operationId) {
    assertOperationId(operationId);
    return join(root, ...OPERATIONS_DIR.split('/'), `${operationId}.json`);
}
/**
 * 创建绑定到某个项目根的 operation 台账。
 */
export function createOperationLedger(options = {}) {
    const { root } = options;
    if (typeof root !== 'string' || root.length === 0) {
        throw invalid('createOperationLedger 需要项目根', '传入 normalizeProjectRoot 的结果');
    }
    const clock = normalizeClock(options.clock);
    const recordPath = (operationId) => operationRecordPath(root, operationId);
    async function readRecord(operationId) {
        const filePath = recordPath(operationId);
        let text;
        try {
            text = await readFile(filePath, 'utf8');
        }
        catch (error) {
            if (thrownCode(error) === 'ENOENT')
                return null;
            throw recoveryRequired(`无法读取 operation 台账: ${operationId}（${thrownCode(error) ?? 'unknown'}）`, '确认项目内 re/team/operations 可读；台账异常时先核实再继续', { operation_id: operationId });
        }
        let parsed;
        try {
            parsed = JSON.parse(text);
        }
        catch {
            throw recoveryRequired(`operation 台账不是合法 JSON: ${operationId}`, '按恢复流程核实该操作的真实阶段与副作用，再决定是否继续；不要覆盖台账', { operation_id: operationId });
        }
        if (!isPlainObject(parsed) || parsed.operation_id !== operationId || typeof parsed.phase !== 'string') {
            throw recoveryRequired(`operation 台账内容与 operation_id 不符: ${operationId}`, '按恢复流程核实台账来源；不要覆盖台账', { operation_id: operationId });
        }
        // 已核对 operation_id/phase 这两个身份字段；其余字段是 writeRecord 写出的固定形状。
        return parsed;
    }
    async function writeRecord(record) {
        await writeJsonAtomic(recordPath(record.operation_id), record);
        return record;
    }
    /**
     * 登记（或恢复）一个操作。
     *
     * 同 ID 同哈希 → 返回既有台账（`resumed: true`），不追加历史；
     * 同 ID 不同哈希 → `OPERATION_CONFLICT`。
     *
     * @param inputHash 规范化输入的 SHA256
     * @param phase 初始阶段，默认 prepared
     * @param data 该阶段已保存的内容（契约/基准/尝试身份等）
     */
    async function prepare(operationId, inputHash, phase = 'prepared', data = {}) {
        assertOperationId(operationId);
        assertInputHash(inputHash);
        assertPhase(phase);
        const existing = await readRecord(operationId);
        if (existing !== null) {
            if (existing.input_hash !== inputHash) {
                throw new ContractError({
                    code: 'OPERATION_CONFLICT',
                    message: `同一 operation ID 的输入已改变: ${operationId}`,
                    nextStep: '同一 ID 必须保持原输入与 expected_revision；确实换了请求内容时请用新的 operation ID，不要改写既有台账',
                    details: {
                        operation_id: operationId,
                        input_hash: existing.input_hash,
                        conflicting_input_hash: inputHash,
                        phase: existing.phase,
                    },
                });
            }
            return { record: existing, resumed: true, replayed: false };
        }
        const at = clock.isoNow();
        const record = {
            schema_version: 1,
            operation_id: operationId,
            input_hash: inputHash,
            phase,
            created_at: at,
            updated_at: at,
            history: [{ phase, at }],
            data: isPlainObject(data) ? { ...data } : {},
            result: null,
        };
        await writeRecord(record);
        return { record, resumed: false, replayed: false };
    }
    /**
     * 按 ID 读取台账（不存在返回 null）。
     */
    async function findById(operationId) {
        assertOperationId(operationId);
        return readRecord(operationId);
    }
    /**
     * 推进阶段并把本步内容合并进台账（前序数据保留，便于恢复）。
     */
    async function advance(operationId, phase, data = {}) {
        assertOperationId(operationId);
        assertPhase(phase);
        const existing = await readRecord(operationId);
        if (existing === null) {
            throw recoveryRequired(`operation 台账不存在，不能推进阶段: ${operationId}`, '先 prepare 该 operation（同 ID 同哈希）再推进；不要凭空创建台账', { operation_id: operationId, phase });
        }
        const at = clock.isoNow();
        const record = {
            ...existing,
            phase,
            updated_at: at,
            history: [...existing.history, { phase, at }],
            data: { ...(isPlainObject(existing.data) ? existing.data : {}), ...(isPlainObject(data) ? data : {}) },
        };
        return writeRecord(record);
    }
    /**
     * 保存该操作的最终信封（供响应丢失后重放）。
     *
     * @param result result 信封
     */
    async function saveResult(operationId, result) {
        assertOperationId(operationId);
        if (!isPlainObject(result))
            throw invalid('saveResult 需要 result 信封对象', '传入 envelope.ok() 等构造的信封');
        const existing = await readRecord(operationId);
        if (existing === null) {
            throw recoveryRequired(`operation 台账不存在，不能保存结果: ${operationId}`, '先 prepare 该 operation 再保存结果', { operation_id: operationId });
        }
        const record = { ...existing, result, updated_at: clock.isoNow() };
        return writeRecord(record);
    }
    /**
     * 重放已保存的结果：返回原信封并标记 `replayed=true`；尚未保存结果时返回 null。
     */
    async function replayResult(operationId) {
        assertOperationId(operationId);
        const record = await readRecord(operationId);
        if (record === null || !isPlainObject(record.result))
            return null;
        // 台账里的 result 只可能由本模块的 saveResult() 写入，而它只接受 envelope.* 构造的信封；
        // 读回来的 JSON 就是当初那个八字段对象，因此这里按 `$defs.result` 用（不重排、不补字段）。
        // 双断言是必要的：`OperationRecord.result` 声明为 `unknown`，先收成信封形状再展开。
        const stored = record.result;
        return { ...stored, replayed: true };
    }
    return { prepare, findById, advance, saveResult, replayResult, recordPath };
}
