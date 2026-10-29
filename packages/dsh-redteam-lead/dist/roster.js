/**
 * `rt_roster`：班底提议（inspect）、绑定（bind）与接管（takeover）。
 *
 * 三条硬规则（契约「版本、角色与通用返回」「岗位目录与预算裁剪」「自检、会话接管与 Lead 循环」）：
 *
 * 1. **身份只来自 `deps.identity.resolveCaller(ctx)`**：入参自报的 `role` 一律忽略。
 *    inspect 允许 Lead 与真实 teammate；bind/takeover 仅 Lead（D4：宿主工具层不做角色检查，
 *    本包必须自己做）。
 * 2. **inspect 零副作用**：不建成员、不建任务、不写 binding/roster；只允许 best-effort 审计。
 * 3. **容量口径照 DECISIONS D25**：上限未声明（`activations.known === false`）→ 传 `null` 让
 *    `planBudget` 延后 + `CAPACITY_UNKNOWN`；上限已声明 → 传**声明上限**（不是不可观测的占用），
 *    并把 `cap.gaps` 原样并入 `gaps` 作非阻塞诊断。`rosterData.capacity` 只投影 schema 的 4 个
 *    字段，未知用 `null`，`known` 不上线（D19）。
 *
 * 提议哈希（`proposal_hash`）绑定：提议内容（岗位需求 + 目标类别 + 预算参数）、岗位目录版本、
 * 能力映射版本、规则/脚本/目录摘要、以及**当前绑定**（epoch/session/team/摘要）。宿主计数
 * **不进**哈希 —— bind 在项目锁内重读计数，资源不足时要求重新提议（不能沿旧快照超配）。
 */
import { createHash } from 'node:crypto';
import * as envelopeModule from './envelope.js';
import * as bindingModule from './binding.js';
import { isRecord, recordOf, thrownMessage } from './guards.js';
const TOOL = 'rt_roster';
const SHA256 = /^[0-9a-f]{64}$/u;
const OPERATION_ID = /^[a-z0-9][a-z0-9_-]{0,95}$/u;
const LEAD_ONLY = new Set(['bind', 'takeover']);
const CAPACITY_CODES = new Set(['CAPACITY_UNKNOWN', 'CAPACITY_EXHAUSTED']);
const ADAPTER_CONTRACT_VERSION = 1;
/** `probe().gaps` 里「项目未按 skill 默认布局建好」的那一类 → PROJECT_NOT_CONFIGURED。 */
const NOT_CONFIGURED_GAP_CODES = new Set([
    'PROJECT_INDEX_MISSING',
    'PROJECT_CONFIG_MISSING',
    'SKILL_COPY_MISSING',
    'PROJECT_SCRIPT_MISSING',
    'PROJECT_LAYOUT_UNSUPPORTED',
]);
const NEXT_STEP_REPROPOSE = '重新 rt_roster action=inspect 生成新的 proposal_hash，确认后再 bind；不要复用过期提议';
/**
 * 缺团队服务时的固定入口（契约「自检、会话接管与 Lead 循环」：`bin/doctor.mjs` 不依赖插件挂载）。
 */
const NEXT_STEP_SERVICE = '启用 @deepseek-ai/dsh-experimental-agent-team-profile（profile 的 dsh.profile.bundles）后重试；'
    + '缺服务时先跑不依赖插件挂载的只读自检：node <bundle-root>/bin/doctor.mjs --profile <profile-root> --project <project-root>';
/**
 * `depsOf()`：取 `ctx.deps` 并补齐本模块的两个必需模块。
 *
 * 装配层给的就是 SEAMS §1 的 `Deps`；`recordOf` 保留了原来「不是对象就当空」的降级路径
 * （`ctx` 缺省时仍能拿到本包的真实 `envelope`/`binding`，handler 才不会 reject）。
 */
function depsOf(ctx) {
    // 逐字保留「ctx 不是对象就当空」的降级（handler 绝不 reject），再把已收窄的普通记录
    // 断言回 SEAMS §1 的 `Deps`：装配层给的就是这个形状，少几个键由调用点各自判空。
    // 两段式断言只因 `Record<string, unknown>` 与 `Deps` 没有索引签名重叠，不能直接 `as Deps`。
    const deps = recordOf(recordOf(ctx).deps);
    return {
        ...deps,
        envelope: deps.envelope ?? envelopeModule,
        binding: deps.binding ?? bindingModule,
    };
}
function sanitizeOperationId(value) {
    return typeof value === 'string' && OPERATION_ID.test(value) ? value : null;
}
function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}
function stringList(value) {
    return Array.isArray(value) ? value.filter(isNonEmptyString) : [];
}
function isoNow(deps) {
    const clock = deps.clock;
    if (clock && typeof clock.isoNow === 'function')
        return clock.isoNow();
    if (clock && typeof clock.now === 'function')
        return new Date(clock.now()).toISOString();
    return new Date().toISOString();
}
function nowMs(deps) {
    const clock = deps.clock;
    if (clock && typeof clock.now === 'function')
        return clock.now();
    return Date.now();
}
function sha256Text(text) {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}
/** 去重（同 code+reason+next_step 只留一条），保持首次出现的顺序。 */
function dedupeDiagnostics(list) {
    const seen = new Set();
    const out = [];
    for (const item of list) {
        if (!item || typeof item !== 'object')
            continue;
        const key = `${item.code}\u0000${item.reason}\u0000${item.next_step}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push({ code: item.code, reason: item.reason, next_step: item.next_step });
    }
    return out;
}
/** `probe().gaps`（`{code, blocking, detail, nextStep}`）→ 诊断三字段。 */
function probeGapToDiagnostic(env, gap) {
    const record = recordOf(gap);
    const code = isNonEmptyString(record.code) ? record.code : 'PROJECT_PROBE_GAP';
    const detail = isNonEmptyString(record.detail) ? record.detail : '项目副本缺口（未提供细节）';
    const reason = `${detail}${record.blocking === true ? '（阻塞）' : '（非阻塞）'}`;
    const nextStep = isNonEmptyString(record.nextStep) ? record.nextStep : '按项目 skill 的接入规则修正后重新 inspect';
    return env.diagnostic(code, reason, nextStep);
}
/**
 * 只读探测项目副本：返回兼容性状态、诊断与内容摘要。绝不写盘、绝不 init。
 *
 * @returns {Promise<{status: 'compatible'|'blocked'|'unknown', gaps: object[],
 *   digests: {ruleDigest: string|null, scriptDigest: string|null, catalogDigest: string|null},
 *   blockedCode: string|null, versions: object}>}
 */
async function probeProject(deps, root, env) {
    const emptyDigests = { ruleDigest: null, scriptDigest: null, catalogDigest: null };
    const adapter = deps.projectAdapter;
    if (!adapter || typeof adapter.probe !== 'function') {
        return {
            status: 'unknown',
            gaps: [env.diagnostic('PROJECT_PROBE_UNAVAILABLE', '没有项目适配器（deps.projectAdapter），无法核对项目副本是否可接入', '挂载 project-adapter 后重新 inspect；未核对前不要把兼容性当作已通过')],
            digests: emptyDigests,
            blockedCode: null,
            versions: {},
        };
    }
    let result;
    try {
        result = await adapter.probe({ projectRoot: root });
    }
    catch (error) {
        return {
            status: 'unknown',
            gaps: [env.diagnostic('PROJECT_PROBE_FAILED', `项目探测抛错：${error instanceof Error ? error.message : String(error)}`, '先修好项目适配器/项目副本，再重新 inspect')],
            digests: emptyDigests,
            blockedCode: null,
            versions: {},
        };
    }
    const probe = recordOf(result);
    const compatibility = isRecord(probe.compatibility) ? probe.compatibility : null;
    const rawGaps = Array.isArray(probe.gaps) ? probe.gaps : [];
    const gaps = rawGaps.map((gap) => probeGapToDiagnostic(env, gap));
    // 非默认布局：插件 v0 只支持 skill 的默认布局，别静默另建目录。
    const layoutUnsupported = compatibility !== null
        && compatibility.layoutKind !== undefined
        && compatibility.layoutKind !== null
        && compatibility.layoutKind !== 'default';
    if (layoutUnsupported && !gaps.some((gap) => gap.code === 'PROJECT_LAYOUT_UNSUPPORTED')) {
        gaps.push(env.diagnostic('PROJECT_LAYOUT_UNSUPPORTED', `项目副本布局是 ${String(compatibility.layoutKind)}（阻塞）：v0 只支持 skill 默认布局`, '改用 skill 默认布局，或把项目副本按团队规则迁移后再接入；不要静默另建目录'));
    }
    const digests = {
        ruleDigest: compatibility?.ruleDigest ?? null,
        scriptDigest: compatibility?.scriptDigest ?? null,
        catalogDigest: compatibility?.catalogDigest ?? null,
    };
    const versions = isRecord(compatibility?.versions) ? compatibility.versions : {};
    if (probe.ok !== true && gaps.length === 0) {
        // 适配器直接拒绝（例如项目根不是 skill 项目）：保留原始原因，不当作「已核对」。
        const nextStep = isNonEmptyString(probe.nextStep)
            ? probe.nextStep
            : '确认传入的是分析项目根，并按项目 skill 的接入规则补齐后重试；不要用它重 init 覆盖副本';
        return {
            status: 'blocked',
            gaps: [env.diagnostic(isNonEmptyString(probe.code) ? probe.code : 'PROJECT_NOT_CONFIGURED', isNonEmptyString(probe.reason) ? probe.reason : '项目探测失败（适配器未给出原因）', nextStep)],
            digests,
            blockedCode: 'PROJECT_NOT_CONFIGURED',
            versions,
        };
    }
    const blocking = rawGaps.filter((gap) => recordOf(gap).blocking === true);
    if (blocking.length === 0 && !layoutUnsupported && probe.ok === true) {
        return { status: 'compatible', gaps, digests, blockedCode: null, versions };
    }
    const gapCodes = blocking.map((gap) => recordOf(gap).code);
    const blockedCode = gapCodes.some((code) => typeof code === 'string' && NOT_CONFIGURED_GAP_CODES.has(code))
        ? 'PROJECT_NOT_CONFIGURED'
        : 'SKILL_INCOMPATIBLE';
    const hasBlocker = blocking.length > 0 || layoutUnsupported;
    return {
        status: hasBlocker ? 'blocked' : 'unknown',
        gaps,
        digests,
        blockedCode: hasBlocker ? blockedCode : null,
        versions,
    };
}
/**
 * 从**实际执行者**取工具可见性（`ctx.services.tools.schemas(exec.agent)` / `get(name, agent)`）。
 *
 * 别的 agent 作用域里可见不算本执行者能调用；宿主不提供注册表时 `available:false`，
 * 由调用方降级成「未核对」的明确缺口，绝不假装已核对。
 */
function toolsFor(ctx) {
    const holder = recordOf(ctx);
    const service = recordOf(recordOf(holder.services).tools);
    const agent = recordOf(holder.exec).agent;
    if (typeof service.schemas !== 'function') {
        return {
            available: false,
            names: [],
            reason: '宿主未提供 ctx.services.tools（工具注册表），无法核对执行者可见工具',
        };
    }
    let schemas;
    try {
        schemas = service.schemas(agent);
    }
    catch (error) {
        return {
            available: false,
            names: [],
            reason: `工具注册表查询失败：${error instanceof Error ? error.message : String(error)}`,
        };
    }
    if (!schemas || typeof schemas !== 'object' || Array.isArray(schemas)) {
        return { available: false, names: [], reason: '工具注册表没有返回该执行者的 schema 映射' };
    }
    const names = [];
    for (const name of Object.keys(schemas).sort()) {
        if (typeof service.get === 'function') {
            let schema = null;
            try {
                schema = service.get(name, agent);
            }
            catch {
                schema = null;
            }
            if (schema === null || schema === undefined)
                continue;
        }
        names.push(name);
    }
    return { available: true, names, reason: null };
}
/** 模板骨架：按 target_kinds 选模板（两个以上类别走 mixed）。 */
function composeTemplateFor(deps, kinds, env) {
    const catalogDef = deps.catalog;
    if (!catalogDef || typeof catalogDef.composeTemplate !== 'function') {
        return {
            ok: false,
            diagnostic: env.diagnostic('INVALID_ARGUMENT', '缺少岗位目录模块，无法组合模板', '挂载 catalog 模块后重试'),
        };
    }
    let catalogValue;
    try {
        catalogValue = typeof catalogDef.defaultCatalog === 'function' ? catalogDef.defaultCatalog() : undefined;
    }
    catch (error) {
        return {
            ok: false,
            diagnostic: env.diagnostic('INVALID_ARGUMENT', `岗位目录加载失败：${error instanceof Error ? error.message : String(error)}`, '确认包内 src/catalog.data.json 完整（随包发布）；不要手改规格目录'),
        };
    }
    const templateId = kinds.length > 1 ? 'mixed' : kinds[0];
    // `catalog` 模块本次并行类型化中尚未标注参数（`targetKinds = []` 推出 `never[]`、`catalog` 推出
    // `defaultCatalog()` 的类型），这里按 UPSTREAM-API 的契约签名调用；`never[]` 在标注前后都可赋值。
    const compose = catalogDef.composeTemplate;
    const composed = compose(templateId, kinds, catalogValue);
    if (!composed || composed.ok !== true) {
        return {
            ok: false,
            diagnostic: env.diagnostic('INVALID_ARGUMENT', isNonEmptyString(composed?.reason) ? composed.reason : `模板 ${templateId} 无法组合`, isNonEmptyString(composed?.next_step) ? composed.next_step : '按 target_kinds 选择模板；多类别用 mixed'),
        };
    }
    return { ok: true, templateId, composed, catalogVersion: recordOf(catalogValue).catalog_version ?? null };
}
/** 一个岗位的候选条目（`planBudget` 的入参形状）。 */
function candidateOf(post, { capability, running, member }) {
    return {
        post_id: post.id,
        priority: post.priority,
        enabled: post.enabled !== false,
        disabled_reason: post.disabled_reason,
        required: stringList(post.required),
        optional: stringList(post.optional),
        anchors_required: stringList(post.anchors_required),
        capability,
        running: running === true,
        member: member ?? null,
    };
}
/**
 * 计算一个岗位的能力满足情况。
 *
 * 工具注册表不可用时给出**未核对**（CAPABILITY_NOT_READY），而不是假装缺失或假装满足。
 */
function capabilityOf(deps, post, toolNames, inventory, bindings, toolsAvailable) {
    const needs = stringList(post.required);
    if (!toolsAvailable) {
        return {
            satisfied: false,
            missing: [{
                    capability: needs[0] ?? '(unknown)',
                    code: 'CAPABILITY_NOT_READY',
                    reason: `执行者的工具注册表不可用，无法核对 ${needs.join('／')}（未核对 ≠ 缺失）`,
                    next_step: '让宿主注入 ctx.services.tools 后重新 inspect；未核对前不要把该岗位当作可派发',
                }],
        };
    }
    if (needs.length === 0)
        return { satisfied: true, missing: [] };
    const matcher = deps.capability;
    if (!matcher || typeof matcher.matchCapabilities !== 'function') {
        return {
            satisfied: false,
            missing: [{
                    capability: needs[0],
                    code: 'CAPABILITY_NOT_READY',
                    reason: '缺少能力匹配模块，无法核对岗位能力',
                    next_step: '挂载 capability 模块后重新 inspect',
                }],
        };
    }
    const matched = matcher.matchCapabilities(needs, toolNames, inventory, bindings);
    const missing = Array.isArray(matched?.missing) ? matched.missing : [];
    return { satisfied: missing.length === 0, missing };
}
function stablePosts(posts) {
    return posts.map((post) => ({
        post_id: post.id,
        priority: post.priority,
        enabled: post.enabled !== false,
        required: [...stringList(post.required)].sort(),
        optional: [...stringList(post.optional)].sort(),
        anchors_required: [...stringList(post.anchors_required)].sort(),
    }));
}
/** 比对用的绑定摘要（`readBinding` 的 `{present, binding}` 形状）。 */
function bindingStateOf(bindingFile) {
    const file = recordOf(bindingFile);
    if (!file.present || !isRecord(file.binding)) {
        return { present: false };
    }
    const value = file.binding;
    return {
        present: true,
        epoch: Number.isSafeInteger(value.epoch) ? value.epoch : null,
        session_id: value.session_id ?? null,
        team_id: value.team_id ?? null,
        bindingDigest: value.bindingDigest ?? null,
        ruleDigest: value.ruleDigest ?? null,
        scriptDigest: value.scriptDigest ?? null,
        catalogDigest: value.catalogDigest ?? null,
    };
}
/**
 * 提议指纹：确定性内容，不含宿主计数（计数在 bind 时于锁内重读）。
 * `proposal_hash = sha256(按键排序的 JSON(指纹))`。
 */
function proposalFingerprint(input) {
    return {
        kind: 'roster_proposal',
        schema_version: 1,
        project_root: input.projectRoot,
        project_id: input.projectId,
        target_kinds: [...input.targetKinds],
        template_id: input.templateId,
        catalog: { version: input.catalogVersion, digest: input.digests.catalogDigest },
        capability: input.capabilityVersion,
        budget: input.budget,
        posts: input.staticPosts,
        digests: input.digests,
        binding: input.bindingState,
        compatibility: input.compatibility,
    };
}
function proposalHashOf(deps, fingerprint) {
    const canonical = deps.validate && typeof deps.validate.canonicalJson === 'function'
        ? deps.validate.canonicalJson
        : (value) => JSON.stringify(value);
    return sha256Text(canonical(fingerprint));
}
/** `rosterData`（`$defs.rosterData` 的 12 个必备字段，多一个都不行）。 */
function rosterDataOf(input) {
    return {
        action: input.action,
        project_root: input.root,
        project_id: input.projectId,
        session_id: input.session.session_id,
        team_id: input.session.team_id,
        compatibility: input.compatibility,
        posts: input.posts,
        gaps: input.gaps,
        capacity: input.capacity,
        recommended_members: input.recommendedMembers,
        proposal_hash: input.proposalHash,
        binding_ref: input.bindingRef,
    };
}
/** D19：只有 4 个字段，未知用 null，`known` 不上线。 */
function projectCapacity(planCapacity) {
    const capacity = recordOf(planCapacity);
    return {
        remaining_member_slots: capacity.available_member_slots ?? null,
        remaining_activations: capacity.available_activations ?? null,
        reserved_member_slots: capacity.reserved_member_slots ?? 0,
        reserved_activations: capacity.reserved_activations ?? 0,
    };
}
/** 按目录优先级（priority 升序、同值 post_id 升序）输出岗位，便于人读与 diff。 */
function orderPosts(entries, priorityOf) {
    const list = Array.isArray(entries) ? entries : [];
    return [...list]
        .map((entry) => ({
        post_id: entry.post_id,
        state: entry.state,
        required: [...entry.required],
        optional: [...entry.optional],
        anchors_required: [...entry.anchors_required],
        member: entry.member ?? null,
        reason: entry.reason,
    }))
        .sort((left, right) => {
        const leftPriority = priorityOf.get(left.post_id) ?? Number.MAX_SAFE_INTEGER;
        const rightPriority = priorityOf.get(right.post_id) ?? Number.MAX_SAFE_INTEGER;
        if (leftPriority !== rightPriority)
            return leftPriority - rightPriority;
        if (left.post_id === right.post_id)
            return 0;
        return left.post_id < right.post_id ? -1 : 1;
    });
}
async function readCapacity(deps, root, env) {
    const adapter = deps.teamAdapter;
    if (!adapter || typeof adapter.capacity !== 'function') {
        return {
            ok: false,
            code: 'TEAM_SERVICE_UNAVAILABLE',
            diagnostics: [env.diagnostic('TEAM_SERVICE_UNAVAILABLE', '没有团队适配器，取不到成员席位与 activation 上限', NEXT_STEP_SERVICE)],
            memberSlots: { known: false, remaining: null, total: null, used: null },
            activations: { known: false, remaining: null, total: null },
            gaps: [],
        };
    }
    const value = await adapter.capacity();
    if (!value || typeof value !== 'object') {
        return {
            ok: false,
            code: 'RECOVERY_REQUIRED',
            diagnostics: [env.diagnostic('RECOVERY_REQUIRED', '团队适配器没有返回容量对象', '核对 team-adapter 版本后重试')],
            memberSlots: { known: false, remaining: null, total: null, used: null },
            activations: { known: false, remaining: null, total: null },
            gaps: [],
        };
    }
    // 诊断用：项目里明明声明了容量，但适配器没读到（典型原因是装配时没把 project_root 交给它）。
    // 这里只**报告**，不改预算口径 —— 容量仍按适配器给的值走（D1/D25）。
    if (value.memberSlots?.total === null && typeof adapter.readDeclaredCapacity === 'function') {
        try {
            const declared = recordOf(await adapter.readDeclaredCapacity(root));
            if (declared.known === true) {
                const gaps = Array.isArray(value.gaps) ? value.gaps : [];
                return {
                    ...value,
                    gaps: [...gaps, {
                            code: 'CAPACITY_DECLARATION_UNREAD',
                            detail: `项目声明了容量（${declared.path ?? 're/team/capacity.json'}：maxMembers=${declared.maxMembers}、maxActiveSubagents=${declared.maxActiveSubagents}），但团队适配器没有读到它`,
                            nextStep: '由装配层把本次 project_root 传给 createTeamAdapter（或把容量声明放进 profile 的 config.capacity）；在此之前按 CAPACITY_UNKNOWN 处理，不猜余额',
                        }],
                };
            }
        }
        catch {
            // 诊断失败不影响容量口径
        }
    }
    return value;
}
/** `capacity().gaps`（`{code, detail, nextStep}`）→ 诊断。 */
function capacityGapsToDiagnostics(value) {
    return (Array.isArray(value) ? value : []).map((raw) => {
        const gap = recordOf(raw);
        return {
            code: isNonEmptyString(gap.code) ? gap.code : 'CAPACITY_UNKNOWN',
            reason: isNonEmptyString(gap.detail) ? gap.detail : '容量声明或计数不可用',
            next_step: isNonEmptyString(gap.nextStep)
                ? gap.nextStep
                : '在 re/team/capacity.json 声明 maxMembers/maxActiveSubagents（含 declared_at/declared_by）后重试',
        };
    });
}
/**
 * 调 `capacity.planBudget`。
 *
 * `capacity` 模块本次并行类型化中尚未标注参数（默认值把 `candidates` 收成 `never[]`、
 * 余额收成 `null | undefined`），这里把本模块准备好的入参对象断言成**该模块自己的参数类型**；
 * 运行时传的是同一个对象，字段一个不改。
 */
function planBudgetOf(deps, input) {
    return deps.capacity.planBudget(input);
}
/**
 * 组装一次提议：模板候选 + 能力匹配 + 预算裁剪 + 容量投影 + 提议指纹。
 *
 * inspect 与 bind 共用**同一份**计算，保证 `proposal_hash` 在两边一致。
 */
async function assembleProposal(ctx, deps, { root, projectId, session, kinds, request, compatibility, env }) {
    const template = composeTemplateFor(deps, kinds, env);
    if (template.ok !== true)
        return { ok: false, diagnostic: template.diagnostic };
    const tools = toolsFor(ctx);
    const inventory = await deps.binding.readJsonIfPresent(root, 're/env/tools.json', deps);
    const bindings = await deps.binding.readJsonIfPresent(root, 're/team/capabilities.json', deps);
    const rosterFile = await deps.binding.readJsonIfPresent(root, 're/team/roster.json', deps);
    const bindingFile = typeof deps.compatibility?.readBinding === 'function'
        ? await deps.compatibility.readBinding(root)
        : { present: false, binding: null };
    const environmentGaps = [];
    if (!tools.available) {
        environmentGaps.push(env.diagnostic('CAPABILITY_NOT_READY', tools.reason, '让宿主注入 ctx.services.tools（schemas/get）后重新 inspect；期间把岗位当作「未核对」，不要据此派发'));
    }
    if (!inventory.present) {
        environmentGaps.push(env.diagnostic('TOOL_INVENTORY_MISSING', `没有可用的工具清单快照：${inventory.reason ?? 're/env/tools.json 缺失'}；按 D11 这是未知项，不是「工具缺失」`, '由 Lead 按 skill 的工具清单规则补齐 re/env/tools.json 与其不可变快照；插件不生成清单、不隐式扫描'));
    }
    if (!bindings.present && isNonEmptyString(bindings.reason) && !/不存在/u.test(bindings.reason)) {
        environmentGaps.push(env.diagnostic('CAPABILITY_BINDING_INVALID', `re/team/capabilities.json 不可用：${bindings.reason}`, '修正能力绑定文件后重新 inspect；不要沿用旧的 alias 绑定'));
    }
    const memberList = typeof deps.teamAdapter?.listMembers === 'function'
        ? await deps.teamAdapter.listMembers(undefined)
        : { ok: false, members: [] };
    const liveMembers = new Map();
    const members = recordOf(memberList).members;
    for (const member of Array.isArray(members) ? members : []) {
        if (member && member.role === 'teammate')
            liveMembers.set(member.name, member);
    }
    const reuseByPost = new Map();
    const rosterPosts = recordOf(rosterFile.value).posts;
    if (rosterFile.present && Array.isArray(rosterPosts)) {
        for (const post of rosterPosts) {
            if (isNonEmptyString(post?.member))
                reuseByPost.set(post.post_id, post.member);
        }
    }
    const postList = [...template.composed.posts, ...template.composed.reserved_posts];
    const priorityOf = new Map();
    const candidates = [];
    for (const post of postList) {
        // 目录里的 priority 一定是数字（$defs.post）；非数字时按「无优先级」处理（原来是 NaN 比较）。
        if (typeof post.priority === 'number')
            priorityOf.set(post.id, post.priority);
        const reusedName = reuseByPost.get(post.id);
        const reused = reusedName === undefined ? undefined : liveMembers.get(reusedName);
        const reusable = reused !== undefined && reused !== null
            && (reused.status === 'running' || reused.status === 'inactive');
        candidates.push(candidateOf(post, {
            capability: capabilityOf(deps, post, tools.names, inventory.present ? inventory.value : null, bindings.present ? bindings.value : null, tools.available),
            running: reusable,
            member: reusable ? reusedName : null,
        }));
    }
    const cap = await readCapacity(deps, root, env);
    if (cap.ok === false) {
        return {
            ok: false,
            code: cap.code,
            diagnostics: cap.diagnostics ?? [],
            capacityGaps: capacityGapsToDiagnostics(cap.gaps),
        };
    }
    // D25：上限未声明 → null（defer + CAPACITY_UNKNOWN）；已声明 → 传声明上限，占用不可观测只作 gap。
    const remainingActivations = cap.activations.known === true ? cap.activations.total : null;
    const plan = planBudgetOf(deps, {
        candidates,
        remainingMemberSlots: cap.memberSlots.remaining,
        remainingActivations,
        maxPosts: request.maxPosts,
        reservedMemberSlots: request.reservedMemberSlots,
        reservedActivations: request.reservedActivations,
    });
    const posts = orderPosts([...plan.assigned, ...plan.vacant, ...plan.deferred, ...plan.disabled], priorityOf);
    const gaps = dedupeDiagnostics([
        ...environmentGaps,
        ...plan.gaps,
        ...capacityGapsToDiagnostics(cap.gaps),
        ...(compatibility?.gaps ?? []),
    ]);
    const capabilityVersion = {
        present: bindings.present === true,
        schema_version: bindings.value?.schema_version ?? null,
        revision: bindings.value?.revision ?? null,
        registry_sha256: bindings.value?.registry_sha256 ?? null,
        sha256: bindings.sha256 ?? null,
    };
    const budget = {
        max_posts: request.maxPosts,
        reserved_member_slots: request.reservedMemberSlots,
        reserved_activations: request.reservedActivations,
    };
    const digests = compatibility?.digests ?? { ruleDigest: null, scriptDigest: null, catalogDigest: null };
    const proposalHash = proposalHashOf(deps, proposalFingerprint({
        projectRoot: root,
        projectId,
        targetKinds: kinds,
        templateId: template.templateId,
        catalogVersion: template.catalogVersion,
        capabilityVersion,
        budget,
        staticPosts: stablePosts([...template.composed.posts, ...template.composed.reserved_posts]),
        digests,
        bindingState: bindingStateOf(bindingFile),
        compatibility: compatibility?.status ?? 'unknown',
    }));
    return {
        ok: true,
        templateId: template.templateId,
        catalogVersion: template.catalogVersion,
        targetKinds: kinds,
        posts,
        gaps,
        plan,
        capacity: projectCapacity(plan.capacity),
        recommendedMembers: plan.recommended_members,
        capabilityVersion,
        budget,
        digests,
        bindingFile,
        proposalHash,
    };
}
/** target_kinds 为空时的「只查环境」提议：不猜类别、不给岗位、不给 proposal_hash。 */
async function assembleEnvironmentOnly(ctx, deps, { root, request, compatibility, env }) {
    const tools = toolsFor(ctx);
    const inventory = await deps.binding.readJsonIfPresent(root, 're/env/tools.json', deps);
    const gaps = [...(compatibility?.gaps ?? [])];
    if (!tools.available) {
        gaps.push(env.diagnostic('CAPABILITY_NOT_READY', tools.reason, '让宿主注入 ctx.services.tools 后重新 inspect；期间把能力当作「未核对」'));
    }
    if (!inventory.present) {
        gaps.push(env.diagnostic('TOOL_INVENTORY_MISSING', `没有可用的工具清单快照：${inventory.reason ?? 're/env/tools.json 缺失'}`, '由 Lead 按 skill 的工具清单规则补齐；插件不生成清单、不隐式扫描'));
    }
    const cap = await readCapacity(deps, root, env);
    if (cap.ok === false)
        return { ok: false, code: cap.code, diagnostics: cap.diagnostics ?? [] };
    const remainingActivations = cap.activations.known === true ? cap.activations.total : null;
    const plan = planBudgetOf(deps, {
        candidates: [],
        remainingMemberSlots: cap.memberSlots.remaining,
        remainingActivations,
        maxPosts: request.maxPosts,
        reservedMemberSlots: request.reservedMemberSlots,
        reservedActivations: request.reservedActivations,
    });
    return {
        ok: true,
        templateId: null,
        targetKinds: [],
        posts: [],
        gaps: dedupeDiagnostics([...gaps, ...plan.gaps, ...capacityGapsToDiagnostics(cap.gaps)]),
        capacity: projectCapacity(plan.capacity),
        recommendedMembers: 0,
        proposalHash: null,
    };
}
// ---------------------------------------------------------------------------
// 操作台账与锁
// ---------------------------------------------------------------------------
async function ledgerFor(deps, root) {
    if (!deps.operation || typeof deps.operation.createOperationLedger !== 'function')
        return null;
    return deps.operation.createOperationLedger({ root, clock: deps.clock });
}
function operationInputHash(deps, input, { action, root, session, epoch }) {
    if (!deps.validate || typeof deps.validate.operationInputHash !== 'function')
        return null;
    const hash = deps.validate.operationInputHash(input, {
        tool: TOOL,
        action,
        project: root,
        session: session.session_id ?? null,
        epoch: Number.isSafeInteger(epoch) ? epoch : null,
    });
    return typeof hash === 'string' && SHA256.test(hash) ? hash : null;
}
function sessionMismatchWithRecord(record, session) {
    const holder = recordOf(record);
    const data = isRecord(holder.data) ? holder.data : {};
    if (!isNonEmptyString(data.session_id) || !isNonEmptyString(session.session_id))
        return null;
    if (data.session_id === session.session_id)
        return null;
    return `该 operation_id 首次登记时的 session_id=${data.session_id} 与当前 ${session.session_id} 不一致`;
}
/**
 * 在项目锁内执行 `body`。
 *
 * 锁冲突（`PROJECT_BUSY`）与损坏锁（`RECOVERY_REQUIRED`）原样抛给调用方转成信封；
 * **过期不自作主张夺锁**（lock 模块本身就不抢锁）。
 */
async function withProjectLock(deps, root, { session, operationId }, body) {
    const lockSession = isNonEmptyString(session.session_id)
        ? session.session_id
        : (isNonEmptyString(session.team_id) ? session.team_id : 'rt-roster');
    const lease = await deps.lock.acquire(root, {
        session: lockSession,
        operation: operationId,
        now: nowMs(deps),
    });
    try {
        return await body();
    }
    finally {
        try {
            await deps.lock.release(root, { ownerNonce: lease?.record?.owner_nonce });
        }
        catch {
            // 释放失败不改变业务结果：锁记录会留下，下一次操作按 PROJECT_BUSY 处理。
        }
    }
}
/**
 * `rt_roster` handler（SEAMS §1：`input` 已通过 `$defs.rosterInput` 校验，返回 `{envelope}`，绝不 reject）。
 *
 * @param {object} ctx 装配上下文
 * @param {object} rawInput 已校验/已填默认值的入参
 * @returns {Promise<{envelope: object}>}
 */
export async function handleRoster(ctx, rawInput) {
    const deps = depsOf(ctx);
    const env = deps.envelope;
    const input = isRecord(rawInput) ? rawInput : {};
    const operationId = sanitizeOperationId(input.operation_id);
    let outcome;
    try {
        outcome = await runRoster(ctx, deps, input, env);
    }
    catch (thrown) {
        outcome = {
            envelope: env.fromError(thrown, { operationId }),
            root: null,
            audit: { kind: 'roster_error', verdict: 'error', requester: null },
        };
    }
    // 审计 best-effort：写失败不逆转判定，只在信封里补一条诊断（不回滚已写的记录）。
    if (outcome.audit && outcome.root && outcome.envelope.replayed !== true) {
        const written = await appendRosterAudit(deps, outcome);
        if (written && written.written !== true) {
            outcome.envelope.diagnostics = [...outcome.envelope.diagnostics, env.diagnostic('AUDIT_WRITE_FAILED', `审计写入失败（audit_written=false）：${written.error ?? '未知原因'}`, '按 re/team/audit.jsonl 的权限/磁盘状态修复后重试；审计失败不影响已落盘的绑定事实')];
        }
    }
    return { envelope: outcome.envelope };
}
async function appendRosterAudit(deps, outcome) {
    const audit = deps.audit;
    if (!audit || typeof audit.appendAudit !== 'function')
        return null;
    // 调用方已确认两者非空；这里的判空只为把类型收窄（不可达分支，不改变输出）。
    if (outcome.root === null || outcome.audit === null)
        return null;
    try {
        return await audit.appendAudit(outcome.root, {
            kind: outcome.audit.kind,
            requester: outcome.audit.requester ?? null,
            verdict: outcome.audit.verdict ?? null,
            member: outcome.audit.member ?? null,
        }, { clock: deps.clock });
    }
    catch (error) {
        return { written: false, error: error instanceof Error ? error.message : String(error) };
    }
}
/**
 * 主流程。返回 `{envelope, root, audit}`；只有知道项目根之后才可能写审计。
 */
async function runRoster(ctx, deps, input, env) {
    const action = isNonEmptyString(input.action) ? input.action : 'inspect';
    const operationId = sanitizeOperationId(input.operation_id);
    const kinds = stringList(input.target_kinds);
    const request = {
        action,
        kinds,
        operationId,
        proposalHash: input.proposal_hash ?? null,
        recoveryRef: input.recovery_ref ?? null,
        // `Number.isInteger()` 对非数字恒为 false，补的类型判断不改变取默认值的边界。
        maxPosts: typeof input.max_posts === 'number' && Number.isInteger(input.max_posts) ? input.max_posts : 6,
        reservedMemberSlots: typeof input.reserved_member_slots === 'number' && Number.isInteger(input.reserved_member_slots)
            ? input.reserved_member_slots
            : 1,
        reservedActivations: typeof input.reserved_activations === 'number' && Number.isInteger(input.reserved_activations)
            ? input.reserved_activations
            : 2,
        raw: input,
    };
    // 1. 身份（唯一来源；入参自报角色被忽略）。
    const identity = await deps.identity.resolveCaller(ctx);
    if (!identity || identity.ok !== true) {
        const code = identity?.code === 'TEAM_SERVICE_UNAVAILABLE' ? 'TEAM_SERVICE_UNAVAILABLE' : 'ROLE_REQUIRED';
        // 缺服务必须给出**可执行**的修复路径（doctor 不依赖插件挂载），而不是含糊「服务不可用」。
        const diagnostic = code === 'TEAM_SERVICE_UNAVAILABLE'
            ? env.diagnostic(code, identity?.diagnostic?.reason ?? '宿主未注入团队服务，无法判定调用者身份', NEXT_STEP_SERVICE)
            : (identity?.diagnostic ?? env.diagnostic(code, '无法解析调用者身份', '在团队会话内以 Lead 或 teammate 身份调用'));
        const envelope = code === 'ROLE_REQUIRED'
            ? env.error({ code, operationId, diagnostics: [diagnostic] })
            : env.blocked({ code, operationId, diagnostics: [diagnostic] });
        return { envelope, root: null, audit: { kind: `roster_${action}`, verdict: 'rejected' } };
    }
    const auditBase = { requester: identity.name ?? null };
    if (identity.role !== 'lead' && identity.role !== 'teammate') {
        return {
            envelope: env.error({
                code: 'ROLE_REQUIRED',
                operationId,
                diagnostics: [env.diagnostic('ROLE_REQUIRED', `调用者 ${identity.name ?? '(未知)'} 的团队角色是 ${String(identity.role)}：只有 Lead 与真实 teammate 可以做编排操作`, '由本团队 Lead 发起该操作，或先以团队成员身份被指派；不接受入参自报的角色')],
            }),
            root: null,
            audit: { kind: `roster_${action}`, verdict: 'rejected', ...auditBase },
        };
    }
    if (LEAD_ONLY.has(action) && identity.role !== 'lead') {
        return {
            envelope: env.error({
                code: 'ROLE_REQUIRED',
                operationId,
                diagnostics: [env.diagnostic('ROLE_REQUIRED', `${action} 只允许 Lead：调用者 ${identity.name ?? '(未知)'} 是 teammate`, '由 Lead 执行 bind/takeover；teammate 只能 inspect 并回报缺口')],
            }),
            root: null,
            audit: { kind: `roster_${action}`, verdict: 'rejected', ...auditBase },
        };
    }
    // 2. 项目根（规范化：真实绝对根）。
    const root = await deps.paths.normalizeProjectRoot(input.project_root);
    const session = deps.binding.sessionIdentityFrom({ identity, exec: ctx?.exec, config: ctx?.config });
    const projectRecord = await deps.binding.readJsonIfPresent(root, 're/project.json', deps);
    const projectId = deps.binding.projectIdFor({
        root,
        projectRecord: projectRecord.present ? projectRecord.value : null,
    });
    const audit = { kind: `roster_${action}`, verdict: 'rejected', ...auditBase };
    // 3. 兼容性（只读探测；绝不 init/覆盖副本）。
    const compatibility = await probeProject(deps, root, env);
    if (compatibility.status === 'blocked') {
        const code = compatibility.blockedCode ?? 'PROJECT_NOT_CONFIGURED';
        const gaps = dedupeDiagnostics(compatibility.gaps);
        const data = rosterDataOf({
            action,
            root,
            projectId,
            session,
            compatibility: 'blocked',
            posts: [],
            gaps,
            capacity: projectCapacity(null),
            recommendedMembers: 0,
            proposalHash: null,
            bindingRef: null,
        });
        return {
            envelope: env.blocked({
                code,
                operationId,
                data,
                diagnostics: gaps.length > 0
                    ? gaps
                    : [env.diagnostic(code, '项目副本不满足接入要求', '按项目 skill 的接入规则修正后重新 inspect')],
            }),
            root,
            audit,
        };
    }
    // 4. bind / takeover 的形状之外的前置条件。
    if (action !== 'inspect') {
        if (compatibility.status !== 'compatible') {
            return {
                envelope: env.blocked({
                    code: 'SKILL_INCOMPATIBLE',
                    operationId,
                    diagnostics: [env.diagnostic('SKILL_INCOMPATIBLE', `项目兼容性未核对（compatibility=${compatibility.status}）：bind/takeover 必须有已完成的只读兼容性检查`, '先 rt_roster action=inspect 看到 compatibility=compatible，再 bind；不要跳过兼容性检查直接绑定')],
                }),
                root,
                audit,
            };
        }
        if (operationId === null) {
            return {
                envelope: env.error({
                    code: 'INVALID_ARGUMENT',
                    operationId: null,
                    diagnostics: [env.diagnostic('INVALID_ARGUMENT', `${action} 必须提供合法 operation_id`, '传入 $defs.id 形状的 operation_id（小写字母/数字/下划线/短横线）')],
                }),
                root,
                audit,
            };
        }
        if (typeof request.proposalHash !== 'string' || !SHA256.test(request.proposalHash)) {
            return {
                envelope: env.error({
                    code: 'INVALID_ARGUMENT',
                    operationId,
                    diagnostics: [env.diagnostic('INVALID_ARGUMENT', `${action} 必须提供 64 位小写十六进制的 proposal_hash`, '先 action=inspect，把返回的 proposal_hash 原样传回来')],
                }),
                root,
                audit,
            };
        }
        if (kinds.length === 0) {
            return {
                envelope: env.error({
                    code: 'INVALID_ARGUMENT',
                    operationId,
                    diagnostics: [env.diagnostic('INVALID_ARGUMENT', `${action} 必须给出至少一个 target_kinds`, '按项目实际目标类别传 binary/game/webapp（多类别会走 mixed）')],
                }),
                root,
                audit,
            };
        }
    }
    // 5. 提议（inspect 与 bind/takeover 共用同一份计算）。
    const proposal = kinds.length > 0
        ? await assembleProposal(ctx, deps, { root, projectId, session, kinds, request, compatibility, env })
        : await assembleEnvironmentOnly(ctx, deps, { root, request, compatibility, env });
    if (proposal.ok !== true) {
        const known = typeof deps.errors?.isErrorCode === 'function' && deps.errors.isErrorCode(proposal.code);
        const code = known && typeof proposal.code === 'string' ? proposal.code : 'INVALID_ARGUMENT';
        const diagnostics = Array.isArray(proposal.diagnostics) && proposal.diagnostics.length > 0
            ? proposal.diagnostics
            : [proposal.diagnostic ?? env.diagnostic(code, '提议计算失败', NEXT_STEP_REPROPOSE)];
        const asError = code === 'INVALID_ARGUMENT' || code === 'PATH_INVALID' || code === 'ROLE_REQUIRED';
        return {
            envelope: asError
                ? env.error({ code, operationId, diagnostics })
                : env.blocked({ code, operationId, diagnostics }),
            root,
            audit,
        };
    }
    const data = rosterDataOf({
        action,
        root,
        projectId,
        session,
        compatibility: compatibility.status,
        posts: proposal.posts,
        gaps: proposal.gaps,
        capacity: proposal.capacity,
        recommendedMembers: proposal.recommendedMembers,
        proposalHash: proposal.proposalHash,
        bindingRef: action === 'inspect' ? null : deps.binding.BINDING_PATH,
    });
    if (action === 'inspect') {
        audit.verdict = 'inspected';
        return { envelope: env.ok({ operationId: null, data, retryable: false }), root, audit };
    }
    // bind/takeover 都要求 `operation_id`，上面 `action !== 'inspect'` 的前置条件里已经拒过 null
    // （同码同文的 INVALID_ARGUMENT 信封）。这里显式收窄一次给台账用：既不改写 `request` 里
    // 的原值，也不把 null 传给 `operation.*`（那会被台账层当成 INVALID_ARGUMENT 抛出）。
    if (operationId === null) {
        return {
            envelope: env.error({
                code: 'INVALID_ARGUMENT',
                operationId: null,
                diagnostics: [env.diagnostic('INVALID_ARGUMENT', `${action} 必须提供合法 operation_id`, '传入 $defs.id 形状的 operation_id（小写字母/数字/下划线/短横线）')],
            }),
            root,
            audit,
        };
    }
    const shared = { env, root, projectId, session, request, proposal, data, audit, deps, operationId };
    if (action === 'bind')
        return bindProject(ctx, shared);
    return takeoverProject(ctx, shared);
}
function sessionMismatchResult(env, operationId, bindingValue, session, data) {
    const binding = recordOf(bindingValue);
    return {
        envelope: env.blocked({
            code: 'PROJECT_SESSION_MISMATCH',
            operationId,
            data: data === null ? null : { ...recordOf(data), binding_ref: null },
            diagnostics: [env.diagnostic('PROJECT_SESSION_MISMATCH', `项目已由 session=${binding.session_id ?? 'null'} team=${binding.team_id ?? 'null'} 绑定，当前调用是 session=${session.session_id ?? 'null'} team=${session.team_id ?? 'null'}`, '同一会话内继续；跨 Lead 会话必须走 rt_roster action=takeover（先按 skill 核实旧执行已停止并保存恢复记录）')],
        }),
    };
}
function checkSessionMatch(deps, bindingValue, session) {
    const fn = typeof deps.binding?.checkSessionMatch === 'function'
        ? deps.binding.checkSessionMatch
        : bindingModule.checkSessionMatch;
    return fn(bindingValue, { sessionId: session.session_id, teamId: session.team_id });
}
function firstCapacityGap(gaps) {
    const list = Array.isArray(gaps) ? gaps : [];
    if (list.some((gap) => gap.code === 'CAPACITY_EXHAUSTED'))
        return 'CAPACITY_EXHAUSTED';
    if (list.some((gap) => gap.code === 'CAPACITY_UNKNOWN'))
        return 'CAPACITY_UNKNOWN';
    return null;
}
async function bindProject(ctx, shared) {
    const { deps, env, root, projectId, session, request, proposal, data, audit, operationId } = shared;
    const ledger = await ledgerFor(deps, root);
    const bindingSlot = recordOf(proposal.bindingFile);
    const existingBinding = isRecord(bindingSlot.binding) ? bindingSlot.binding : null;
    const existing = { present: bindingSlot.present, binding: existingBinding };
    if (existing?.present && !checkSessionMatch(deps, existing.binding, session).ok) {
        return { ...sessionMismatchResult(env, operationId, existing.binding, session, data), root, audit };
    }
    // 幂等重放：同一 operation_id 已有结果 → 原样返回（不重复追加历史/审计）。
    // 但**同一 ID 改了输入**必须报 OPERATION_CONFLICT（契约「操作阶段与部分失败」）。
    if (ledger !== null) {
        const recorded = await ledger.findById(operationId);
        if (recorded !== null) {
            const mismatch = sessionMismatchWithRecord(recorded, session);
            if (mismatch !== null) {
                return {
                    envelope: env.blocked({
                        code: 'PROJECT_SESSION_MISMATCH',
                        operationId,
                        diagnostics: [env.diagnostic('PROJECT_SESSION_MISMATCH', mismatch, '跨会话接管请用 action=takeover，并换用新的 operation_id')],
                    }),
                    root,
                    audit,
                };
            }
            const recordedEpoch = Number.isSafeInteger(recorded.data?.input_epoch)
                ? recorded.data.input_epoch
                : null;
            const expected = operationInputHash(deps, request.raw, {
                action: 'bind',
                root,
                session,
                epoch: recordedEpoch,
            });
            if (expected !== null && recorded.input_hash !== expected) {
                return {
                    envelope: env.blocked({
                        code: 'OPERATION_CONFLICT',
                        operationId,
                        data: { ...data, binding_ref: null },
                        diagnostics: [env.diagnostic('OPERATION_CONFLICT', `同一 operation_id 的输入已改变（已存 input_hash=${String(recorded.input_hash)}）`, '同一 ID 必须保持原输入与提案；换了提议（新的 proposal_hash/target_kinds/预算）请用新的 operation_id')],
                    }),
                    root,
                    audit,
                };
            }
            const replay = await ledger.replayResult(operationId);
            if (replay !== null)
                return { envelope: replay, root, audit: null };
        }
    }
    if (request.proposalHash !== proposal.proposalHash) {
        return {
            envelope: env.blocked({
                code: 'OPERATION_CONFLICT',
                operationId,
                data: { ...data, binding_ref: null },
                diagnostics: [env.diagnostic('OPERATION_CONFLICT', `proposal_hash 与当前目录/能力映射/预算/绑定不符（当前目录版本=${String(proposal.catalogVersion)}，能力映射 revision=${String(recordOf(proposal.capabilityVersion).revision)}，绑定 epoch=${String(existing?.binding?.epoch ?? 'none')}，预算 max_posts=${String(recordOf(proposal.budget).max_posts)}）`, NEXT_STEP_REPROPOSE)],
            }),
            root,
            audit,
        };
    }
    let result;
    try {
        result = await withProjectLock(deps, root, { session, operationId }, async () => {
            // 锁内重读：绑定、提议与宿主计数都必须仍然成立，不能沿旧快照超配。
            const freshBinding = typeof deps.compatibility?.readBinding === 'function'
                ? await deps.compatibility.readBinding(root)
                : { present: false, binding: null };
            if (freshBinding.present && !checkSessionMatch(deps, freshBinding.binding, session).ok) {
                return sessionMismatchResult(env, operationId, freshBinding.binding, session, null);
            }
            const freshCompatibility = await probeProject(deps, root, env);
            if (freshCompatibility.status === 'blocked') {
                const code = freshCompatibility.blockedCode ?? 'PROJECT_NOT_CONFIGURED';
                return {
                    envelope: env.blocked({
                        code,
                        operationId,
                        diagnostics: freshCompatibility.gaps,
                    }),
                };
            }
            const freshProposal = await assembleProposal(ctx, deps, {
                root,
                projectId,
                session,
                kinds: proposal.targetKinds,
                request,
                compatibility: freshCompatibility,
                env,
            });
            if (freshProposal.ok !== true) {
                return {
                    envelope: env.blocked({
                        code: freshProposal.code === 'TEAM_SERVICE_UNAVAILABLE' ? 'TEAM_SERVICE_UNAVAILABLE' : 'RECOVERY_REQUIRED',
                        operationId,
                        diagnostics: Array.isArray(freshProposal.diagnostics) && freshProposal.diagnostics.length > 0
                            ? freshProposal.diagnostics
                            : [env.diagnostic('RECOVERY_REQUIRED', '锁内重算提议失败', NEXT_STEP_REPROPOSE)],
                    }),
                };
            }
            if (freshProposal.proposalHash !== proposal.proposalHash) {
                return {
                    envelope: env.blocked({
                        code: 'OPERATION_CONFLICT',
                        operationId,
                        diagnostics: [env.diagnostic('OPERATION_CONFLICT', '锁内重算的提议与 proposal_hash 不一致：目录/规则/能力映射/绑定在 inspect 之后发生了变化', NEXT_STEP_REPROPOSE)],
                    }),
                };
            }
            const capacityProblem = firstCapacityGap(freshProposal.gaps);
            if (capacityProblem !== null) {
                return {
                    envelope: env.blocked({
                        code: capacityProblem,
                        operationId,
                        data: {
                            ...data,
                            posts: freshProposal.posts,
                            gaps: freshProposal.gaps,
                            capacity: freshProposal.capacity,
                            recommended_members: freshProposal.recommendedMembers,
                        },
                        diagnostics: freshProposal.gaps.filter((gap) => CAPACITY_CODES.has(gap.code)),
                    }),
                };
            }
            if (ledger !== null) {
                await ledger.prepare(operationId, operationInputHash(deps, request.raw, {
                    action: 'bind',
                    root,
                    session,
                    epoch: existing?.binding?.epoch ?? null,
                }) ?? '0'.repeat(64), 'prepared', {
                    action: 'bind',
                    session_id: session.session_id,
                    team_id: session.team_id,
                    epoch: existing?.binding?.epoch ?? null,
                    input_epoch: existing?.binding?.epoch ?? null,
                    proposal_hash: proposal.proposalHash,
                });
            }
            const existingEpoch = existingBinding?.epoch;
            const epoch = typeof existingEpoch === 'number' && Number.isSafeInteger(existingEpoch) ? existingEpoch : 1;
            const now = isoNow(deps);
            const freshDigests = recordOf(freshProposal.digests);
            const bindingValue = {
                schema_version: 1,
                project_id: projectId,
                canonical_root: root,
                session_id: session.session_id,
                team_id: session.team_id,
                epoch,
                ruleDigest: freshDigests.ruleDigest,
                scriptDigest: freshDigests.scriptDigest,
                catalogDigest: freshDigests.catalogDigest,
                bindingDigest: proposal.proposalHash,
                adapter: { contract_version: ADAPTER_CONTRACT_VERSION, team: 'team-adapter', project: 'project-adapter' },
                capability: freshProposal.capabilityVersion,
                catalog: { version: freshProposal.catalogVersion, digest: freshDigests.catalogDigest },
                budget: freshProposal.budget,
                template_id: freshProposal.templateId,
                target_kinds: [...freshProposal.targetKinds],
                created_at: isNonEmptyString(existing?.binding?.created_at) ? existing.binding.created_at : now,
                updated_at: now,
            };
            const rosterValue = {
                schema_version: 1,
                project_id: projectId,
                canonical_root: root,
                session_id: session.session_id,
                team_id: session.team_id,
                epoch,
                binding_ref: deps.binding.BINDING_PATH,
                proposal_hash: proposal.proposalHash,
                template: { id: freshProposal.templateId, target_kinds: [...freshProposal.targetKinds] },
                posts: freshProposal.posts,
                members: [],
                tasks: [],
                capacity: freshProposal.capacity,
                recommended_members: freshProposal.recommendedMembers,
                created_at: now,
                updated_at: now,
            };
            const bindingWrite = await deps.binding.writeBinding(root, bindingValue, deps);
            const rosterWrite = await deps.binding.writeRoster(root, rosterValue, deps);
            const indexLink = await deps.binding
                .linkIndexPointers(root, [deps.binding.BINDING_PATH, deps.binding.ROSTER_PATH], deps)
                .catch((error) => ({ written: false, added: [], reason: thrownMessage(error) }));
            const diagnostics = [...freshProposal.gaps];
            if (indexLink.written !== true && indexLink.unchanged !== true) {
                diagnostics.push(env.diagnostic('INDEX_LINK_FAILED', `binding/roster 已写好，但 INDEX 手写区指针没加上：${indexLink.reason ?? '未知原因'}`, '手工在 INDEX 手写区补 re/team/binding.json 与 re/team/roster.json 的链接，或修好 INDEX 后重跑 bind（同 operation_id 会重放）'));
            }
            const envelope = env.ok({
                operationId,
                data: {
                    ...data,
                    posts: freshProposal.posts,
                    gaps: diagnostics,
                    capacity: freshProposal.capacity,
                    recommended_members: freshProposal.recommendedMembers,
                    binding_ref: deps.binding.BINDING_PATH,
                },
            });
            if (ledger !== null) {
                await ledger.advance(operationId, 'completed', {
                    binding_ref: deps.binding.BINDING_PATH,
                    roster_ref: deps.binding.ROSTER_PATH,
                    epoch,
                    binding_sha256: bindingWrite.sha256,
                    roster_sha256: rosterWrite.sha256,
                });
                await ledger.saveResult(operationId, envelope);
            }
            return { envelope };
        });
    }
    catch (error) {
        return { envelope: env.fromError(error, { operationId }), root, audit };
    }
    if (result.envelope.status === 'ok')
        audit.verdict = 'bound';
    return { envelope: result.envelope, root, audit };
}
// ---------------------------------------------------------------------------
// takeover
// ---------------------------------------------------------------------------
async function takeoverProject(ctx, shared) {
    const { deps, env, root, projectId, session, request, proposal, data, audit, operationId } = shared;
    // 1. recovery_ref：必须是项目内真实文件，且内容覆盖「停止/处置/风险」。
    const recovery = await deps.binding.readRecoveryRef(root, request.recoveryRef, deps);
    if (recovery.ok !== true) {
        if (recovery.code === 'RECOVERY_REQUIRED') {
            const items = Array.isArray(recovery.missing) ? recovery.missing : [];
            return {
                envelope: env.blocked({
                    code: 'RECOVERY_REQUIRED',
                    operationId,
                    diagnostics: items.length > 0
                        ? items.map((item) => env.diagnostic('RECOVERY_REQUIRED', `${item.detail}（${request.recoveryRef}）`, '按契约补齐核查记录：旧执行已停止/隔离、遗留进程与资源处置、剩余风险；不要用布尔值代替核查'))
                        : [env.diagnostic('RECOVERY_REQUIRED', recovery.reason, '补齐恢复核查记录后重试')],
                }),
                root,
                audit,
            };
        }
        return {
            envelope: env.error({
                code: 'INVALID_ARGUMENT',
                operationId,
                diagnostics: [env.diagnostic('INVALID_ARGUMENT', recovery.reason, '把 recovery_ref 指向项目内已存在的恢复核查记录（/ 分隔的相对路径）')],
            }),
            root,
            audit,
        };
    }
    const bindingSlot = recordOf(proposal.bindingFile);
    const existing = { present: bindingSlot.present, binding: isRecord(bindingSlot.binding) ? bindingSlot.binding : null };
    if (!existing?.present || !existing.binding) {
        return {
            envelope: env.blocked({
                code: 'PROJECT_NOT_CONFIGURED',
                operationId,
                diagnostics: [env.diagnostic('PROJECT_NOT_CONFIGURED', '项目还没有 binding.json：没有旧绑定可接管', '首次接入用 action=bind；takeover 只用于换 Lead 会话/恢复')],
            }),
            root,
            audit,
        };
    }
    const existingEpoch = existing.binding.epoch;
    const oldEpoch = typeof existingEpoch === 'number' && Number.isSafeInteger(existingEpoch) ? existingEpoch : 1;
    // 幂等重放先于「提议是否过期」检查：接管已经改过 epoch，同一请求的重放不能被误判成冲突
    // （契约「操作阶段与部分失败」）。同一 ID 改了输入仍在下面报 OPERATION_CONFLICT。
    const ledger = await ledgerFor(deps, root);
    if (ledger !== null) {
        const recorded = await ledger.findById(operationId);
        if (recorded !== null) {
            const mismatch = sessionMismatchWithRecord(recorded, session);
            if (mismatch !== null) {
                return {
                    envelope: env.blocked({
                        code: 'PROJECT_SESSION_MISMATCH',
                        operationId,
                        diagnostics: [env.diagnostic('PROJECT_SESSION_MISMATCH', mismatch, '换用新的 operation_id；同一操作不能跨会话续做')],
                    }),
                    root,
                    audit,
                };
            }
            const recordedEpoch = Number.isSafeInteger(recorded.data?.input_epoch)
                ? recorded.data.input_epoch
                : null;
            const expected = operationInputHash(deps, request.raw, {
                action: 'takeover',
                root,
                session,
                epoch: recordedEpoch,
            });
            if (expected !== null && recorded.input_hash !== expected) {
                return {
                    envelope: env.blocked({
                        code: 'OPERATION_CONFLICT',
                        operationId,
                        data: { ...data, binding_ref: null },
                        diagnostics: [env.diagnostic('OPERATION_CONFLICT', `同一 operation_id 的输入已改变（已存 input_hash=${String(recorded.input_hash)}）`, '同一 ID 必须保持原输入与提案；换了 recovery_ref/提议请用新的 operation_id')],
                    }),
                    root,
                    audit,
                };
            }
            const replay = await ledger.replayResult(operationId);
            if (replay !== null)
                return { envelope: replay, root, audit: null };
        }
    }
    if (request.proposalHash !== proposal.proposalHash) {
        return {
            envelope: env.blocked({
                code: 'OPERATION_CONFLICT',
                operationId,
                data: { ...data, binding_ref: null },
                diagnostics: [env.diagnostic('OPERATION_CONFLICT', `proposal_hash 与当前目录/能力映射/预算/绑定不符（接管前必须针对 epoch=${oldEpoch} 的绑定重新 inspect）`, NEXT_STEP_REPROPOSE)],
            }),
            root,
            audit,
        };
    }
    let result;
    try {
        result = await withProjectLock(deps, root, { session, operationId }, async () => {
            const freshBinding = typeof deps.compatibility?.readBinding === 'function'
                ? await deps.compatibility.readBinding(root)
                : { present: false, binding: null };
            if (!freshBinding.present || !freshBinding.binding) {
                return {
                    envelope: env.blocked({
                        code: 'PROJECT_NOT_CONFIGURED',
                        operationId,
                        diagnostics: [env.diagnostic('PROJECT_NOT_CONFIGURED', '锁内重读时 binding.json 不见了：项目状态与提议不一致', '先 action=inspect 核对项目，再决定 bind 还是 takeover')],
                    }),
                };
            }
            const freshEpoch = Number.isSafeInteger(freshBinding.binding.epoch) ? freshBinding.binding.epoch : 1;
            if (freshEpoch !== oldEpoch) {
                return {
                    envelope: env.blocked({
                        code: 'OPERATION_CONFLICT',
                        operationId,
                        diagnostics: [env.diagnostic('OPERATION_CONFLICT', `锁内重读时 epoch 已从 ${oldEpoch} 变成 ${freshEpoch}：另一个接管已经发生`, NEXT_STEP_REPROPOSE)],
                    }),
                };
            }
            if (ledger !== null) {
                await ledger.prepare(operationId, operationInputHash(deps, request.raw, {
                    action: 'takeover',
                    root,
                    session,
                    epoch: oldEpoch,
                }) ?? '0'.repeat(64), 'prepared', {
                    action: 'takeover',
                    session_id: session.session_id,
                    team_id: session.team_id,
                    epoch: oldEpoch,
                    input_epoch: oldEpoch,
                    recovery_ref: request.recoveryRef,
                    proposal_hash: proposal.proposalHash,
                });
            }
            // 先归档（不删原件），再建立新 epoch 的绑定。
            const archived = await deps.binding.archiveEpoch(root, {
                epoch: oldEpoch,
                recoveryRef: request.recoveryRef,
                reason: 'takeover',
            }, deps);
            const nextEpoch = oldEpoch + 1;
            const now = isoNow(deps);
            const proposalDigests = recordOf(proposal.digests);
            const bindingValue = {
                schema_version: 1,
                project_id: projectId,
                canonical_root: root,
                session_id: session.session_id,
                team_id: session.team_id,
                epoch: nextEpoch,
                ruleDigest: proposalDigests.ruleDigest,
                scriptDigest: proposalDigests.scriptDigest,
                catalogDigest: proposalDigests.catalogDigest,
                bindingDigest: proposal.proposalHash,
                adapter: { contract_version: ADAPTER_CONTRACT_VERSION, team: 'team-adapter', project: 'project-adapter' },
                capability: proposal.capabilityVersion,
                catalog: { version: proposal.catalogVersion, digest: proposalDigests.catalogDigest },
                budget: proposal.budget,
                template_id: proposal.templateId,
                target_kinds: [...proposal.targetKinds],
                recovered_from: { epoch: oldEpoch, recovery_ref: request.recoveryRef, history_dir: archived.history_dir },
                created_at: now,
                updated_at: now,
            };
            const rosterValue = {
                schema_version: 1,
                project_id: projectId,
                canonical_root: root,
                session_id: session.session_id,
                team_id: session.team_id,
                epoch: nextEpoch,
                binding_ref: deps.binding.BINDING_PATH,
                proposal_hash: proposal.proposalHash,
                template: { id: proposal.templateId, target_kinds: [...proposal.targetKinds] },
                posts: proposal.posts,
                members: [],
                tasks: [],
                capacity: proposal.capacity,
                recommended_members: proposal.recommendedMembers,
                recovered_from: { epoch: oldEpoch, recovery_ref: request.recoveryRef },
                created_at: now,
                updated_at: now,
            };
            await deps.binding.writeBinding(root, bindingValue, deps);
            await deps.binding.writeRoster(root, rosterValue, deps);
            const indexLink = await deps.binding
                .linkIndexPointers(root, [deps.binding.BINDING_PATH, deps.binding.ROSTER_PATH], deps)
                .catch((error) => ({ written: false, added: [], reason: thrownMessage(error) }));
            const diagnostics = [...proposal.gaps];
            if (indexLink.written !== true && indexLink.unchanged !== true) {
                diagnostics.push(env.diagnostic('INDEX_LINK_FAILED', `新 epoch 的 binding/roster 已写好，但 INDEX 指针没加上：${indexLink.reason ?? '未知原因'}`, '手工补 INDEX 手写区链接，或修好后重跑 takeover（同 operation_id 会重放）'));
            }
            const envelope = env.ok({
                operationId,
                data: { ...data, gaps: diagnostics, binding_ref: deps.binding.BINDING_PATH },
            });
            if (ledger !== null) {
                await ledger.advance(operationId, 'completed', {
                    epoch: nextEpoch,
                    epoch_before: oldEpoch,
                    binding_ref: deps.binding.BINDING_PATH,
                    history_dir: archived.history_dir,
                });
                await ledger.saveResult(operationId, envelope);
            }
            return { envelope };
        });
    }
    catch (error) {
        return { envelope: env.fromError(error, { operationId }), root, audit };
    }
    if (result.envelope.status === 'ok')
        audit.verdict = 'epoch_advanced';
    return { envelope: result.envelope, root, audit };
}
/** 工具名常量（index.js 注册时用；也便于诊断）。 */
export const ROSTER_TOOL_NAME = TOOL;
