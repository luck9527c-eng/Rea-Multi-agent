// 能力族解析与能力匹配（纯函数）。
//
// 输入全部显式：需求名、执行者实际注册的完整工具名、工具清单快照、项目能力绑定。
// 不读宿主注册表、不猜 provider 归属、不把族名/插件 ID/子串/前缀当成命中。
import { defaultCatalog } from './catalog.js';
import { isRecord, recordOf } from './guards.js';
const COMBINATORS = ['any_tool', 'any_provider', 'all_capabilities'];
const PROVIDER_FIELDS = [
    'tool_id',
    'entrypoint_id',
    'inventory_revision',
    'snapshot_ref',
    'snapshot_sha256',
    'transport_tools',
    'invocation_ref',
    'readiness_ref',
    'resource_needs',
];
// 越具体的失败越先报告：环/非法绑定 > 未知族 > 未就绪 > 缺通道。
const CODE_PRIORITY = {
    INVALID_ARGUMENT: 3,
    UNKNOWN_CAPABILITY: 2,
    CAPABILITY_NOT_READY: 1,
    CAPABILITY_MISSING: 0,
};
const NEXT_STEP_DEFAULT = '按岗位要求补齐执行者可用的完整工具名，或在 re/team/capabilities.json 登记可核验的 provider';
const NEXT_STEP_BINDING = '在 re/team/capabilities.json 为该能力族登记 any_tool / any_provider / all_capabilities 之一';
function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}
/** 数组判断（`Array.isArray` 的谓词版本，收窄成 `unknown[]` 而不是 `any[]`）。 */
function isArray(value) {
    return Array.isArray(value);
}
/** 非空字符串数组（`every(isNonEmptyString)` 的谓词版本；判定与迁移前逐字一致）。 */
function isStringArray(value) {
    return Array.isArray(value) && value.every((item) => isNonEmptyString(item));
}
/** `Set.has` 只对字符串有意义；非字符串一律视为「未注册」（与 `has(非字符串) === false` 等价）。 */
function hasTool(toolNames, name) {
    return typeof name === 'string' ? toolNames.has(name) : false;
}
function isMcpNamespace(name) {
    return typeof name === 'string' && /^mcp:.+$/.test(name);
}
function familiesOf(bindings) {
    const record = isRecord(bindings) ? bindings : {};
    const families = record.families;
    if (isRecord(families) && !Array.isArray(families)) {
        return families;
    }
    return {};
}
function missingEntry(capability, code, reason, nextStep, missingCapabilities = [capability]) {
    return {
        capability,
        code,
        reason,
        next_step: nextStep,
        missing_capabilities: missingCapabilities,
    };
}
function worstCode(entries) {
    let worst = 'CAPABILITY_MISSING';
    for (const entry of entries) {
        if ((CODE_PRIORITY[entry.code] ?? 0) > (CODE_PRIORITY[worst] ?? 0))
            worst = entry.code;
    }
    return worst;
}
function cloneProvider(provider) {
    // 调用点已通过 checkProvider 的结构核验（transport_tools 是非空数组），此处的兜底只影响类型。
    const transportTools = isArray(provider.transport_tools) ? provider.transport_tools : [];
    return {
        tool_id: provider.tool_id,
        entrypoint_id: provider.entrypoint_id,
        inventory_revision: provider.inventory_revision,
        snapshot_ref: provider.snapshot_ref,
        snapshot_sha256: provider.snapshot_sha256,
        transport_tools: [...transportTools],
        invocation_ref: provider.invocation_ref,
        readiness_ref: provider.readiness_ref,
        resource_needs: structuredClone(provider.resource_needs),
    };
}
/**
 * 校验一条 any_provider 登记是否在结构上可核验、且执行者能用。
 * 只做结构性判断：不启动程序、不判断目标是否就绪。
 */
function checkProvider(provider, toolNames, inventory) {
    if (!isRecord(provider) || Array.isArray(provider)) {
        return { ok: false, code: 'CAPABILITY_MISSING', reason: 'provider 必须是对象' };
    }
    const absent = PROVIDER_FIELDS.filter((field) => provider[field] === undefined);
    if (absent.length > 0) {
        return {
            ok: false,
            code: 'CAPABILITY_MISSING',
            reason: `provider 记录缺少字段：${absent.join(', ')}`,
        };
    }
    if (!isNonEmptyString(provider.tool_id)) {
        return { ok: false, code: 'CAPABILITY_MISSING', reason: 'provider.tool_id 必须是非空字符串' };
    }
    if (!isNonEmptyString(provider.entrypoint_id)) {
        return { ok: false, code: 'CAPABILITY_MISSING', reason: 'provider.entrypoint_id 必须是非空字符串' };
    }
    if (!isNonEmptyString(provider.snapshot_ref) || !isNonEmptyString(provider.invocation_ref)
        || !isNonEmptyString(provider.readiness_ref)) {
        return {
            ok: false,
            code: 'CAPABILITY_MISSING',
            reason: 'provider 的 snapshot_ref/invocation_ref/readiness_ref 必须是非空路径',
        };
    }
    if (provider.inventory_revision === null || provider.inventory_revision === undefined
        || (typeof provider.inventory_revision !== 'number'
            && !isNonEmptyString(provider.inventory_revision))) {
        return { ok: false, code: 'CAPABILITY_MISSING', reason: 'provider.inventory_revision 缺失或类型不对' };
    }
    if (typeof provider.snapshot_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(provider.snapshot_sha256)) {
        return { ok: false, code: 'CAPABILITY_MISSING', reason: 'provider.snapshot_sha256 必须是 64 位小写 sha256' };
    }
    if (!Array.isArray(provider.transport_tools) || provider.transport_tools.length === 0
        || !provider.transport_tools.every(isNonEmptyString)) {
        return {
            ok: false,
            code: 'CAPABILITY_MISSING',
            reason: 'provider.transport_tools 必须是非空工具名数组',
        };
    }
    if (!Array.isArray(provider.resource_needs)) {
        return { ok: false, code: 'CAPABILITY_MISSING', reason: 'provider.resource_needs 必须是数组' };
    }
    if (!isRecord(inventory)) {
        return {
            ok: false,
            code: 'CAPABILITY_NOT_READY',
            reason: '缺少工具清单快照，无法核验 provider 的 tool/entrypoint 归属',
        };
    }
    if (inventory.inventory_revision !== provider.inventory_revision) {
        return {
            ok: false,
            code: 'CAPABILITY_NOT_READY',
            reason: `provider.inventory_revision=${provider.inventory_revision} 与清单 revision=${inventory.inventory_revision} 不一致`,
        };
    }
    if (inventory.snapshot_sha256 !== undefined && inventory.snapshot_sha256 !== provider.snapshot_sha256) {
        return {
            ok: false,
            code: 'CAPABILITY_NOT_READY',
            reason: 'provider.snapshot_sha256 与清单快照哈希不一致',
        };
    }
    const inventoryTools = inventory.tools;
    if (!isArray(inventoryTools)) {
        return {
            ok: false,
            code: 'CAPABILITY_NOT_READY',
            reason: '工具清单缺少 tools 数组，无法核验 provider 归属',
        };
    }
    const tools = inventoryTools.map((item) => recordOf(item));
    const tool = tools.find((item) => item.id === provider.tool_id);
    if (!tool) {
        return {
            ok: false,
            code: 'CAPABILITY_NOT_READY',
            reason: `工具清单 ${inventory.inventory_revision} 中找不到 tool_id=${provider.tool_id}`,
        };
    }
    const entrypointsWire = tool.entrypoints;
    if (!isArray(entrypointsWire)) {
        return {
            ok: false,
            code: 'CAPABILITY_NOT_READY',
            reason: `工具 ${provider.tool_id} 在清单中没有 entrypoints，无法核验 entrypoint_id`,
        };
    }
    const entrypoints = entrypointsWire.map((entry) => recordOf(entry));
    if (!entrypoints.some((entry) => entry.id === provider.entrypoint_id)) {
        return {
            ok: false,
            code: 'CAPABILITY_NOT_READY',
            reason: `工具 ${provider.tool_id} 的清单里没有 entrypoint_id=${provider.entrypoint_id}`,
        };
    }
    const transportTools = isArray(provider.transport_tools) ? provider.transport_tools : [];
    const missingTransport = transportTools.filter((name) => !hasTool(toolNames, name));
    if (missingTransport.length > 0) {
        return {
            ok: false,
            code: 'CAPABILITY_MISSING',
            reason: `执行者注册表缺少 transport_tools：${missingTransport.join(', ')}`,
        };
    }
    return { ok: true, provider: cloneProvider(provider) };
}
/**
 * 从一个条目里读工具名：`{name}`（宿主 schema 的真实形状）或 `{function:{name}}` 变体。
 * 认不出来 → null（调用方丢弃这一项；字符串元素不算条目）。
 */
function toolNameOfEntry(entry) {
    if (!isRecord(entry) || Array.isArray(entry))
        return null;
    if (isNonEmptyString(entry.name))
        return entry.name;
    const fn = entry.function;
    if (isRecord(fn) && !Array.isArray(fn) && isNonEmptyString(fn.name))
        return fn.name;
    return null;
}
/** 去重 + 排序，作为 `toolNamesFromSchemas()` 的稳定输出。 */
function sortedNames(candidates) {
    const names = new Set();
    for (const candidate of candidates) {
        if (candidate !== null)
            names.add(candidate);
    }
    return [...names].sort();
}
/**
 * 是否实现了迭代协议（`Set`/generator/自定义可迭代）。
 *
 * 用 `Reflect.get` 读 `Symbol.iterator`：`Record<string, unknown>` 没有符号索引签名，
 * 直接 `value[Symbol.iterator]` 在 strict 下读不出来。
 */
function isIterable(value) {
    return isRecord(value) && typeof Reflect.get(value, Symbol.iterator) === 'function';
}
/**
 * `tools.schemas(agent)` 的返回值 → 完整工具名集合（去重、排序）。
 *
 * 宿主真实形状是**schema 对象数组**（`_dsh-tools.js` 的 `schemas(scope)` 对每个可见定义
 * 调 `schemaOf()`，名字在元素的 `.name` 上）。旧实现对这个返回值做 `Object.keys()`，
 * 数组上只会得到 `["0","1",…]`：能力族永远判缺失，真会话里任何派发都被 `CAPABILITY_MISSING`
 * 拒（T15）。因此这里的规则是「先按条目取名字，再谈容器」：
 *
 * 1. 值本身就是一个条目（`{name}` / `{function:{name}}`，即单个 schema）→ 单个名字；
 * 2. 数组 → 逐个元素取 `.name`（**绝不** `Object.keys` 数组）；
 * 3. 任意可迭代（`Set`/generator…）→ 逐项取 `.name`；
 * 4. 按名字为键的对象（测试替身与旧形状）→ 键；
 * 5. 其余（null/数字/字符串/没有名字的条目）→ 空集：保持「未核对」降级语义，**不抛**。
 *
 * 空集有两种含义（零个可见工具 / 认不出来的形状），由调用方按容器形状区分，见
 * `roster.ts` 的 `toolsFor()`。
 *
 * @param schemas `ctx.services.tools.schemas(agent)` 的原始返回值（未知形状）
 * @returns 去重并排序的完整工具名
 */
export function toolNamesFromSchemas(schemas) {
    const direct = toolNameOfEntry(schemas);
    if (direct !== null)
        return [direct];
    if (Array.isArray(schemas))
        return sortedNames(schemas.map((entry) => toolNameOfEntry(entry)));
    if (isIterable(schemas))
        return sortedNames([...schemas].map((entry) => toolNameOfEntry(entry)));
    if (isRecord(schemas))
        return sortedNames(Object.keys(schemas));
    return [];
}
/**
 * 能力匹配纯函数。
 *
 * @param needs 岗位 required 与任务 capability_needs 的并集（可含 mcp:<server>）
 * @param toolNames 实际执行者注册的完整工具名
 * @param inventory re/env/tools.json 的快照内容
 * @param bindings re/team/capabilities.json 内容
 */
export function matchCapabilities(needs, toolNames, inventory, bindings) {
    const catalog = defaultCatalog();
    const toolSet = new Set(isArray(toolNames) ? toolNames.filter(isNonEmptyString) : []);
    const families = familiesOf(bindings);
    const matched = [];
    const missing = [];
    const providers = [];
    const stack = [];
    function definitionFor(name) {
        // 族的“已知性”只来自岗位目录或 mcp:<server> 动态命名空间。
        // 项目绑定只能覆盖已知族，不能凭空制造能力族。
        if (!Object.hasOwn(catalog.capabilities, name) && !isMcpNamespace(name)) {
            return {
                error: missingEntry(name, 'UNKNOWN_CAPABILITY', `未知能力族 ${name}：岗位目录与项目绑定里都没有该族`, '检查岗位目录/绑定拼写；未知族不能当作可执行能力'),
            };
        }
        if (Object.hasOwn(families, name)) {
            const definition = families[name];
            if (!isRecord(definition)) {
                return {
                    error: missingEntry(name, 'INVALID_ARGUMENT', `能力族 ${name} 的绑定不是对象`, NEXT_STEP_BINDING),
                };
            }
            const view = definition;
            const present = COMBINATORS.filter((key) => view[key] !== undefined);
            if (present.length !== 1) {
                return {
                    error: missingEntry(name, 'INVALID_ARGUMENT', `能力族 ${name} 的绑定必须且只能声明 any_tool/any_provider/all_capabilities 之一，实际：${present.join(',') || '无'}`, NEXT_STEP_BINDING),
                };
            }
            return { definition: view, source: 'binding' };
        }
        if (Object.hasOwn(catalog.capabilities, name)) {
            return { definition: catalog.capabilities[name], source: 'catalog' };
        }
        if (isMcpNamespace(name)) {
            return {
                error: missingEntry(name, 'CAPABILITY_MISSING', `${name} 未绑定：动态命名空间必须在 re/team/capabilities.json 显式登记 server 与工具集合`, NEXT_STEP_BINDING),
            };
        }
        return { error: missingEntry(name, 'UNKNOWN_CAPABILITY', `未知能力族 ${name}`, NEXT_STEP_BINDING) };
    }
    function resolve(name) {
        if (stack.includes(name)) {
            return {
                ok: false,
                code: 'INVALID_ARGUMENT',
                reason: `能力组合存在环：${[...stack, name].join(' → ')}`,
                next_step: NEXT_STEP_BINDING,
                missing_capabilities: [name],
            };
        }
        const found = definitionFor(name);
        if ('error' in found)
            return { ok: false, ...found.error };
        const definition = found.definition;
        const combinator = COMBINATORS.find((key) => definition[key] !== undefined);
        // `COMBINATORS` 里找不到时，JS 把 `definition[undefined]` 当作 `definition['undefined']`
        // （结果为 undefined，落到下面的 any_provider 校验）；这里保留同一语义，不做硬断言。
        const value = combinator === undefined ? definition['undefined'] : definition[combinator];
        const bindingRequired = found.source === 'catalog' && definition.binding_required === true;
        if (combinator === 'any_tool') {
            if (!isStringArray(value)) {
                return {
                    ok: false,
                    code: 'INVALID_ARGUMENT',
                    reason: `能力族 ${name} 的 any_tool 必须是精确工具名数组`,
                    next_step: NEXT_STEP_BINDING,
                    missing_capabilities: [name],
                };
            }
            const hit = value.find((alias) => toolSet.has(alias));
            if (hit) {
                return { ok: true, entry: { capability: name, via: 'any_tool', tool: hit }, providers: [] };
            }
            if (value.length === 0) {
                return {
                    ok: false,
                    code: 'CAPABILITY_MISSING',
                    reason: `能力族 ${name} 没有任何默认工具名${bindingRequired ? '且必须在 re/team/capabilities.json 显式登记精确绑定' : ''}，未登记即缺口`,
                    next_step: `为能力族 ${name} 登记精确工具名或可核验 provider`,
                    missing_capabilities: [name],
                };
            }
            return {
                ok: false,
                code: 'CAPABILITY_MISSING',
                reason: `能力族 ${name} 需要完整工具名之一：${value.join(', ')}；执行者注册表中没有精确匹配`,
                next_step: NEXT_STEP_DEFAULT,
                missing_capabilities: [name],
            };
        }
        if (combinator === 'all_capabilities') {
            if (!isStringArray(value) || value.length === 0) {
                return {
                    ok: false,
                    code: 'INVALID_ARGUMENT',
                    reason: `能力族 ${name} 的 all_capabilities 必须是非空能力名数组`,
                    next_step: NEXT_STEP_BINDING,
                    missing_capabilities: [name],
                };
            }
            stack.push(name);
            const parts = [];
            const failures = [];
            const childProviders = [];
            for (const child of value) {
                const result = resolve(child);
                if (result.ok) {
                    parts.push(result.entry);
                    childProviders.push(...(result.providers ?? []));
                }
                else {
                    failures.push({ child, ...result });
                }
            }
            stack.pop();
            if (failures.length === 0) {
                return {
                    ok: true,
                    entry: { capability: name, via: 'all_capabilities', parts },
                    providers: childProviders,
                };
            }
            const reason = `能力族 ${name} 需要全部满足：${value.join(', ')}；缺少：${failures
                .map((failure) => `${failure.child}（${failure.reason}）`)
                .join('；')}`;
            const flattened = [];
            for (const failure of failures) {
                for (const leaf of failure.missing_capabilities ?? [failure.child]) {
                    if (!flattened.includes(leaf))
                        flattened.push(leaf);
                }
            }
            return {
                ok: false,
                code: worstCode(failures),
                reason,
                next_step: failures[0].next_step ?? NEXT_STEP_DEFAULT,
                missing_capabilities: flattened,
            };
        }
        // any_provider：OR（provider 之间），每个 provider 内部 AND。
        if (!isArray(value) || value.length === 0) {
            return {
                ok: false,
                code: 'INVALID_ARGUMENT',
                reason: `能力族 ${name} 的 any_provider 必须是非空 provider 数组`,
                next_step: NEXT_STEP_BINDING,
                missing_capabilities: [name],
            };
        }
        const failures = [];
        for (const candidate of value) {
            const checked = checkProvider(candidate, toolSet, inventory);
            if (checked.ok) {
                return {
                    ok: true,
                    entry: { capability: name, via: 'any_provider', provider: checked.provider },
                    providers: [{ capability: name, ...checked.provider }],
                };
            }
            failures.push(checked);
        }
        return {
            ok: false,
            code: worstCode(failures),
            reason: `能力族 ${name} 没有可核验的 provider：${failures.map((failure) => failure.reason).join('；')}`,
            next_step: '按工具清单补齐 provider 的 tool/entrypoint/快照/transport 证据，或改绑可用的本地入口',
            missing_capabilities: [name],
        };
    }
    const seenNeeds = new Set();
    for (const rawNeed of isArray(needs) ? needs : []) {
        if (!isNonEmptyString(rawNeed) || seenNeeds.has(rawNeed))
            continue;
        seenNeeds.add(rawNeed);
        const result = resolve(rawNeed);
        if (result.ok) {
            matched.push(result.entry);
            providers.push(...result.providers);
        }
        else {
            missing.push(missingEntry(rawNeed, result.code, result.reason, result.next_step, result.missing_capabilities));
        }
    }
    return { matched, missing, providers };
}
