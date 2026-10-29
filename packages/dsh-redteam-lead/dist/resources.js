/**
 * T6 资源租用与隔离：`re/team/resources.json`。
 *
 * 契约（编排契约「路径、锁与资源」，验收 A22/A33）：
 *
 * - 资源记录每项含 `resource_key`、`physical_identity`、`mode`、owner（dispatch/attempt）、
 *   `generation`、`state`、`recovery_ref`。
 * - **检查和租用必须在项目锁内完成**（由调用方持 `re/team/lock`；本模块只做读-改-写）。
 * - 相同物理实例的别名归一为同一 `resource_key`；**默认独占**，只有登记为不可变读取
 *   且无状态写才 `shared_read`（未登记时降级为独占并给一条非阻塞 gap）。
 * - 未知实例或缺映射 → `RESOURCE_BINDING_MISSING`；冲突 → `RESOURCE_BUSY`。
 * - `quarantined` 的资源不可再分配：恢复依据（`recovery_ref`）核实后先 `release`，
 *   才允许新的 generation。
 * - 同一 dispatch/attempt 重复租用是幂等的（重入不产生第二份租约、不涨代次）。
 *
 * `resources.json` 形状（本模块的权威形状，项目/操作者也可以手写 `aliases`）：
 *
 * ```json
 * {
 *   "schema_version": 1,
 *   "revision": 3,
 *   "aliases": { "<别名或 resource_key>": { "physical_identity": "pid:4242", "immutable_read": false } },
 *   "leases": [
 *     { "resource_key": "...", "physical_identity": "...", "mode": "exclusive",
 *       "dispatch_id": "D-...", "attempt_id": "A-000001", "generation": 1,
 *       "state": "reserved", "recovery_ref": null, "acquired_at": "..." }
 *   ]
 * }
 * ```
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ContractError } from './errors.js';
import { thrownCode } from './guards.js';
/** 项目内资源记录路径（统一 `/`）。 */
export const RESOURCES_PATH = 're/team/resources.json';
/** 资源模式闭集（`$defs.resource.mode`）。 */
export const RESOURCE_MODES = Object.freeze(['shared_read', 'exclusive']);
/** 资源状态闭集（编排契约）。 */
export const RESOURCE_STATES = Object.freeze(['reserved', 'held', 'quarantined', 'released']);
const NEXT_STEP_BINDING = '在 re/team/resources.json 的 aliases 里登记该实例的物理身份（physical_identity），再做派发';
const NEXT_STEP_BUSY = '等当前租用结束或核实旧副作用后按恢复流程释放；quarantined 资源必须先走 release + recovery_ref';
function nonEmpty(value) {
    return typeof value === 'string' && value.trim().length > 0;
}
function invalid(message, nextStep) {
    return new ContractError({ code: 'INVALID_ARGUMENT', message, nextStep });
}
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** 空注册表。 */
export function emptyRegistry() {
    return { schema_version: 1, revision: 0, aliases: {}, leases: [] };
}
/**
 * 过滤一条租约条目：四个必填字段必须是字符串且落在闭集里。
 *
 * 与原 `.filter(...)` 的判定逐字等价（`includes` 对非字符串本来就返回 false）。
 */
function isLeaseEntry(value) {
    return isPlainObject(value)
        && nonEmpty(value.resource_key)
        && nonEmpty(value.physical_identity)
        && typeof value.mode === 'string' && RESOURCE_MODES.includes(value.mode)
        && typeof value.state === 'string' && RESOURCE_STATES.includes(value.state);
}
/**
 * 归一 `resource_needs`：按 `resource_key` 去重，同一 key 取**更严**的模式（exclusive 胜）。
 *
 * @param {unknown} needs `$defs.resource[]`
 * @returns {{ ok: boolean, needs: Array<{resource_key: string, mode: string}>, issues: object[] }}
 */
export function normalizeResourceNeeds(needs) {
    if (needs === undefined || needs === null)
        return { ok: true, needs: [], issues: [] };
    if (!Array.isArray(needs)) {
        return {
            ok: false,
            needs: [],
            issues: [{ code: 'INVALID_ARGUMENT', reason: 'resource_needs 必须是数组', next_step: '传 [{resource_key, mode}] 数组' }],
        };
    }
    const issues = [];
    const byKey = new Map();
    // `Array.isArray` 收窄给的是 `any[]`；这里落到 `unknown[]` 再逐项判形状。
    const needsList = needs;
    for (const [index, raw] of needsList.entries()) {
        if (!isPlainObject(raw)) {
            issues.push({
                code: 'INVALID_ARGUMENT',
                reason: `resource_needs[${index}] 必须是对象`,
                next_step: '每项形如 {resource_key, mode}',
            });
            continue;
        }
        const key = raw.resource_key;
        if (!nonEmpty(key)) {
            issues.push({
                code: 'INVALID_ARGUMENT',
                reason: `resource_needs[${index}].resource_key 必须是非空字符串`,
                next_step: '给出要租用的资源标识（同一物理实例用同一个 key）',
            });
            continue;
        }
        const mode = raw.mode;
        if (typeof mode !== 'string' || !RESOURCE_MODES.includes(mode)) {
            issues.push({
                code: 'INVALID_ARGUMENT',
                reason: `resource_needs[${index}].mode 必须是 ${RESOURCE_MODES.join('|')}，实际 ${JSON.stringify(mode)}`,
                next_step: '默认用 exclusive；只有登记为不可变读取的资源才可用 shared_read',
            });
            continue;
        }
        const existing = byKey.get(key);
        if (existing === undefined)
            byKey.set(key, { resource_key: key, mode });
        else if (mode === 'exclusive')
            existing.mode = 'exclusive';
    }
    return { ok: issues.length === 0, needs: [...byKey.values()], issues };
}
/**
 * 注册表归一（容忍手写的最小形状，也接受字符串别名）。
 * @param {unknown} raw
 */
export function normalizeRegistry(raw) {
    const registry = emptyRegistry();
    if (!isPlainObject(raw))
        return registry;
    const revision = raw.revision;
    if (typeof revision === 'number' && Number.isInteger(revision) && revision >= 0)
        registry.revision = revision;
    if (isPlainObject(raw.aliases)) {
        for (const [key, value] of Object.entries(raw.aliases)) {
            if (!nonEmpty(key))
                continue;
            if (typeof value === 'string' && nonEmpty(value)) {
                registry.aliases[key] = { physical_identity: value, immutable_read: false };
                continue;
            }
            if (isPlainObject(value) && nonEmpty(value.physical_identity)) {
                registry.aliases[key] = {
                    physical_identity: value.physical_identity,
                    immutable_read: value.immutable_read === true,
                };
            }
        }
    }
    if (Array.isArray(raw.leases)) {
        const rawLeases = raw.leases;
        registry.leases = rawLeases
            .filter(isLeaseEntry)
            .map((lease) => ({
            resource_key: lease.resource_key,
            physical_identity: lease.physical_identity,
            mode: lease.mode,
            dispatch_id: nonEmpty(lease.dispatch_id) ? lease.dispatch_id : null,
            attempt_id: nonEmpty(lease.attempt_id) ? lease.attempt_id : null,
            generation: typeof lease.generation === 'number' && Number.isInteger(lease.generation) && lease.generation > 0 ? lease.generation : 1,
            state: lease.state,
            recovery_ref: nonEmpty(lease.recovery_ref) ? lease.recovery_ref : null,
            acquired_at: nonEmpty(lease.acquired_at) ? lease.acquired_at : null,
        }));
    }
    return registry;
}
/**
 * 解析一个 resource_key 的物理身份。
 *
 * 别名表优先；其次用既有租约里已记录的物理身份（同一 key 的自洽历史）。
 * 都查不到 → `RESOURCE_BINDING_MISSING`（未知实例不能凭空独占）。
 *
 * @param {object} registry
 * @param {string} resourceKey
 */
export function resolveResource(registry, resourceKey) {
    const alias = registry?.aliases?.[resourceKey];
    if (alias && nonEmpty(alias.physical_identity)) {
        return {
            ok: true,
            resource_key: resourceKey,
            physical_identity: alias.physical_identity,
            immutable_read: alias.immutable_read === true,
            source: 'alias',
        };
    }
    const known = (registry?.leases ?? []).find((lease) => lease.resource_key === resourceKey);
    if (known !== undefined) {
        return {
            ok: true,
            resource_key: resourceKey,
            physical_identity: known.physical_identity,
            immutable_read: false,
            source: 'lease',
        };
    }
    return {
        ok: false,
        code: 'RESOURCE_BINDING_MISSING',
        resource_key: resourceKey,
        reason: `资源 ${resourceKey} 没有登记物理身份，无法判断是不是同一实例`,
        next_step: NEXT_STEP_BINDING,
    };
}
function maxGeneration(leases, physicalIdentity) {
    let max = 0;
    for (const lease of leases) {
        if (lease.physical_identity !== physicalIdentity)
            continue;
        if (lease.generation > max)
            max = lease.generation;
    }
    return max;
}
/**
 * 纯规划：决定本次派发要新增/复用哪些租约，或为什么不能。
 *
 * @param {{ registry: object, needs: Array<{resource_key: string, mode: string}>,
 *           dispatchId: string, attemptId: string, now?: string }} input
 * @returns {{ ok: true, leases: object[], reservations: object[], reused: boolean,
 *             gaps: object[] }
 *           | { ok: false, code: string, diagnostics: object[], conflicts?: object[] }}
 */
export function planReservations({ registry, needs, dispatchId, attemptId, now }) {
    const acquiredAt = nonEmpty(now) ? now : new Date().toISOString();
    const leases = (registry?.leases ?? []).map((lease) => ({ ...lease }));
    const reservations = [];
    const gaps = [];
    const conflicts = [];
    let allReused = true;
    for (const need of Array.isArray(needs) ? needs : []) {
        const resolved = resolveResource(registry, need.resource_key);
        if (!resolved.ok) {
            return {
                ok: false,
                code: 'RESOURCE_BINDING_MISSING',
                conflicts: [],
                diagnostics: [{
                        code: 'RESOURCE_BINDING_MISSING',
                        reason: resolved.reason,
                        next_step: resolved.next_step,
                    }],
            };
        }
        let mode = 'exclusive';
        if (need.mode === 'shared_read' && resolved.immutable_read === true) {
            mode = 'shared_read';
        }
        else if (need.mode === 'shared_read') {
            gaps.push({
                code: 'RESOURCE_MODE_DOWNGRADED',
                reason: `资源 ${need.resource_key} 未登记为不可变读取，shared_read 降级为独占`,
                next_step: '确属不可变读取时在 resources.json 里登记 immutable_read:true；否则按独占使用',
            });
        }
        const own = leases.find((lease) => lease.resource_key === need.resource_key
            && lease.dispatch_id === dispatchId
            && lease.attempt_id === attemptId
            && lease.state !== 'released');
        if (own !== undefined) {
            reservations.push({ resource_key: need.resource_key, physical_identity: own.physical_identity, mode: own.mode, generation: own.generation, reused: true });
            continue;
        }
        allReused = false;
        const active = leases.filter((lease) => lease.physical_identity === resolved.physical_identity
            && lease.state !== 'released');
        const quarantined = active.find((lease) => lease.state === 'quarantined');
        if (quarantined !== undefined) {
            conflicts.push({
                resource_key: need.resource_key,
                physical_identity: resolved.physical_identity,
                holder: quarantined.dispatch_id,
                state: quarantined.state,
                recovery_ref: quarantined.recovery_ref ?? null,
                reason: `资源 ${need.resource_key}（物理实例 ${resolved.physical_identity}）处于 quarantined，未核实恢复前不得再分配`,
                next_step: NEXT_STEP_BUSY,
            });
            continue;
        }
        const blocking = active.find((lease) => lease.mode === 'exclusive' || mode === 'exclusive');
        if (blocking !== undefined) {
            conflicts.push({
                resource_key: need.resource_key,
                physical_identity: resolved.physical_identity,
                holder: blocking.dispatch_id,
                state: blocking.state,
                reason: `资源 ${need.resource_key}（物理实例 ${resolved.physical_identity}）已被 ${blocking.dispatch_id ?? '未知 dispatch'}/${blocking.attempt_id ?? '?'} 以 ${blocking.mode} 占用`,
                next_step: NEXT_STEP_BUSY,
            });
            continue;
        }
        const lease = {
            resource_key: need.resource_key,
            physical_identity: resolved.physical_identity,
            mode,
            dispatch_id: dispatchId,
            attempt_id: attemptId,
            generation: maxGeneration(leases, resolved.physical_identity) + 1,
            state: 'reserved',
            recovery_ref: null,
            acquired_at: acquiredAt,
        };
        leases.push(lease);
        reservations.push({ resource_key: lease.resource_key, physical_identity: lease.physical_identity, mode, generation: lease.generation, reused: false });
    }
    if (conflicts.length > 0) {
        return {
            ok: false,
            code: 'RESOURCE_BUSY',
            conflicts,
            diagnostics: conflicts.map((conflict) => ({
                code: 'RESOURCE_BUSY',
                reason: conflict.reason,
                next_step: conflict.next_step,
            })),
        };
    }
    return { ok: true, leases, reservations, reused: allReused, gaps };
}
/**
 * 读取注册表。文件缺失 → 空注册表；JSON 损坏/形状不对 → `RECOVERY_REQUIRED`
 * （不能当作「没有资源」继续租用）。
 *
 * @param {string} root 已规范化的绝对根
 * @returns {Promise<object>}
 */
export async function readRegistry(root) {
    const file = join(root, ...RESOURCES_PATH.split('/'));
    let text;
    try {
        text = await readFile(file, 'utf8');
    }
    catch (error) {
        if (thrownCode(error) === 'ENOENT')
            return emptyRegistry();
        throw new ContractError({
            code: 'RECOVERY_REQUIRED',
            message: `无法读取 ${RESOURCES_PATH}（${thrownCode(error) ?? 'unknown'}）`,
            nextStep: '确认项目根可读；资源记录异常时先按恢复流程核实，不要当作没有资源继续租用',
        });
    }
    if (text.trim().length === 0)
        return emptyRegistry();
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        throw new ContractError({
            code: 'RECOVERY_REQUIRED',
            message: `${RESOURCES_PATH} 不是合法 JSON`,
            nextStep: '按恢复流程核对资源归属与副作用后修复该文件；不要当作没有资源继续租用',
            details: { path: RESOURCES_PATH },
        });
    }
    if (!isPlainObject(parsed)) {
        throw new ContractError({
            code: 'RECOVERY_REQUIRED',
            message: `${RESOURCES_PATH} 必须是 JSON 对象`,
            nextStep: '按恢复流程核对资源归属后修复该文件',
            details: { path: RESOURCES_PATH },
        });
    }
    return normalizeRegistry(parsed);
}
async function writeRegistry(root, registry, atomic) {
    const file = join(root, ...RESOURCES_PATH.split('/'));
    const payload = {
        schema_version: 1,
        revision: registry.revision,
        aliases: registry.aliases,
        leases: registry.leases,
    };
    await atomic.writeJsonAtomic(file, payload);
    return payload;
}
/**
 * 在**项目锁内**检查并租用资源。冲突/缺映射时**不落盘**。
 *
 * @param {{ root: string, needs: unknown, dispatchId: string, attemptId: string,
 *           clock?: { isoNow?: () => string }, atomic: object, now?: string }} input
 */
export async function reserveResources(input) {
    const { root, needs, dispatchId, attemptId, clock, atomic } = input;
    const normalized = normalizeResourceNeeds(needs);
    if (!normalized.ok) {
        return {
            ok: false,
            code: 'INVALID_ARGUMENT',
            issues: normalized.issues,
            diagnostics: normalized.issues.map((issue) => ({
                code: issue.code,
                reason: issue.reason,
                next_step: issue.next_step,
            })),
        };
    }
    if (normalized.needs.length === 0) {
        return { ok: true, leases: [], reservations: [], reused: true, gaps: [], revision: null };
    }
    const registry = await readRegistry(root);
    const now = nonEmpty(input.now)
        ? input.now
        : (typeof clock?.isoNow === 'function' ? clock.isoNow() : new Date().toISOString());
    const planned = planReservations({ registry, needs: normalized.needs, dispatchId, attemptId, now });
    if (!planned.ok)
        return planned;
    if (planned.reused) {
        return {
            ok: true,
            leases: planned.reservations.map((reservation) => ({ ...reservation, state: 'reserved' })),
            reservations: planned.reservations,
            reused: true,
            gaps: planned.gaps,
            revision: registry.revision,
        };
    }
    const next = {
        ...registry,
        revision: registry.revision + 1,
        leases: planned.leases,
    };
    await writeRegistry(root, next, atomic);
    return {
        ok: true,
        leases: planned.reservations.map((reservation) => ({ ...reservation, state: 'reserved' })),
        reservations: planned.reservations,
        reused: false,
        gaps: planned.gaps,
        revision: next.revision,
    };
}
function leasesOwnedBy(registry, dispatchId, attemptId) {
    return registry.leases.filter((lease) => lease.dispatch_id === dispatchId
        && lease.attempt_id === attemptId
        && lease.state !== 'released');
}
/**
 * 释放某个 dispatch/attempt 名下的全部租约（只动自己的）。
 *
 * @param {{ root: string, dispatchId: string, attemptId: string, atomic: object,
 *           clock?: object, note?: string }} input
 */
export async function releaseResources(input) {
    const { root, dispatchId, attemptId, atomic } = input;
    const registry = await readRegistry(root);
    const owned = leasesOwnedBy(registry, dispatchId, attemptId);
    if (owned.length === 0)
        return { ok: true, released: [], revision: registry.revision };
    const acquiredAt = typeof input.clock?.isoNow === 'function' ? input.clock.isoNow() : new Date().toISOString();
    const releasedKeys = new Set(owned.map((lease) => `${lease.resource_key}@${lease.generation}`));
    const leases = registry.leases.map((lease) => (releasedKeys.has(`${lease.resource_key}@${lease.generation}`)
        ? {
            ...lease,
            state: 'released',
            released_at: acquiredAt,
            recovery_ref: nonEmpty(input.recoveryRef) ? input.recoveryRef : lease.recovery_ref,
            ...(nonEmpty(input.note) ? { note: input.note } : {}),
        }
        : lease));
    const next = { ...registry, revision: registry.revision + 1, leases };
    await writeRegistry(root, next, atomic);
    return {
        ok: true,
        released: owned.map((lease) => ({ resource_key: lease.resource_key, generation: lease.generation })),
        revision: next.revision,
    };
}
/**
 * 把某个 dispatch/attempt 的资源置为 `quarantined`（失败/中断/失联，A22/A33）。
 * 必须给恢复依据（`recovery_ref`），否则只能是普通 `release`。
 */
export async function quarantineResources(input) {
    const { root, dispatchId, attemptId, recoveryRef, atomic } = input;
    if (!nonEmpty(recoveryRef)) {
        throw invalid('quarantine 必须提供 recovery_ref（恢复核查记录的项目内路径）', '先保存恢复记录，再隔离资源');
    }
    const registry = await readRegistry(root);
    const owned = leasesOwnedBy(registry, dispatchId, attemptId);
    if (owned.length === 0)
        return { ok: true, quarantined: [], revision: registry.revision };
    const at = typeof input.clock?.isoNow === 'function' ? input.clock.isoNow() : new Date().toISOString();
    const keys = new Set(owned.map((lease) => `${lease.resource_key}@${lease.generation}`));
    const leases = registry.leases.map((lease) => (keys.has(`${lease.resource_key}@${lease.generation}`)
        ? { ...lease, state: 'quarantined', recovery_ref: recoveryRef, quarantined_at: at }
        : lease));
    const next = { ...registry, revision: registry.revision + 1, leases };
    await writeRegistry(root, next, atomic);
    return {
        ok: true,
        quarantined: owned.map((lease) => ({ resource_key: lease.resource_key, generation: lease.generation })),
        revision: next.revision,
    };
}
