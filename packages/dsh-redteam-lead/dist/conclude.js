/**
 * `rt_conclude`：提交校验 → 锚点闭集 → 归档 → 基准比对 + 一次性 seal → 更新事实 →
 * impact → index → `check --hashes` → 完成宿主任务 → 回执。
 *
 * 契约来源：编排契约「工具输入与输出」「交付、开始和结果分类」「锚点与封存绑定」
 * 「操作阶段与部分失败」，规格「双账本」「证据基线」「锚点闭集」，
 * 协作契约「工兵交回与 rt_conclude」「记录与写入归属」。
 *
 * 顺序**不可换**（ticket T7 的硬要求）：
 * `核对身份与前提 → 校验提交 → 锚点闭集 → 归档 → 基准比对 + seal → 更新事实 → impact →
 *  index → check --hashes`
 *
 * **seal 顺序裁决（DECISIONS D29）**：编排契约 §135 提到「seal 前先按事实解除会令全项目校验
 * 失败的旧状态」，但这里**保持 seal 在「更新事实」之前** —— 反过来会让 seal 封存的是
 * **尚未更新的旧事实**，比它想解决的问题更严重。若旧状态确实挡住 seal，如实返回
 * `CHECK_FAILED`，由 Lead 先按 skill 修好记录再以同一 operation ID 重入：不降门槛、不静默改序。
 *
 * 关键不变量：
 * - 只有 Lead 可调；工兵/裸子代理 `ROLE_REQUIRED` 且零副作用（身份先于任何写）。
 * - 同 `operation_id` 重放返回原回执（`replayed=true`），内容冲突 `OPERATION_CONFLICT`；
 *   **不同 operation ID 指向同一 dispatch/attempt** 也按业务身份去重，不重复封存/追加 history。
 * - `index` 必须在 `check` 之前（`check` 校验 INDEX 导航区字节相等）。
 * - `seal` 一次性：已有封存只校验复用，绝不重封存、绝不覆盖。
 * - 任何脚本失败 → `CHECK_FAILED`，保留 stdout/stderr/exitCode/阶段，**不完成任务、不降门槛**。
 * - 回执写不成 → `partial`；审计写失败 → `ok` + `audit_written=false`。
 * - 原生提前 `complete` 且无回执 → 标记 `UNREVIEWED_COMPLETION`：全部检查照跑，
 *   最后核对完成态而**不再调 complete**。
 *
 * handler 形状：`export async function handleConclude(ctx, input)` → `{ envelope }`，绝不 reject。
 */
import * as fsp from 'node:fs/promises';
import * as anchorsModule from './anchors.js';
import * as atomicModule from './atomic.js';
import * as auditModule from './audit.js';
import * as baselineModule from './baseline.js';
import * as envelopeModule from './envelope.js';
import * as errorsModule from './errors.js';
import * as identityModule from './identity.js';
import * as lockModule from './lock.js';
import * as operationModule from './operation.js';
import * as pathsModule from './paths.js';
import * as submissionModule from './submission.js';
import * as validateModule from './validate.js';
import { createProjectAdapter } from './project-adapter.js';
import { createTeamAdapter } from './team-adapter.js';
import { isRecord, recordOf, thrownMessage } from './guards.js';
/* ---- 未标注返回类型的模块结果（`submission` / `anchors` / `baseline`） ---- */
/**
 * 把「结构已知但没有返回类型标注」的模块结果贴回判别联合。
 *
 * 断言的理由：`submission` / `anchors` / `baseline` 三个模块的返回是
 * `{ok:true, …}` / `{ok:false, code, issues}` 两种对象，但函数**没有返回类型标注**，
 * `ok` 因此被拓宽成 `boolean`，TS 无法按判别联合收窄（报「属性可能不存在」）。
 * 本文件对它们的用法只有三条：`ok === true` 判成功、失败支读 `code`/`issues`、
 * 成功支读载荷 —— 与运行时逐字一致。断言不重建对象、不改判据、不补默认值，
 * 因此不改变任何字节，只把同一个对象贴回它本来的形状。
 */
function resultOf(value) {
    // 断言：T 由调用点按被调模块的真实返回形状给出，本函数只把同一个对象贴回它本来的形状。
    return value;
}
/** 七类结果允许的路线变化与成功依赖（编排契约的七行表，数据驱动）。 */
export const OUTCOME_RULES = Object.freeze({
    finding: Object.freeze({
        route_statuses: Object.freeze(['active', 'validated']),
        requires_runs: true,
        requires_anchors: true,
        success_dependency: 'validated_only',
    }),
    no_finding: Object.freeze({
        route_statuses: Object.freeze(['active', 'paused', 'validated']),
        requires_runs: true,
        requires_anchors: true,
        success_dependency: 'validated_only',
    }),
    refuted: Object.freeze({
        route_statuses: Object.freeze(['falsified']),
        requires_runs: true,
        requires_anchors: true,
        success_dependency: 'never',
    }),
    blocked: Object.freeze({
        route_statuses: Object.freeze(['blocked']),
        requires_runs: false,
        requires_anchors: false,
        success_dependency: 'never',
    }),
    budget_exhausted: Object.freeze({
        route_statuses: Object.freeze(['paused']),
        requires_runs: false,
        requires_anchors: false,
        success_dependency: 'never',
    }),
    failed: Object.freeze({
        route_statuses: Object.freeze(['blocked', 'paused']),
        requires_runs: true,
        requires_anchors: true,
        success_dependency: 'never',
    }),
    cancelled: Object.freeze({
        route_statuses: Object.freeze(['paused', 'superseded']),
        requires_runs: false,
        requires_anchors: false,
        success_dependency: 'never',
    }),
});
/** `$defs.routeStatus`。 */
export const ROUTE_STATUSES = Object.freeze([
    'planned',
    'active',
    'blocked',
    'paused',
    'validated',
    'falsified',
    'superseded',
]);
/** 收口回执目录（业务身份 = dispatch + attempt）。 */
export const RECEIPTS_DIR = 're/team/receipts';
/** 派发记录目录（T6 写、T7 读）。 */
export const DISPATCHES_DIR = 're/team/dispatches';
/** attempt 关联记录目录（T6 写、T7 读：task/member/契约摘要在契约落盘之后才存在）。 */
export const ATTEMPTS_DIR = 're/team/attempts';
const OPERATION_ID = /^[a-z0-9][a-z0-9_-]{0,95}$/;
const DISPATCH_ID = /^D-[a-z0-9][a-z0-9_-]{0,63}$/;
const ATTEMPT_ID = /^A-[0-9]{6}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REVIEW_FIELDS = Object.freeze([
    'outcome',
    'summary',
    'reason',
    'proposed_route_status',
    'evidence_run_ids',
    'anchor_refs',
    'limitations',
    'next_step',
]);
const DEFAULT_CLOCK = {
    now: () => Date.now(),
    isoNow: () => new Date().toISOString(),
};
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** 契约诊断（三字段封闭形状，见 `$defs.diagnostic`）。 */
function diag(code, reason, nextStep) {
    return envelopeModule.diagnostic(code, reason, nextStep);
}
/** 是否是契约里登记过的稳定错误码（是则收窄成 `string`，供信封直接用）。 */
function isStableCode(code) {
    return typeof code === 'string' && errorsModule.isErrorCode(code);
}
/**
 * 七类结果表里取一行；未知 outcome（含原型链上的名字）给 `undefined`。
 *
 * 与 `OUTCOME_RULES[outcome]` 的取值逐字等价（`Object.hasOwn` 不参与判断），
 * 只是让「可能没有这一行」在类型上成立。
 */
function outcomeRuleOf(outcome) {
    const table = OUTCOME_RULES;
    return table[outcome];
}
/**
 * 重放已落盘的信封：逐字保留 `{ ...stored, replayed: true }`。
 *
 * 断言的理由：`stored` 只可能由本文件写出（台账 `saveResult()` 与最终回执的 `result: envelope`），
 * 形状就是本文件的 `envelope`；这里不重建、不补字段，写坏的回执仍会在调用方的
 * `$defs.result` 校验里被拒（`index.ts` 的二次校验），所以类型口径不改变任何字节。
 */
function replayEnvelope(stored) {
    return resultOf({ ...recordOf(stored), replayed: true });
}
/**
 * 审计条目里的列值。
 *
 * `audit.AuditEntry` 把 `member` 声明成 `string | null`，但 `audit.column()` 本身按未知处理
 * （数字/布尔会被转成文本）。派发记录里的成员是任意 JSON 值，这里保持原值 —— 断言的理由：
 * 转换反而会改变 `audit.jsonl` 的字节，而写入方接受未知值。
 */
function auditColumn(value) {
    // 断言：写入方（audit.column）接受未知值并自己转文本；这里保持原值，不改变 audit.jsonl 字节。
    return value;
}
/** 依赖解析：deps 里给了就用，没给（或为 null）就用本包真实模块。 */
function resolveModules(ctx) {
    // 逐字保留「ctx/deps 不是对象就当作没有」的降级（handler 绝不 reject）。
    // 两段式断言的理由：`Record<string, unknown>` 与 SEAMS §1 的 `Deps` 没有索引签名重叠，
    // 不能单段 `as`；而装配层给的确实就是 `Deps` 形状 —— 缺的键由下面的 `??` 回落到本包实现。
    const deps = recordOf(recordOf(ctx).deps);
    return {
        envelope: deps.envelope ?? envelopeModule,
        errors: deps.errors ?? errorsModule,
        validate: deps.validate ?? validateModule,
        paths: deps.paths ?? pathsModule,
        atomic: deps.atomic ?? atomicModule,
        lock: deps.lock ?? lockModule,
        identity: deps.identity ?? identityModule,
        operation: deps.operation ?? operationModule,
        audit: deps.audit ?? auditModule,
        submission: deps.submission ?? submissionModule,
        anchors: deps.anchors ?? anchorsModule,
        baseline: deps.baseline ?? baselineModule,
        clock: deps.clock ?? DEFAULT_CLOCK,
        fs: deps.fs ?? fsp,
    };
}
/** 是团队适配器实例：`getTask` 是 SEAMS §1 实例的判别方法（逐字保留原有的存在性判断）。 */
function isTeamAdapter(value) {
    return isRecord(value) && typeof value.getTask === 'function';
}
/** 是项目适配器实例：`readRoute` 是本包实例的判别方法。 */
function isProjectAdapter(value) {
    return isRecord(value) && typeof value.readRoute === 'function';
}
/** 是适配器工厂（SEAMS §1 的另一种 deps 形状）。 */
function isAdapterFactory(value) {
    return typeof value === 'function';
}
async function resolveTeam(ctx, root) {
    const view = recordOf(ctx);
    const dep = recordOf(view.deps).teamAdapter;
    if (isTeamAdapter(dep))
        return dep;
    if (isAdapterFactory(dep)) {
        try {
            const created = await dep({
                services: view.services,
                exec: view.exec,
                agent: recordOf(view.exec).agent,
                config: view.config,
                projectRoot: root,
                deps: view.deps,
            });
            if (isTeamAdapter(created))
                return created;
        }
        catch {
            return null;
        }
        return null;
    }
    const services = recordOf(view.services);
    if (services.agentTeams !== undefined) {
        return createTeamAdapter({ services: view.services, exec: view.exec, config: view.config, projectRoot: root });
    }
    return null;
}
async function resolveProject(ctx, root) {
    const view = recordOf(ctx);
    const dep = recordOf(view.deps).projectAdapter;
    if (isProjectAdapter(dep))
        return dep;
    if (isAdapterFactory(dep)) {
        try {
            const created = await dep({ projectRoot: root, config: view.config, deps: view.deps });
            if (isProjectAdapter(created))
                return created;
        }
        catch {
            return null;
        }
        return null;
    }
    return null;
}
function sessionOf(ctx, caller) {
    const fromCaller = typeof caller?.root === 'string' && caller.root.length > 0 ? caller.root : null;
    const view = recordOf(ctx);
    return fromCaller
        ?? recordOf(view.config).sessionId
        ?? recordOf(view.exec).sessionId
        ?? recordOf(recordOf(view.services).agentTeams).teamId
        ?? null;
}
function epochOf(ctx) {
    const value = recordOf(recordOf(ctx).config).epoch;
    return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}
/* -------------------------------------------------------------------------- */
/* 输入形状                                                                    */
/* -------------------------------------------------------------------------- */
/**
 * 入参形状检查（schema 之外的最后一道防线：测试与直接调用都可能绕过宿主校验）。
 * @returns {{ok: true, value: object} | {ok: false, issues: object[]}}
 */
export function checkInputShape(input) {
    const issues = [];
    const bad = (reason, nextStep) => issues.push(diag('INVALID_ARGUMENT', reason, nextStep));
    if (!isPlainObject(input)) {
        return { ok: false, issues: [diag('INVALID_ARGUMENT', 'rt_conclude 的输入必须是对象', '按 $defs.concludeInput 传参')] };
    }
    if (typeof input.project_root !== 'string' || input.project_root.trim().length === 0) {
        bad('缺少 project_root', '传入显式选择的本地分析目录绝对路径');
    }
    if (typeof input.operation_id !== 'string' || !OPERATION_ID.test(input.operation_id)) {
        bad(`operation_id 形状非法：${JSON.stringify(input.operation_id)}`, '使用 $defs.id 允许的小写字母/数字/下划线/短横线形状');
    }
    if (typeof input.dispatch_id !== 'string' || !DISPATCH_ID.test(input.dispatch_id)) {
        bad(`dispatch_id 形状非法：${JSON.stringify(input.dispatch_id)}`, '使用 D-<小写字母数字-> 形状');
    }
    if (typeof input.attempt_id !== 'string' || !ATTEMPT_ID.test(input.attempt_id)) {
        bad(`attempt_id 形状非法：${JSON.stringify(input.attempt_id)}`, '使用 A-<六位数字> 形状');
    }
    if (typeof input.task_id !== 'string' || input.task_id.trim().length === 0) {
        bad('缺少 task_id', '传入派发时登记的宿主 task id');
    }
    const revision = input.expected_revision;
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
        bad('expected_revision 必须是 >=0 的整数', '传入读任务时的 revision（CAS）');
    }
    if (typeof input.submission_ref !== 'string' || input.submission_ref.length === 0) {
        bad('缺少 submission_ref', '传入当前 attempt 工作目录内的 submission.json 项目相对路径');
    }
    if (typeof input.submission_sha256 !== 'string' || !SHA256.test(input.submission_sha256)) {
        bad('submission_sha256 必须是 64 位小写十六进制', '重算提交文件字节哈希');
    }
    const review = input.review;
    if (!isPlainObject(review)) {
        bad('缺少 review', '按 $defs.review 给出 Lead 的审阅结论');
    }
    else {
        for (const field of REVIEW_FIELDS) {
            if (!Object.hasOwn(review, field))
                bad(`review 缺少必填字段 ${field}`, '按 $defs.review 补齐');
        }
        const outcome = review.outcome;
        if (typeof outcome !== 'string' || !submissionModule.OUTCOMES.includes(outcome)) {
            bad(`review.outcome 不在七类结果里：${JSON.stringify(outcome)}`, `outcome 只能取 ${submissionModule.OUTCOMES.join('|')}`);
        }
        const proposed = review.proposed_route_status;
        if (typeof proposed !== 'string' || !ROUTE_STATUSES.includes(proposed)) {
            bad(`review.proposed_route_status 不是 skill 路线状态：${JSON.stringify(proposed)}`, `只能取 ${ROUTE_STATUSES.join('|')}`);
        }
        const evidenceRunIds = review.evidence_run_ids;
        if (!Array.isArray(evidenceRunIds) || evidenceRunIds.some((id) => typeof id !== 'string')) {
            bad('review.evidence_run_ids 必须是 RUN 标识数组', '给出本次判定依据的 RUN ID 列表');
        }
        if (!Array.isArray(review.anchor_refs)) {
            bad('review.anchor_refs 必须是数组', '没有锚点时给 []');
        }
        const limitations = review.limitations;
        if (!Array.isArray(limitations) || limitations.some((item) => typeof item !== 'string')) {
            bad('review.limitations 必须是字符串数组', '如实记录局限；没有也要给 []');
        }
        if (review.next_step !== null && typeof review.next_step !== 'string') {
            bad('review.next_step 只能是字符串或 null', '给出具体下一步，或 null');
        }
    }
    if (issues.length > 0)
        return { ok: false, issues };
    // 断言的理由：上面逐字段核对了八个必填项与 review 的八字段；`value` 交回的是同一个入参对象
    // （不复制、不补默认值），所以这里的形状就是 `ConcludeInput` 的成立条件。
    return { ok: true, value: resultOf(input) };
}
/**
 * 实际生效的锚点要求：未开始即阻塞/取消的交付不强制补造成功锚点
 * （模板的成功锚点要求只适用于 `requires_runs` 的结果行）。
 *
 * @param {{ outcome: string, runIds?: string[], requiredKinds?: string[] }} input
 * @returns {string[]}
 */
export function effectiveRequiredKinds(input) {
    const required = Array.isArray(input.requiredKinds) ? [...input.requiredKinds] : [];
    const rule = outcomeRuleOf(input.outcome);
    if (rule === undefined)
        return required;
    if (rule.requires_runs !== true && Array.isArray(input.runIds) && input.runIds.length === 0)
        return [];
    return required;
}
/**
 * 按七类结果检查交付门槛（成功/反证型合并后的锚点要求、未开始即阻塞的诊断依据）。
 *
 * @param {object} input
 * @param {string} input.outcome
 * @param {string} input.proposedRouteStatus
 * @param {string[]} input.runIds
 * @param {string[]} input.evidenceRunIds
 * @param {string[]} input.requiredKinds 已经过 `effectiveRequiredKinds`
 * @param {string[]} input.anchorKinds
 * @param {string|null} input.stateRecoveryRef
 * @param {string} input.submissionOutcome
 * @returns {{ok:true, successDependency:boolean} | {ok:false, code:'CHECK_FAILED'|'SUBMISSION_INVALID', issues:object[]}}
 */
export function evaluateDelivery(input) {
    const issues = [];
    const rule = outcomeRuleOf(input.outcome);
    if (rule === undefined) {
        return {
            ok: false,
            code: 'CHECK_FAILED',
            issues: [diag('CHECK_FAILED', `未知 outcome：${JSON.stringify(input.outcome)}`, `outcome 只能取 ${Object.keys(OUTCOME_RULES).join('|')}`)],
        };
    }
    if (!rule.route_statuses.includes(input.proposedRouteStatus)) {
        return {
            ok: false,
            code: 'CHECK_FAILED',
            issues: [
                diag('CHECK_FAILED', `outcome=${input.outcome} 时 proposed_route_status 只能取 ${rule.route_statuses.join('|')}，收到 ${input.proposedRouteStatus}`, '按编排契约的七行结果表选允许的路线变化；越界的路线变化不放行'),
            ],
        };
    }
    if (input.submissionOutcome !== input.outcome) {
        issues.push(diag('SUBMISSION_INVALID', `提交的 outcome=${input.submissionOutcome} 与 review.outcome=${input.outcome} 不一致`, 'Lead 的审阅结论必须与工兵提交一致；要改结论就另交新提交'));
    }
    const missingEvidence = input.evidenceRunIds.filter((runId) => !input.runIds.includes(runId));
    if (missingEvidence.length > 0) {
        issues.push(diag('SUBMISSION_INVALID', `review.evidence_run_ids 含未在提交 run_ids 里声明的 RUN：${missingEvidence.join(', ')}`, '证据 RUN 必须由提交声明；不要引用别的 attempt 的运行'));
    }
    if (rule.requires_runs && input.runIds.length === 0) {
        issues.push(diag('SUBMISSION_INVALID', `outcome=${input.outcome} 必须交回至少一个已完成运行`, '按该 outcome 的门槛补齐有效 RUN 与定位；未开始就阻塞请改用 blocked'));
    }
    if (!rule.requires_runs && input.runIds.length === 0) {
        const recovery = input.stateRecoveryRef;
        if (typeof recovery !== 'string' || recovery.trim().length === 0) {
            issues.push(diag('SUBMISSION_INVALID', `outcome=${input.outcome} 且 run_ids=[] 时，必须用 state_recovery_ref 引用保存的就绪检查或中断核查`, '把就绪检查/中断核查记录保存进项目，并在 submission.state_recovery_ref 引用它'));
        }
    }
    if (rule.requires_anchors) {
        const present = new Set(input.anchorKinds);
        const missing = input.requiredKinds.filter((kind) => !present.has(kind));
        if (missing.length > 0) {
            issues.push(diag('SUBMISSION_INVALID', `本次交付要求 ${missing.join(', ')} 锚点，但没有任何有效的该类锚点`, '按 $defs.anchorRef 提交缺失类型的锚点（岗位默认 ∪ 契约 evidence_required）'));
        }
    }
    if (issues.length > 0)
        return { ok: false, code: 'SUBMISSION_INVALID', issues };
    const successDependency = rule.success_dependency === 'validated_only' && input.proposedRouteStatus === 'validated';
    return { ok: true, successDependency };
}
/* -------------------------------------------------------------------------- */
/* 路线更新                                                                    */
/* -------------------------------------------------------------------------- */
const TERMINAL_ROUTE_STATUSES = new Set(['validated', 'falsified', 'superseded']);
const FALSIFICATION_FIELDS = Object.freeze([
    'criterion',
    'coverage',
    'control',
    'reopen_when',
    'observation_refs',
    'control_refs',
]);
function closureForStatus({ nextStatus, route, review }) {
    if (!TERMINAL_ROUTE_STATUSES.has(nextStatus))
        return { ok: true, closure: route.closure ?? null };
    const base = isPlainObject(route.closure) ? route.closure : {};
    const scope = typeof base.scope === 'string' && base.scope.length > 0
        ? base.scope
        : `targets: ${(Array.isArray(route.target_ids) ? route.target_ids : []).join(', ')}`;
    const limitations = Array.isArray(review.limitations) && review.limitations.length > 0
        ? review.limitations.join('；')
        : (typeof base.limitations === 'string' && base.limitations.length > 0 ? base.limitations : '（review 未列局限）');
    const evidence = Array.isArray(review.evidence_run_ids) && review.evidence_run_ids.length > 0
        ? review.evidence_run_ids
        : (Array.isArray(base.evidence) ? base.evidence : []);
    const closure = { ...base, summary: review.summary, scope, limitations, evidence };
    if (nextStatus === 'falsified') {
        const missing = FALSIFICATION_FIELDS.filter((field) => {
            const value = closure[field];
            if (Array.isArray(value))
                return value.length === 0;
            return typeof value !== 'string' || value.trim().length === 0;
        });
        if (missing.length > 0) {
            return {
                ok: false,
                issues: [
                    diag('CHECK_FAILED', `refuted 需要 skill 的完整反证 closure，缺少：${missing.join(', ')}`, '先按 skill 在路线 closure 里记录预先反证条件/覆盖/对照/重开条件与观测-对照引用（Lead 的正式记录），再收口；不接受只靠本次 review 造 closure'),
                ],
            };
        }
    }
    if (nextStatus === 'superseded' && typeof closure.replacement !== 'string') {
        return {
            ok: false,
            issues: [
                diag('CHECK_FAILED', 'superseded 需要 closure.replacement 指向替代路线', '按 skill 记录替代路线后再收口'),
            ],
        };
    }
    return { ok: true, closure };
}
/**
 * 收口**受管**的路线字段：本模块只会改这些键，`changed` 也只看这些键。
 *
 * 其余键（`id`/`question`/`experiment`/`budget`/…）靠 `{...route}` 原样带回，不参与判定。
 */
const MANAGED_ROUTE_FIELDS = Object.freeze(['status', 'evidence', 'state_reason', 'resume_when', 'closure']);
/**
 * 依据 review 生成路线更新（history / closure / evidence / state_reason）。
 *
 * 只写 review 有依据的判定：不臆造 closure 里的实验事实（缺就拒绝，见 `closureForStatus`）。
 *
 * 两个返回位分得很开，调用方不要混用：
 * - `historyAppended`：**只**随真实状态迁移为真（`from !== nextStatus`）；
 * - `changed`：任一受管字段（`MANAGED_ROUTE_FIELDS`）与入参路线不同即为真 ——
 *   状态没变但 `evidence`/`state_reason`/`resume_when`/`closure` 变了，也必须落盘。
 *   也不得恒为真：那样每次收口都会给路线文件打一次戳（有专门用例守着）。
 *
 * @returns {{ok:true, route:object, changed:boolean, historyAppended:boolean}
 *   | {ok:false, code:'CHECK_FAILED', issues:object[]}}
 */
export function buildRouteUpdate({ route, review, nextStatus, at }) {
    if (!ROUTE_STATUSES.includes(nextStatus)) {
        return { ok: false, code: 'CHECK_FAILED', issues: [diag('CHECK_FAILED', `未知路线状态：${nextStatus}`, '按 skill 的路线状态枚举取值')] };
    }
    const from = route.status;
    const closureResult = closureForStatus({ nextStatus, route, review });
    if (closureResult.ok !== true)
        return { ok: false, code: 'CHECK_FAILED', issues: closureResult.issues };
    const evidence = Array.isArray(route.evidence) ? [...route.evidence] : [];
    for (const runId of Array.isArray(review.evidence_run_ids) ? review.evidence_run_ids : []) {
        if (!evidence.includes(runId))
            evidence.push(runId);
    }
    let resumeWhen = route.resume_when ?? '';
    if (nextStatus === 'blocked' || nextStatus === 'paused') {
        resumeWhen = typeof review.next_step === 'string' && review.next_step.trim().length > 0
            ? review.next_step
            : (typeof route.resume_when === 'string' ? route.resume_when : '');
        if (resumeWhen.trim().length === 0) {
            return {
                ok: false,
                code: 'CHECK_FAILED',
                issues: [
                    diag('CHECK_FAILED', `${nextStatus} 状态需要具体的恢复条件（resume_when）`, '在 review.next_step 里写清恢复条件；缺恢复条件的阻塞/暂停不放行'),
                ],
            };
        }
    }
    const updated = {
        ...route,
        status: nextStatus,
        evidence,
        state_reason: typeof review.reason === 'string' && review.reason.trim().length > 0 ? review.reason : route.state_reason,
        resume_when: resumeWhen,
        closure: closureResult.closure,
    };
    /* ---- 「改了什么」与「要不要落盘」是两件事 ------------------------------ */
    if (from === nextStatus) {
        // 状态没变 → 不追加 history（history 只记真实的 status 迁移）。
        // 但「history 要不要长」与「文件要不要写」是两个问题：任一**受管字段**与磁盘上的路线不同就得写 ——
        // finding 落在已经是 active 的路线上时状态不变，`evidence` 却要补进本 RUN。
        // 早期版本在这里直接返回 `changed:false`，于是内存里合并好的证据永远不落盘
        //（L3 实测：路线 `active` + `evidence: []`，而 RUN 已 seal 并回执）。
        const managedChanged = MANAGED_ROUTE_FIELDS.some((key) => validateModule.canonicalJson(route[key]) !== validateModule.canonicalJson(updated[key]));
        return { ok: true, route: updated, changed: managedChanged, historyAppended: false };
    }
    const history = Array.isArray(route.history) ? [...route.history] : [];
    const event = {
        at,
        from,
        to: nextStatus,
        reason: review.reason,
        evidence: Array.isArray(review.evidence_run_ids) ? [...review.evidence_run_ids] : [],
    };
    if (TERMINAL_ROUTE_STATUSES.has(from)) {
        event.prior_closure = route.closure ?? { summary: route.state_reason ?? '历史闭包未记录' };
    }
    history.push(event);
    updated.history = history;
    return { ok: true, route: updated, changed: true, historyAppended: true };
}
/**
 * 从 `impact` 报告里挑出影响本路线的条目。
 * @returns {{items: object[], pendingReviews: object[], disputeImpacts: object[], recovery: object[]}}
 */
export function routeImpactOf(impactJson, routeId) {
    const view = recordOf(impactJson);
    const pending = Array.isArray(view.pending_reviews) ? view.pending_reviews : [];
    const disputes = Array.isArray(view.dispute_impacts) ? view.dispute_impacts : [];
    const recovery = Array.isArray(view.recovery_pending) ? view.recovery_pending : [];
    const pendingReviews = pending.filter((item) => recordOf(item).route_id === routeId);
    const disputeImpacts = disputes.filter((item) => recordOf(item).route_id === routeId);
    const recoveryItems = recovery.filter((item) => recordOf(item).route_id === routeId || item === routeId);
    return {
        pendingReviews,
        disputeImpacts,
        recovery: recoveryItems,
        items: [...pendingReviews, ...disputeImpacts],
    };
}
/* -------------------------------------------------------------------------- */
/* 主流程                                                                      */
/* -------------------------------------------------------------------------- */
/**
 * @param {object} ctx HandlerCtx（SEAMS §1）
 * @param {object} rawInput 已通过 `$defs.concludeInput` 校验（本文件不信任这一点）
 * @returns {Promise<{ envelope: object }>}
 */
export async function handleConclude(ctx, rawInput) {
    const en = resolveModules(ctx).envelope;
    const raw = recordOf(rawInput);
    const operationId = typeof raw.operation_id === 'string' && OPERATION_ID.test(raw.operation_id)
        ? raw.operation_id
        : null;
    let phase = 'preflight';
    // 副作用分界线（见步骤 5 的长注释）：归档成功之后，任何失败都不能再报「什么都没发生」。
    let archived = false;
    try {
        const modules = resolveModules(ctx);
        const shape = checkInputShape(rawInput);
        if (shape.ok !== true) {
            return {
                envelope: en.error({
                    code: 'INVALID_ARGUMENT',
                    operationId,
                    diagnostics: shape.issues,
                    data: { phase },
                }),
            };
        }
        const input = shape.value;
        /* ---- 0. 身份（先于任何写入） ---------------------------------------- */
        const caller = await modules.identity.resolveCaller(ctx);
        if (caller.ok !== true) {
            return {
                envelope: en.error({
                    code: caller.code,
                    operationId,
                    diagnostics: [caller.diagnostic],
                    data: { phase },
                }),
            };
        }
        if (caller.role !== 'lead') {
            return {
                envelope: en.error({
                    code: 'ROLE_REQUIRED',
                    operationId,
                    reason: `rt_conclude 仅限 Lead 调用，当前调用者角色是 ${caller.role}（${caller.name ?? 'unknown'}）`,
                    nextStep: '由本团队 Lead 发起收口；工兵只提交结果，不能用任何入参自报 Lead 身份',
                    data: { phase },
                }),
            };
        }
        /* ---- 1. 项目根与依赖 ------------------------------------------------- */
        let root;
        try {
            root = await modules.paths.normalizeProjectRoot(input.project_root);
        }
        catch (error) {
            return { envelope: en.fromError(error, { operationId, data: { phase } }) };
        }
        const team = await resolveTeam(ctx, root);
        if (team === null) {
            return {
                envelope: en.blocked({
                    code: 'TEAM_SERVICE_UNAVAILABLE',
                    operationId,
                    reason: '没有可用的团队服务，无法核对/完成宿主任务',
                    nextStep: '确认本 bundle 在 Agent 团队会话内挂载（宿主注入 agentTeams），或跑 node bin/doctor.mjs 诊断',
                    data: { phase },
                }),
            };
        }
        const project = await resolveProject(ctx, root);
        if (project === null) {
            return {
                envelope: en.blocked({
                    code: 'PROJECT_NOT_CONFIGURED',
                    operationId,
                    reason: '没有可用的项目管理 adapter，无法跑 seal/impact/index/check',
                    nextStep: '先用 rt_roster(action=bind) 完成项目接入并确认项目副本含团队规则',
                    data: { phase },
                }),
            };
        }
        const session = sessionOf(ctx, caller);
        const inputHash = modules.validate.operationInputHash(input, {
            tool: 'rt_conclude',
            action: 'conclude',
            project: root,
            session,
            epoch: epochOf(ctx),
        });
        const ledger = modules.operation.createOperationLedger({ root, clock: modules.clock });
        /* ---- 1a. 重放 / 冲突（无锁只读） ------------------------------------ */
        const existing = await ledger.findById(input.operation_id);
        if (existing !== null && existing.input_hash !== inputHash) {
            return {
                envelope: en.blocked({
                    code: 'OPERATION_CONFLICT',
                    operationId,
                    reason: `同一 operation ID 的输入已改变：${input.operation_id}（已存阶段 ${existing.phase}）`,
                    nextStep: '同一 ID 必须保持原输入与 expected_revision；换了请求内容请用新的 operation ID',
                    data: { phase: failurePhaseOf(existing.phase) },
                }),
            };
        }
        if (existing !== null && isPlainObject(existing.result)) {
            return { envelope: replayEnvelope(existing.result) };
        }
        /* ---- 2. 项目锁（所有写入持有） --------------------------------------- */
        let held = null;
        try {
            held = await modules.lock.acquire(root, {
                session: typeof session === 'string' && session.length > 0 ? session : 'conclude',
                operation: input.operation_id,
                now: modules.clock.now?.() ?? Date.now(),
            });
        }
        catch (error) {
            return { envelope: en.fromError(error, { operationId, data: { phase } }) };
        }
        try {
            /* ---- 2a. 锁内复核台账与业务身份去重 ------------------------------- */
            const current = await ledger.findById(input.operation_id);
            if (current !== null && current.input_hash !== inputHash) {
                return {
                    envelope: en.blocked({
                        code: 'OPERATION_CONFLICT',
                        operationId,
                        reason: `同一 operation ID 的输入已改变：${input.operation_id}（已存阶段 ${current.phase}）`,
                        nextStep: '同一 ID 必须保持原输入与 expected_revision；换了请求内容请用新的 operation ID',
                        data: { phase: failurePhaseOf(current.phase) },
                    }),
                };
            }
            if (current !== null && isPlainObject(current.result)) {
                return { envelope: replayEnvelope(current.result) };
            }
            const receiptRef = receiptPathFor(input.dispatch_id, input.attempt_id);
            const business = await readBusinessReceipt({
                root,
                ref: receiptRef,
                fs: modules.fs,
                paths: modules.paths,
                dispatchId: input.dispatch_id,
                attemptId: input.attempt_id,
            });
            if (business.ok !== true) {
                return {
                    envelope: en.blocked({
                        code: 'RECOVERY_REQUIRED',
                        operationId,
                        diagnostics: business.issues,
                        data: { phase: 'needs_recovery' },
                    }),
                };
            }
            if (business.exists === true) {
                return { envelope: replayEnvelope(business.receipt.result) };
            }
            await ledger.prepare(input.operation_id, inputHash, 'integrating', {
                dispatch_id: input.dispatch_id,
                attempt_id: input.attempt_id,
                task_id: input.task_id,
            });
            phase = 'integrating';
            /* ---- 步骤 1：核对身份与前提 --------------------------------------- */
            const dispatch = await readDispatchContext({
                root,
                dispatchId: input.dispatch_id,
                fs: modules.fs,
                paths: modules.paths,
            });
            if (dispatch.ok !== true) {
                return { envelope: en.blocked({ code: dispatch.code, operationId, diagnostics: dispatch.issues, data: { phase } }) };
            }
            const premise = await checkPremises({
                envelope: en,
                team,
                project,
                dispatch: dispatch.record,
                input,
                operationId,
                root,
            });
            if (premise.ok !== true)
                return { envelope: premise.envelope };
            const { task, route, premiseImpact } = premise;
            /* ---- 步骤 2：校验提交 -------------------------------------------- */
            const submitted = resultOf(await modules.submission.readVerifiedSubmission({
                root,
                submissionRef: input.submission_ref,
                expectedSha256: input.submission_sha256,
                dispatchId: input.dispatch_id,
                attemptId: input.attempt_id,
                paths: modules.paths,
                fs: modules.fs,
                atomic: modules.atomic,
            }));
            if (submitted.ok !== true) {
                return {
                    envelope: failWithIssues(en, {
                        code: submitted.code,
                        operationId,
                        issues: submitted.issues,
                        data: { phase },
                    }),
                };
            }
            const submission = submitted.submission;
            const submissionIssues = crossCheckSubmission({ submission, dispatch: dispatch.record, taskId: input.task_id });
            if (submissionIssues.length > 0) {
                return {
                    envelope: failWithIssues(en, { code: 'SUBMISSION_INVALID', operationId, issues: submissionIssues, data: { phase } }),
                };
            }
            /* ---- 步骤 3：RUN 身份 + 锚点闭集 ---------------------------------- */
            const runs = [];
            for (const runId of submission.run_ids) {
                const read = recordOf(await project.readRun(runId));
                if (read.ok !== true) {
                    if (read.code === 'PROJECT_NOT_CONFIGURED') {
                        return {
                            envelope: failWithIssues(en, {
                                code: 'SUBMISSION_INVALID',
                                operationId,
                                issues: [diag('SUBMISSION_INVALID', `提交声明的 ${runId} 在本项目里不存在（${read.reason ?? 'not found'}）`, 'RUN 记录必须先按 skill 归档到 re/runs/<RUN>/run.json，再声明在提交里')],
                                data: { phase },
                            }),
                        };
                    }
                    return {
                        envelope: failWithIssues(en, {
                            code: 'RECOVERY_REQUIRED',
                            operationId,
                            issues: [diag('RECOVERY_REQUIRED', `读 ${runId} 的 run.json 失败：${read.reason ?? read.code ?? 'unknown'}`, 'RUN 记录损坏要先按恢复流程核对；不要当作没有该运行')],
                            data: { phase },
                        }),
                    };
                }
                const run = recordOf(read.run);
                runs.push({
                    run_id: runId,
                    status: run.status ?? 'unknown',
                    artifacts: Array.isArray(run.artifacts) ? run.artifacts : [],
                    record: read.run,
                });
            }
            const artifactsForRun = (runId) => (runs.find((item) => item.run_id === runId)?.artifacts ?? [])
                .map((artifact) => recordOf(artifact).path)
                .filter((value) => typeof value === 'string');
            const merged = resultOf(modules.anchors.mergeRequiredKinds({
                anchorsRequired: dispatch.record.anchors_required,
                evidenceRequired: dispatch.record.evidence_required,
            }));
            if (merged.issues.length > 0) {
                return {
                    envelope: failWithIssues(en, { code: 'SUBMISSION_INVALID', operationId, issues: merged.issues, data: { phase } }),
                };
            }
            const requiredKinds = effectiveRequiredKinds({
                outcome: input.review.outcome,
                runIds: submission.run_ids,
                requiredKinds: merged.kinds,
            });
            const anchorRefs = [
                ...(Array.isArray(submission.anchor_refs) ? submission.anchor_refs : []),
                ...(Array.isArray(input.review.anchor_refs) ? input.review.anchor_refs : []),
            ];
            const anchorCheck = resultOf(modules.anchors.validateAnchorSet({
                refs: anchorRefs,
                requiredKinds,
                runIds: submission.run_ids,
                artifactsForRun,
            }));
            if (anchorCheck.ok !== true) {
                return {
                    envelope: failWithIssues(en, { code: anchorCheck.code, operationId, issues: anchorCheck.issues, data: { phase } }),
                };
            }
            const delivery = evaluateDelivery({
                outcome: input.review.outcome,
                proposedRouteStatus: input.review.proposed_route_status,
                runIds: submission.run_ids,
                evidenceRunIds: input.review.evidence_run_ids,
                requiredKinds,
                anchorKinds: anchorRefs.map((ref) => recordOf(ref).kind).filter((kind) => typeof kind === 'string'),
                stateRecoveryRef: submission.state_recovery_ref,
                submissionOutcome: submission.outcome,
            });
            if (delivery.ok !== true) {
                return {
                    envelope: failWithIssues(en, { code: delivery.code, operationId, issues: delivery.issues, data: { phase } }),
                };
            }
            /* ---- 步骤 4：基准比对（必须在任何正式写盘之前） --------------------- */
            // 契约「锚点与封存绑定」：收口**先与派发时冻结的快照比较**，既存项删除/读取失败/内容变化
            // 都必须在写盘之前报错。快照里除了目标字节与 seal 文件自身，还有**所依赖既有已封存产物的
            // 身份**（T17 起真实填充）：篡改已封存 RUN 的产物只有这一步能发现 —— 排在归档之后就只能
            // 拿到 partial（正式 re/runs/** 与回执目录已有字节），项目停在半整合状态。
            const loaded = resultOf(await modules.baseline.loadBaseline({
                root,
                dispatchId: input.dispatch_id,
                ref: dispatch.record.baseline_ref,
                embedded: dispatch.record.baseline,
                fs: modules.fs,
                paths: modules.paths,
            }));
            if (loaded.ok !== true) {
                return {
                    envelope: failWithIssues(en, { code: loaded.code, operationId, issues: loaded.issues, data: { phase } }),
                };
            }
            // `compareBaseline()` 只认「基准里冻结的既有 seal」，并按 `projectAdapter.readSeals()`
            // 自己重读当前清单（见 baseline.ts）；步骤 6 的 `sealList` 是给 `sealRunSet()` 用的，
            // 不重复传给比对（传了也不参与判定）。
            const compared = resultOf(await modules.baseline.compareBaseline({
                root,
                baseline: loaded.baseline,
                projectAdapter: project,
                fs: modules.fs,
                paths: modules.paths,
                atomic: modules.atomic,
            }));
            if (compared.ok !== true) {
                return {
                    envelope: failWithIssues(en, { code: compared.code, operationId, issues: compared.issues, data: { phase } }),
                };
            }
            /* ---- 步骤 5：归档 -------------------------------------------------- */
            // ▲ 副作用分界线（编排契约「操作阶段与部分失败」）：
            //   - 在此之前：前置拒绝 → `status=blocked`，语义是「什么都没发生」——没有新成员、新任务、
            //     正式路线变更，也没有正式证据字节。台账 `re/team/operations/**` 只是本插件的幂等簿记
            //     （每次 conclude 都会写），不算「正式事实」，不推进这条分界线。
            //   - `archiveAttempt()` 成功之后：正式 `re/runs/**` 与回执目录里已经有字节，此后**任何**失败
            //     一律 `status=partial`，并在 `data.phase` 带上阶段。Lead 读到 blocked 会以为可以原地重派；
            //     读到 partial 才知道必须按「已有字节」处置（保留证据、同 operation ID 前移恢复）。
            phase = 'integrating';
            const archive = await archiveAttempt({
                modules,
                root,
                dispatchId: input.dispatch_id,
                attemptId: input.attempt_id,
                operationId: input.operation_id,
                submission,
                submissionBytes: submitted.bytes,
                submissionSha: submitted.sha256,
                submissionRef: submitted.relative_path,
                runs,
                now: modules.clock.isoNow?.() ?? new Date().toISOString(),
            });
            if (archive.ok !== true) {
                return {
                    envelope: failWithIssues(en, {
                        code: archive.code,
                        operationId,
                        issues: archive.issues,
                        data: { phase },
                        status: archive.status,
                    }),
                };
            }
            // 正式 re/runs/** 与回执目录已经有字节：从这一行之后，失败一律 partial。
            archived = true;
            /* ---- 步骤 6：seal ------------------------------------------------ */
            const sealList = recordOf(await project.readSeals());
            if (sealList.ok !== true) {
                return {
                    envelope: failWithIssues(en, {
                        code: 'RECOVERY_REQUIRED',
                        operationId,
                        issues: [diag('RECOVERY_REQUIRED', `读不了 re/seals 清单：${sealList.reason ?? sealList.code ?? 'unknown'}`, '确认 re/seals 可读；读失败不能当作没有封存')],
                        data: { phase },
                        status: 'partial',
                    }),
                };
            }
            const sealed = resultOf(await modules.baseline.sealRunSet({
                projectAdapter: project,
                runs: runs.map((item) => ({ run_id: item.run_id, status: item.status })),
                seals: sealList.seals,
            }));
            if (sealed.ok !== true) {
                await recordStageFailure(modules, root, input, {
                    stage: 'seal',
                    run_id: sealed.run_id ?? null,
                    exit_code: sealed.exit_code ?? null,
                    stdout: sealed.stdout ?? '',
                    stderr: sealed.stderr ?? '',
                    code: sealed.code,
                });
                return {
                    envelope: failWithIssues(en, {
                        code: sealed.code,
                        operationId,
                        issues: sealed.issues,
                        data: { phase, ...(sealed.run_id === undefined ? {} : { dispatch_id: input.dispatch_id, attempt_id: input.attempt_id, task_id: input.task_id }) },
                        diagnostics: [
                            diag('CHECK_FAILED', `seal 阶段失败（RUN ${sealed.run_id ?? 'unknown'}）：${sealed.stderr || sealed.code}`, '保留 stdout/stderr/exitCode 与阶段；修正项目记录后以同一 operation ID 重入，不完成任务'),
                        ],
                        status: 'partial',
                    }),
                };
            }
            const checks = [];
            checks.push(await writeCheck({
                modules, root, dispatchId: input.dispatch_id, attemptId: input.attempt_id,
                name: 'baseline',
                payload: { ok: true, stage: 'baseline', compared: compared.compared, baseline_ref: loaded.ref, exit_code: null },
                exitCode: null,
            }));
            for (const result of sealed.results) {
                if (result.action === 'skipped')
                    continue;
                checks.push(await writeCheck({
                    modules, root, dispatchId: input.dispatch_id, attemptId: input.attempt_id,
                    name: `seal-${result.run_id}`,
                    payload: { ok: true, stage: 'seal', ...result },
                    exitCode: result.exit_code ?? null,
                }));
            }
            /* ---- 步骤 7：更新事实 → impact → index → check ------------------- */
            const at = modules.clock.isoNow?.() ?? new Date().toISOString();
            const routeUpdate = buildRouteUpdate({
                route,
                review: input.review,
                nextStatus: input.review.proposed_route_status,
                at,
            });
            if (routeUpdate.ok !== true) {
                return {
                    envelope: failWithIssues(en, {
                        code: routeUpdate.code,
                        operationId,
                        issues: routeUpdate.issues,
                        data: { phase, route_id: route.id ?? null },
                        status: 'partial',
                    }),
                };
            }
            if (routeUpdate.changed === true) {
                const routeRef = `re/routes/${route.id}.json`;
                try {
                    const absolute = await modules.paths.assertSafeWriteTarget(root, routeRef);
                    await modules.atomic.writeJsonAtomic(absolute, routeUpdate.route);
                }
                catch (error) {
                    return {
                        envelope: en.fromError(error, {
                            operationId,
                            code: 'RECOVERY_REQUIRED',
                            status: 'partial',
                            data: { phase, route_id: route.id },
                        }),
                    };
                }
            }
            const impact = recordOf(await project.impact());
            if (impact.ok !== true) {
                await recordStageFailure(modules, root, input, {
                    stage: 'impact',
                    exit_code: impact.exitCode ?? null,
                    stdout: impact.stdout ?? '',
                    stderr: impact.stderr ?? '',
                    failures: impact.failures ?? [],
                    code: 'CHECK_FAILED',
                });
                return {
                    envelope: failWithIssues(en, {
                        code: 'CHECK_FAILED',
                        operationId,
                        issues: [
                            diag('CHECK_FAILED', `impact 失败：${stageFailureText(impact)}`, '保留原始 stdout/stderr/exitCode 与阶段；修正项目记录后以同一 operation ID 重入，不完成任务'),
                        ],
                        data: { phase, route_id: route.id },
                        status: 'partial',
                    }),
                };
            }
            const impacted = routeImpactOf(impact.json, route.id);
            if (impacted.items.length > 0
                && (input.review.proposed_route_status === 'active' || input.review.proposed_route_status === 'validated')) {
                return {
                    envelope: failWithIssues(en, {
                        code: 'CHECK_FAILED',
                        operationId,
                        issues: [
                            diag('CHECK_FAILED', `impact 报告本路线仍有待复查/争议影响，不能维持 ${input.review.proposed_route_status}：`
                                + impacted.items.map((item) => JSON.stringify(recordOf(item).route_id ?? item)).join('；'), '先按 skill 处置复查/争议并记录原因，再把路线改为 blocked/paused（或撤销争议）后收口'),
                        ],
                        data: { phase, route_id: route.id },
                        status: 'partial',
                    }),
                };
            }
            checks.push(await writeCheck({
                modules, root, dispatchId: input.dispatch_id, attemptId: input.attempt_id,
                name: 'impact',
                payload: { ok: true, stage: 'impact', json: impact.json, exit_code: impact.exitCode ?? 0 },
                exitCode: impact.exitCode ?? 0,
            }));
            const indexed = recordOf(await project.index());
            if (indexed.ok !== true) {
                await recordStageFailure(modules, root, input, {
                    stage: 'index',
                    exit_code: indexed.exitCode ?? null,
                    stdout: indexed.stdout ?? '',
                    stderr: indexed.stderr ?? '',
                    failures: indexed.failures ?? [],
                    code: 'CHECK_FAILED',
                });
                return {
                    envelope: failWithIssues(en, {
                        code: 'CHECK_FAILED',
                        operationId,
                        issues: [
                            diag('CHECK_FAILED', `index 失败：${stageFailureText(indexed)}`, '保留原始 stdout/stderr/exitCode 与阶段；修正后以同一 operation ID 重入，不完成任务'),
                        ],
                        data: { phase, route_id: route.id },
                        status: 'partial',
                    }),
                };
            }
            checks.push(await writeCheck({
                modules, root, dispatchId: input.dispatch_id, attemptId: input.attempt_id,
                name: 'index',
                payload: { ok: true, stage: 'index', stdout: indexed.stdout ?? '', stderr: indexed.stderr ?? '', exit_code: indexed.exitCode ?? 0 },
                exitCode: indexed.exitCode ?? 0,
            }));
            const checked = recordOf(await project.check({ hashes: true, complete: false }));
            if (checked.ok !== true) {
                await recordStageFailure(modules, root, input, {
                    stage: 'check',
                    exit_code: checked.exitCode ?? null,
                    stdout: checked.stdout ?? '',
                    stderr: checked.stderr ?? '',
                    failures: checked.failures ?? [],
                    code: 'CHECK_FAILED',
                });
                return {
                    envelope: failWithIssues(en, {
                        code: 'CHECK_FAILED',
                        operationId,
                        issues: [
                            diag('CHECK_FAILED', `check --hashes 失败（fail-fast，只报第一条）：${stageFailureText(checked)}`, '保留原始 stdout/stderr/exitCode 与阶段；按 skill 修正项目记录后以同一 operation ID 重入，不完成任务、不降门槛'),
                        ],
                        data: { phase, route_id: route.id },
                        status: 'partial',
                    }),
                };
            }
            checks.push(await writeCheck({
                modules, root, dispatchId: input.dispatch_id, attemptId: input.attempt_id,
                name: 'check-hashes',
                payload: { ok: true, stage: 'check', hashes: true, json: checked.json, stderr: checked.stderr ?? '', exit_code: checked.exitCode ?? 0 },
                exitCode: checked.exitCode ?? 0,
            }));
            phase = 'facts_committed';
            /* ---- 任务完成前先落预备回执 -------------------------------------- */
            const preliminaryRef = `${receiptDirOf(input.dispatch_id, input.attempt_id)}/preliminary.json`;
            try {
                const absolute = await modules.paths.assertSafeWriteTarget(root, preliminaryRef);
                await modules.atomic.writeJsonAtomic(absolute, {
                    schema_version: 1,
                    kind: 'conclude_preliminary',
                    operation_id: input.operation_id,
                    dispatch_id: input.dispatch_id,
                    attempt_id: input.attempt_id,
                    task_id: input.task_id,
                    route_id: route.id,
                    outcome: input.review.outcome,
                    route_status: input.review.proposed_route_status,
                    checks: checks.map((item) => ({ name: item.name, output_ref: item.output_ref, exit_code: item.exit_code })),
                    at,
                });
            }
            catch (error) {
                return {
                    envelope: en.partial({
                        code: 'RECOVERY_REQUIRED',
                        operationId,
                        diagnostics: [
                            diag('RECOVERY_REQUIRED', `预备收口回执写不成：${thrownMessage(error)}`, '确认 re/team/receipts 可写后再重入；业务回执未落盘前不得报 ok，也先别完成任务'),
                        ],
                        data: { phase, dispatch_id: input.dispatch_id, attempt_id: input.attempt_id, task_id: input.task_id, route_id: route.id },
                    }),
                };
            }
            /* ---- 完成任务（原生提前完成则只核对，不再 complete） -------------- */
            const unreviewed = task.status === 'completed';
            let taskRevisionAfter = task.revision;
            if (!unreviewed) {
                const completed = recordOf(await team.updateTask({
                    taskId: input.task_id,
                    expectedRevision: input.expected_revision,
                    action: 'complete',
                }));
                if (completed.ok !== true) {
                    const code = isStableCode(completed.code) ? completed.code : 'RECOVERY_REQUIRED';
                    const actualRevision = Number.isSafeInteger(completed.actualRevision) ? completed.actualRevision : undefined;
                    return {
                        envelope: failWithIssues(en, {
                            code,
                            operationId,
                            issues: [
                                diag(code, `任务 ${input.task_id} 完成失败：${completed.reason ?? completed.code ?? 'unknown'}`
                                    + (actualRevision === undefined ? '' : `（实际 revision ${actualRevision}）`), '事实已整合但任务未完成：按恢复流程核对 owner/revision，一致后再补 complete；不要重复 seal/history'),
                            ],
                            data: {
                                phase,
                                dispatch_id: input.dispatch_id,
                                attempt_id: input.attempt_id,
                                task_id: input.task_id,
                                ...(actualRevision === undefined ? {} : { actual_revision: actualRevision }),
                            },
                            status: 'partial',
                        }),
                    };
                }
                const verified = recordOf(await team.getTask(input.task_id));
                const verifiedTask = recordOf(verified.task);
                if (verified.ok !== true || verifiedTask.status !== 'completed') {
                    return {
                        envelope: en.partial({
                            code: 'RECOVERY_REQUIRED',
                            operationId,
                            diagnostics: [
                                diag('RECOVERY_REQUIRED', `任务 ${input.task_id} 的完成态无法核实（读到 ${verifiedTask.status ?? verified.code ?? 'unknown'}）`, '按宿主快照核对任务状态后再补最终回执；不要把未核实的完成态当作 ok'),
                            ],
                            data: { phase, dispatch_id: input.dispatch_id, attempt_id: input.attempt_id, task_id: input.task_id },
                        }),
                    };
                }
                taskRevisionAfter = Number.isSafeInteger(verifiedTask.revision) ? verifiedTask.revision : taskRevisionAfter;
            }
            /* ---- 审计（best-effort） ----------------------------------------- */
            const audit = await modules.audit.appendAudit(root, {
                kind: 'conclude',
                route: route.id,
                task: input.task_id,
                member: auditColumn(dispatch.record.member ?? task.owner ?? null),
                requester: caller.name ?? 'lead',
                verdict: input.review.outcome,
            }, { clock: modules.clock });
            const auditWritten = audit.written === true;
            const auditFailure = audit.written === false ? audit.error : 'unknown';
            /* ---- 最终回执 ----------------------------------------------------- */
            const diagnostics = [];
            if (unreviewed) {
                diagnostics.push(diag('UNREVIEWED_COMPLETION', `任务 ${input.task_id} 已被原生 complete 且没有验收回执：本次按补验处理，全部检查已执行`, '补验通过不重复调 complete；若需重新处理该交付，先按 skill 重开任务'));
            }
            if (!auditWritten) {
                diagnostics.push(diag('AUDIT_WRITE_FAILED', `审计写入失败：${auditFailure}`, '审计是 best-effort：回执中 audit_written=false；稍后按需补记，不要据此改变证据判定'));
            }
            const envelope = en.ok({
                operationId,
                diagnostics,
                data: {
                    dispatch_id: input.dispatch_id,
                    attempt_id: input.attempt_id,
                    task_id: input.task_id,
                    phase: 'completed',
                    outcome: input.review.outcome,
                    route_status: input.review.proposed_route_status,
                    receipt_ref: receiptRef,
                    checks,
                    audit_written: auditWritten,
                },
            });
            const receipt = {
                schema_version: 1,
                kind: 'conclude_receipt',
                business_key: { dispatch_id: input.dispatch_id, attempt_id: input.attempt_id },
                dispatch_id: input.dispatch_id,
                attempt_id: input.attempt_id,
                task_id: input.task_id,
                task_revision_before: input.expected_revision,
                task_revision_after: taskRevisionAfter,
                route_id: route.id,
                outcome: input.review.outcome,
                route_status: input.review.proposed_route_status,
                success_dependency_satisfied: delivery.successDependency,
                unreviewed_completion: unreviewed,
                submission: { ref: submitted.relative_path, sha256: submitted.sha256, archived_ref: `${receiptDirOf(input.dispatch_id, input.attempt_id)}/submission.json` },
                anchors: { required_kinds: requiredKinds, total: anchorRefs.length },
                baseline: { ref: loaded.ref, compared: compared.compared },
                seals: sealed.results
                    .filter((result) => result.action !== 'skipped')
                    .map((result) => ({ run_id: result.run_id, action: result.action, path: result.path })),
                checks: checks.map((item) => ({ name: item.name, output_ref: item.output_ref, exit_code: item.exit_code })),
                impact: { pending_reviews: impacted.pendingReviews.length, dispute_impacts: impacted.disputeImpacts.length },
                premise_impact: premiseImpact,
                audit_written: auditWritten,
                operation_id: input.operation_id,
                created_at: at,
                result: envelope,
            };
            try {
                const absolute = await modules.paths.assertSafeWriteTarget(root, receiptRef);
                await modules.atomic.writeJsonAtomic(absolute, receipt);
            }
            catch (error) {
                return {
                    envelope: en.partial({
                        code: 'RECOVERY_REQUIRED',
                        operationId,
                        diagnostics: [
                            diag('RECOVERY_REQUIRED', `最终收口回执写不成：${thrownMessage(error)}`, '回执是恢复必需项：确认 re/team/receipts 可写后以同一 operation ID 重入；任务已完成但不得报 ok'),
                        ],
                        data: { phase: 'facts_committed', dispatch_id: input.dispatch_id, attempt_id: input.attempt_id, task_id: input.task_id, receipt_ref: receiptRef },
                    }),
                };
            }
            try {
                await ledger.saveResult(input.operation_id, envelope);
                await ledger.advance(input.operation_id, 'completed', { receipt_ref: receiptRef });
            }
            catch {
                // 台账写不成不影响已落盘的回执（业务身份重放仍可用）；不回滚、不删除证据。
            }
            return { envelope };
        }
        finally {
            try {
                await modules.lock.release(root, { ownerNonce: held?.record?.owner_nonce });
            }
            catch {
                // 锁释放失败不逆转已完成的事实整合；由下一次恢复显式处理。
            }
        }
    }
    catch (error) {
        // 归档之后才冒出来的未捕获异常同样不能报「什么都没发生」：显式把状态压成 partial。
        return {
            envelope: en.fromError(error, {
                operationId,
                data: { phase },
                ...(archived ? { status: 'partial' } : {}),
            }),
        };
    }
}
/* -------------------------------------------------------------------------- */
/* 内部：前提、提交交叉核对、归档、回执读写                                      */
/* -------------------------------------------------------------------------- */
/** 台账里记的阶段 → 失败信封的 `data.phase`（未登记的阶段按 `integrating` 报）。 */
function failurePhaseOf(operationPhase) {
    const phases = envelopeModule.FAILURE_PHASES;
    return typeof operationPhase === 'string' && phases.includes(operationPhase) ? operationPhase : 'integrating';
}
/**
 * 把「问题清单」折成一个信封：默认 blocked，`status` 为 partial/error 时改用对应状态。
 *
 * `status` 不是装饰：编排契约要求「前置拒绝 → blocked；已持久化或触及宿主后失败 → partial」。
 * 分界线见步骤 5 `archiveAttempt()` 处的长注释——归档之后的每个失败点都必须显式传 `partial`。
 */
function failWithIssues(envelope, options) {
    const { code, operationId, issues, data, status, diagnostics: extra = [] } = options;
    const diagnostics = [
        ...issues.map((item) => diag(item.code ?? code, item.reason, item.next_step)),
        ...extra,
    ];
    const payload = { code, operationId, diagnostics, data };
    if (status === 'partial')
        return envelope.partial(payload);
    if (status === 'error')
        return envelope.error(payload);
    return envelope.blocked(payload);
}
/** 脚本失败清单里的第一条原文（`message` 优先，其次 `raw`）；没有就是 `null`。 */
function firstFailure(result) {
    const listed = recordOf(result).failures;
    const failures = Array.isArray(listed) ? listed : [];
    if (failures.length > 0) {
        const first = recordOf(failures[0]);
        const message = first.message;
        if (message !== undefined && message !== null)
            return message;
        return first.raw ?? null;
    }
    return null;
}
/**
 * 脚本失败的原文摘要：优先 fail-fast 的第一条 `ERROR:`，其次 `reason`，最后 stderr 首行。
 * `check` 只报第一条违规，必须保留原文而不是自造汇总。
 */
function stageFailureText(result) {
    const first = firstFailure(result);
    if (typeof first === 'string' && first.length > 0)
        return first;
    const view = recordOf(result);
    const reason = view.reason;
    if (typeof reason === 'string' && reason.length > 0)
        return reason;
    const stderr = view.stderr;
    if (typeof stderr === 'string' && stderr.trim().length > 0) {
        return stderr.trim().split(/\r?\n/u)[0];
    }
    return 'unknown';
}
function receiptDirOf(dispatchId, attemptId) {
    return `${RECEIPTS_DIR}/${dispatchId}-${attemptId}`;
}
function receiptPathFor(dispatchId, attemptId) {
    return `${receiptDirOf(dispatchId, attemptId)}/receipt.json`;
}
/**
 * 读派发记录：T6 写，T7 只读。
 *
 * **装配接缝（T12）**：T6 的契约与 T7 的读取方对同一份记录有四处形状差异，全部在这里
 * 显式对齐（而不是在测试里造一份 T7 想要的记录）：
 *
 * 1. `anchors_required`：契约把它放在 `post.anchors_required`（岗位模板的默认锚点）；
 *    顶层没有这个键。缺失会让锚点门槛**静默变松**，所以必须回退到 `post`。
 * 2. `task_id` / `member`：契约**不能**带它们 —— 契约在任务创建之前就落盘并封哈希。
 *    它们写在 attempt 关联记录 `re/team/attempts/<dispatch>.<attempt>.json` 里
 *    （T6 的 `writeAttemptRecord`），这里读回来做前置核对。
 * 3. `contract_sha256`：契约文件不内嵌自己的哈希（哈希就是文件字节的 SHA256），
 *    同样从 attempt 记录取，用于和提交声明的 `contract_sha256` 交叉核对。
 * 4. `baseline_ref`：本包的 `src/baseline.mjs` 冻结的快照是**对象**（内联）而不是路径；
 *    `loadBaseline()` 的 `embedded` 分支正是为它准备的。路径形状仍然兼容。
 *
 * 兼容顶层字段与 `contract` 内嵌两种形状（旧记录）。
 */
async function readDispatchContext({ root, dispatchId, fs, paths }) {
    const ref = `${DISPATCHES_DIR}/${dispatchId}.json`;
    let text;
    try {
        text = await fs.readFile(paths.resolveInProject(root, ref), 'utf8');
    }
    catch (error) {
        return {
            ok: false,
            code: 'RECOVERY_REQUIRED',
            issues: [
                diag('RECOVERY_REQUIRED', `读不到派发记录 ${ref}（${recordOf(error).code ?? 'unknown'}）`, '确认 dispatch_id 属于本项目；派发记录丢失要按恢复流程核对，不能凭提交自证身份'),
            ],
        };
    }
    let record;
    try {
        record = JSON.parse(text);
    }
    catch (error) {
        return {
            ok: false,
            code: 'RECOVERY_REQUIRED',
            issues: [diag('RECOVERY_REQUIRED', `派发记录不是合法 JSON：${ref}（${error instanceof Error ? error.message : String(error)}）`, '按恢复流程核对记录来源；不要覆盖它')],
        };
    }
    const pick = (key) => (record[key] !== undefined ? record[key] : record.contract?.[key]);
    const attemptId = pick('attempt_id') ?? null;
    const attempt = await readAttemptLink({ root, dispatchId, attemptId, fs, paths });
    if (attempt.ok !== true) {
        return { ok: false, code: 'RECOVERY_REQUIRED', issues: attempt.issues };
    }
    const link = attempt.record;
    const post = pick('post');
    const rawBaseline = pick('baseline_ref');
    const compatibility = recordOf(pick('compatibility'));
    // 缺陷 1（fail-closed）：规则版本必须由派发侧冻结过。缺摘要或摘要不合形状都**不放行** ——
    // 那正是原来的 bug：没有摘要就整段跳过比对，副本在执行期被改写也发现不了。
    const rawRuleDigest = pick('rule_digest')
        ?? (typeof compatibility.ruleDigest === 'string' ? compatibility.ruleDigest : null);
    const ruleDigest = typeof rawRuleDigest === 'string' && SHA256.test(rawRuleDigest) ? rawRuleDigest : null;
    if (ruleDigest === null) {
        return {
            ok: false,
            code: 'RECOVERY_REQUIRED',
            issues: [
                diag('RECOVERY_REQUIRED', `派发记录没有冻结规则摘要（rule_digest）：${ref}`, '先核查该派发记录（可能被外部改写或来自旧版本）；缺摘要就无法判断项目规则副本是否在执行期被改，不能收口'),
            ],
        };
    }
    // 缺陷 2（fail-closed）：锚点门槛不能被静默清零。记录明确指向一个岗位（有 `post_id` 或 `post`）
    // 却两处都拿不到锚点要求时，本条交付是否达到门槛无从判断 —— 只能按恢复流程核查该记录，
    // **不能**用「空数组」当作兼容旧记录。两处都是数组时以顶层为准（与 T6 契约的摆放顺序一致）。
    const topAnchors = pick('anchors_required');
    const postAnchors = recordOf(post).anchors_required;
    const anchorsRequired = Array.isArray(topAnchors)
        ? topAnchors
        : (Array.isArray(postAnchors) ? postAnchors : null);
    const postId = pick('post_id');
    const pointsAtPost = (typeof postId === 'string' && postId.trim().length > 0) || isPlainObject(post);
    // `evidence_required` 允许是空数组，但**必须显式存在**：缺键说明记录被剥掉了字段，
    // 不能当成「没有证据要求」（那同样是把门槛静默清零）。
    const rawEvidence = pick('evidence_required');
    const flat = {
        ref,
        dispatch_id: pick('dispatch_id') ?? dispatchId,
        attempt_id: attemptId,
        task_id: pick('task_id') ?? link?.task_id ?? null,
        route_id: pick('route_id') ?? null,
        member: pick('member') ?? pick('member_name') ?? link?.member ?? null,
        contract_sha256: pick('contract_sha256') ?? link?.contract_sha256 ?? null,
        rule_digest: ruleDigest,
        // 路径（项目内相对）与内联快照都收：`loadBaseline` 用 `ref` 读文件、用 `embedded` 直接校验。
        baseline_ref: typeof rawBaseline === 'string' ? rawBaseline : null,
        baseline: pick('baseline') ?? (isPlainObject(rawBaseline) ? rawBaseline : null),
        target_ids: pick('target_ids') ?? [],
        anchors_required: anchorsRequired ?? [],
        evidence_required: rawEvidence ?? [],
        work_dir: pick('work_dir') ?? null,
        contract_ref: pick('contract_ref') ?? null,
    };
    if (typeof flat.route_id !== 'string' || !/^R-[A-Za-z0-9_-]+$/u.test(flat.route_id)) {
        return {
            ok: false,
            code: 'RECOVERY_REQUIRED',
            issues: [diag('RECOVERY_REQUIRED', `派发记录缺少合法 route_id：${ref}`, '派发记录必须绑定路线；缺失时按恢复流程核对，不要从提交猜路线')],
        };
    }
    if (anchorsRequired === null && (pointsAtPost || topAnchors !== undefined || postAnchors !== undefined)) {
        return {
            ok: false,
            code: 'RECOVERY_REQUIRED',
            issues: [
                diag('RECOVERY_REQUIRED', `派发记录没有冻结锚点要求：${ref}（既没有顶层 anchors_required，也没有 post.anchors_required）`, '先核查该派发记录（可能被外部改写或来自旧版本）；不能把「读不到要求」当成「没有要求」，否则零锚点交付会被放行'),
            ],
        };
    }
    if (!Array.isArray(rawEvidence)) {
        return {
            ok: false,
            code: 'RECOVERY_REQUIRED',
            issues: [
                diag('RECOVERY_REQUIRED', `派发记录缺少 evidence_required（它允许为空数组，但必须显式存在）：${ref}`, '按恢复流程核对派发记录；缺键不能假定「没有证据要求」'),
            ],
        };
    }
    return { ok: true, record: flat };
}
/**
 * 读 attempt 关联记录（`re/team/attempts/<dispatch>.<attempt>.json`，T6 写的恢复关联）。
 *
 * 记录**不存在**是正常的（旧记录/未落盘）：返回 `{ok:true, record:null}`，由前置检查保守处理。
 * 记录**存在但损坏**是 `RECOVERY_REQUIRED` —— 那意味着 task/member 关联不可信，
 * 不能当作「没有绑定」继续放行。
 */
async function readAttemptLink({ root, dispatchId, attemptId, fs, paths }) {
    if (typeof attemptId !== 'string' || !ATTEMPT_ID.test(attemptId))
        return { ok: true, record: null };
    const ref = `${ATTEMPTS_DIR}/${dispatchId}.${attemptId}.json`;
    let text;
    try {
        text = await fs.readFile(paths.resolveInProject(root, ref), 'utf8');
    }
    catch (error) {
        const code = recordOf(error).code;
        if (code === 'ENOENT' || code === 'ENOTDIR')
            return { ok: true, record: null };
        return {
            ok: false,
            issues: [diag('RECOVERY_REQUIRED', `读不了 attempt 关联记录 ${ref}（${code ?? 'unknown'}）`, '确认 re/team/attempts 可读；读失败不能当作没有绑定')],
        };
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (error) {
        return {
            ok: false,
            issues: [diag('RECOVERY_REQUIRED', `attempt 关联记录不是合法 JSON：${ref}（${error instanceof Error ? error.message : String(error)}）`, '按恢复流程核对记录来源；不要覆盖它')],
        };
    }
    return { ok: true, record: isPlainObject(parsed) ? parsed : null };
}
async function checkPremises({ envelope: en, team, project, dispatch, input, operationId, root }) {
    if (typeof dispatch.attempt_id === 'string' && dispatch.attempt_id !== input.attempt_id) {
        return {
            ok: false,
            envelope: en.blocked({
                code: 'STALE_ATTEMPT',
                operationId,
                reason: `派发记录指向 attempt ${dispatch.attempt_id}，调用的是 ${input.attempt_id}（旧尝试只能入历史）`,
                nextStep: '按当前 attempt 收口；被撤销的旧 attempt 的提交只能入历史，不能更新当前结果',
                data: { phase: 'preflight', dispatch_id: input.dispatch_id, attempt_id: input.attempt_id },
            }),
        };
    }
    if (typeof dispatch.task_id === 'string' && dispatch.task_id !== input.task_id) {
        return {
            ok: false,
            envelope: en.blocked({
                code: 'STALE_ATTEMPT',
                operationId,
                reason: `派发记录绑定任务 ${dispatch.task_id}，调用的是 ${input.task_id}`,
                nextStep: '按派发记录里的 task_id 收口；任务被重派时另发新 dispatch',
                data: { phase: 'preflight', task_id: input.task_id },
            }),
        };
    }
    const taskResult = recordOf(await team.getTask(input.task_id));
    if (taskResult.ok !== true) {
        const code = isStableCode(taskResult.code) ? taskResult.code : 'RECOVERY_REQUIRED';
        return {
            ok: false,
            envelope: en.blocked({
                code,
                operationId,
                reason: `读不到任务 ${input.task_id}：${taskResult.reason ?? taskResult.code ?? 'unknown'}`,
                nextStep: '确认 task_id 属于当前团队；无法关联时按恢复流程核对名册/任务板',
                data: { phase: 'preflight', task_id: input.task_id },
            }),
        };
    }
    // 缺陷 3：适配器给出 `{ok:true, task:null}`（宿主把记录交回成非对象）时不能直接解引用 ——
    // 那是「记录被外部改写」的**异常状态**，要返回可读的 blocked，而不是让 TypeError 冒到外层
    // 变成 error 信封（也不是静默当成「没有这条记录」）。
    const taskRecord = taskResult.task;
    if (!isPlainObject(taskRecord)) {
        return {
            ok: false,
            envelope: en.blocked({
                code: 'RECOVERY_REQUIRED',
                operationId,
                reason: `任务 ${input.task_id} 的记录为空（宿主 getTask 返回 ok 但没有任务对象），可能被外部改写`,
                nextStep: '按恢复流程核对任务板与成员名册；确认任务真实状态后再决定重派或收口，不要凭提交自证',
                data: { phase: 'preflight', task_id: input.task_id },
            }),
        };
    }
    const task = taskRecord;
    if (task.status === 'deleted') {
        return {
            ok: false,
            envelope: en.blocked({
                code: 'STALE_ATTEMPT',
                operationId,
                reason: `任务 ${input.task_id} 已被删除（墓碑），不能收口`,
                nextStep: '为仍在执行的交付另建任务，或按恢复流程核对是否已被重派',
                data: { phase: 'preflight', task_id: input.task_id },
            }),
        };
    }
    if (task.status === 'pending') {
        return {
            ok: false,
            envelope: en.blocked({
                code: 'STALE_ATTEMPT',
                operationId,
                reason: `任务 ${input.task_id} 仍是 pending：还没有可收口的执行尝试`,
                nextStep: '先按 rt_dispatch 指派并交付契约；未开始的交付不能收口成结果',
                data: { phase: 'preflight', task_id: input.task_id },
            }),
        };
    }
    if (task.revision !== input.expected_revision) {
        return {
            ok: false,
            envelope: en.blocked({
                code: 'REVISION_CONFLICT',
                operationId,
                reason: `任务 ${input.task_id} 的 revision 已变化：期望 ${input.expected_revision}，实际 ${task.revision}`,
                nextStep: '重读任务/owner 后再决定；不要用新 revision 覆盖别人的决定',
                data: { phase: 'preflight', task_id: input.task_id, actual_revision: task.revision },
            }),
        };
    }
    if (dispatch.member !== null && task.owner !== null && dispatch.member !== task.owner) {
        return {
            ok: false,
            envelope: en.blocked({
                code: 'STALE_ATTEMPT',
                operationId,
                reason: `任务 ${input.task_id} 的 owner 是 ${task.owner}，与派发记录的成员 ${dispatch.member} 不一致`,
                nextStep: '核对是否已重派；任务被改派时旧 attempt 的提交只入历史',
                data: { phase: 'preflight', task_id: input.task_id },
            }),
        };
    }
    const routeResult = recordOf(await project.readRoute(dispatch.route_id));
    if (routeResult.ok !== true) {
        const code = routeResult.code === 'PROJECT_NOT_CONFIGURED'
            ? 'PROJECT_NOT_CONFIGURED'
            : (isStableCode(routeResult.code) ? routeResult.code : 'RECOVERY_REQUIRED');
        return {
            ok: false,
            envelope: en.blocked({
                code,
                operationId,
                reason: `读不到路线 ${dispatch.route_id}：${routeResult.reason ?? routeResult.code ?? 'unknown'}`,
                nextStep: '路线必须由 Lead 先按 skill 建成正式记录；缺失时先补齐路线再收口',
                data: { phase: 'preflight', route_id: dispatch.route_id },
            }),
        };
    }
    // 缺陷 3（同一处）：路线文件被写成 `null` 时同样按异常状态处理，返回可读的 blocked。
    const routeRecord = routeResult.route;
    if (!isPlainObject(routeRecord)) {
        return {
            ok: false,
            envelope: en.blocked({
                code: 'RECOVERY_REQUIRED',
                operationId,
                reason: `路线 ${dispatch.route_id} 的记录为空（readRoute 返回 ok 但没有路线对象），可能被外部改写`,
                nextStep: '按恢复流程核对 re/routes 下的路线记录；确认路线真实状态后再收口，不要从提交猜路线',
                data: { phase: 'preflight', route_id: dispatch.route_id },
            }),
        };
    }
    const route = routeRecord;
    if (route.id !== dispatch.route_id) {
        return {
            ok: false,
            envelope: en.blocked({
                code: 'RECOVERY_REQUIRED',
                operationId,
                reason: `路线记录的 id（${JSON.stringify(route.id)}）与派发绑定的路线 ${dispatch.route_id} 不一致`,
                nextStep: '按恢复流程核对路线记录来源；不要用别条路线的记录收口',
                data: { phase: 'preflight', route_id: dispatch.route_id },
            }),
        };
    }
    // 规则版本：派发时**必须**已经冻结摘要（`readDispatchContext` 缺摘要就按 RECOVERY_REQUIRED 拒绝），
    // 所以这里无条件比对当前副本的摘要。副本在执行期被改 → SKILL_INCOMPATIBLE，不能静默换规则（D8）。
    const probe = recordOf(await project.probe({ projectRoot: root }));
    const current = recordOf(probe.compatibility).ruleDigest ?? null;
    if (probe.ok !== true || current === null) {
        return {
            ok: false,
            envelope: en.blocked({
                code: 'SKILL_INCOMPATIBLE',
                operationId,
                reason: `无法复核项目规则版本（probe: ${probe.reason ?? probe.code ?? 'unknown'}）`,
                nextStep: '先按 rt_roster 的接入检查确认项目副本完整，再收口',
                data: { phase: 'preflight', route_id: dispatch.route_id },
            }),
        };
    }
    if (current !== dispatch.rule_digest) {
        return {
            ok: false,
            envelope: en.blocked({
                code: 'SKILL_INCOMPATIBLE',
                operationId,
                reason: `项目规则副本在派发后变化（冻结 ${dispatch.rule_digest}，当前 ${current}）`,
                nextStep: '按 skill 重做兼容性检查并保留旧绑定；未完成尝试继续绑定原规则或显式重派，不能静默换规则',
                data: { phase: 'preflight', route_id: dispatch.route_id },
            }),
        };
    }
    const impact = recordOf(await project.impact());
    if (impact.ok !== true) {
        return {
            ok: false,
            envelope: en.blocked({
                code: 'CHECK_FAILED',
                operationId,
                reason: `impact 前置复核失败：${stageFailureText(impact)}`,
                nextStep: '保留原始 stdout/stderr/exitCode；先修好项目记录再做收口',
                data: { phase: 'preflight', route_id: dispatch.route_id },
            }),
        };
    }
    const summary = routeImpactOf(impact.json, dispatch.route_id);
    return {
        ok: true,
        task,
        route,
        premiseImpact: {
            pending_reviews: summary.pendingReviews.length,
            dispute_impacts: summary.disputeImpacts.length,
            recovery_pending: summary.recovery.length,
        },
    };
}
function crossCheckSubmission({ submission, dispatch, taskId }) {
    const issues = [];
    if (submission.task_id !== taskId) {
        issues.push(diag('SUBMISSION_INVALID', `提交的 task_id=${submission.task_id} 与调用 task_id=${taskId} 不一致`, '按当前任务收口；换了任务请另发收口'));
    }
    if (typeof dispatch.contract_sha256 === 'string' && dispatch.contract_sha256 !== submission.contract_sha256) {
        issues.push(diag('SUBMISSION_INVALID', `提交的 contract_sha256 与派发契约摘要不一致（提交 ${submission.contract_sha256}，派发 ${dispatch.contract_sha256}）`, '按派发时冻结的契约摘要核对；契约变了要重派而不是沿用旧收口'));
    }
    return issues;
}
/**
 * 归档：核对过的产物复制到 RUN 声明的正式位置；原提交、路径映射与执行事实进回执目录。
 */
async function archiveAttempt(input) {
    const { modules, root, dispatchId, attemptId, operationId, submission } = input;
    const dir = receiptDirOf(dispatchId, attemptId);
    const mappingArtifacts = [];
    const runArtifacts = new Map();
    for (const run of input.runs) {
        for (const artifact of run.artifacts) {
            const view = recordOf(artifact);
            if (typeof view.sha256 === 'string')
                runArtifacts.set(view.sha256, view.path);
        }
    }
    // 循环内的失败状态：已经确认过**至少一个**产物的正式字节（复制或校验复用）→ partial。
    // 这是 `archiveAttempt()` 内部那条「本函数自己写过的字节」的分界线：第一个产物落盘之前
    // 失败仍然可以报 blocked（什么都没发生），之后就必须报 partial。
    let formalized = 0;
    const failureStatus = () => (formalized > 0 ? 'partial' : 'blocked');
    for (const artifact of submission.artifacts) {
        let source;
        try {
            source = modules.paths.resolveInProject(root, artifact.path);
        }
        catch (error) {
            return {
                ok: false,
                code: 'SUBMISSION_INVALID',
                status: failureStatus(),
                issues: [diag('SUBMISSION_INVALID', `产物路径越界：${artifact.path}（${thrownMessage(error)}）`, 'artifacts 只能指向本 attempt 分配目录')],
            };
        }
        try {
            await modules.atomic.verifyFileHash(source, artifact.sha256);
        }
        catch (error) {
            return {
                ok: false,
                code: 'SUBMISSION_INVALID',
                status: failureStatus(),
                issues: [diag('SUBMISSION_INVALID', `产物缺失或哈希不符：${artifact.path}（${thrownMessage(error)}）`, '重新核对原始产物；提交后不得改写该版本')],
            };
        }
        const formal = runArtifacts.get(artifact.sha256);
        if (typeof formal !== 'string') {
            return {
                ok: false,
                code: 'SUBMISSION_INVALID',
                status: failureStatus(),
                issues: [
                    diag('SUBMISSION_INVALID', `产物未在该 RUN 的 artifacts 登记：${artifact.path}`, '先在 RUN 记录（re/runs/<RUN>/run.json）的 artifacts 里登记 path/sha256（正式证据位置），再收口；编排目录不能代替正式证据'),
                ],
            };
        }
        try {
            const destination = await modules.paths.assertSafeWriteTarget(root, formal);
            const exists = await modules.fs.readFile(destination).then(() => true).catch(() => false);
            if (exists) {
                await modules.atomic.verifyFileHash(destination, artifact.sha256);
            }
            else {
                await modules.atomic.copyVerify(source, destination, { expectedSha256: artifact.sha256 });
            }
            mappingArtifacts.push({ source_path: artifact.path, archived_path: formal, sha256: artifact.sha256 });
            formalized += 1;
        }
        catch (error) {
            return {
                ok: false,
                code: 'BASELINE_MISMATCH',
                status: failureStatus(),
                issues: [diag('BASELINE_MISMATCH', `归档目标已存在且内容不一致：${formal}（${thrownMessage(error)}）`, '正式记录不得覆盖：保留既有字节，按新 RUN 归档新证据')],
            };
        }
    }
    const primary = input.runs[0]?.record ?? null;
    const mapping = {
        schema_version: 1,
        kind: 'conclude_archive_mapping',
        dispatch_id: dispatchId,
        attempt_id: attemptId,
        operation_id: operationId,
        archived_at: input.now,
        submission: {
            ref: input.submissionRef,
            sha256: input.submissionSha,
            archived_ref: `${dir}/submission.json`,
        },
        artifacts: mappingArtifacts,
        execution: primary === null
            ? { run_id: null }
            : {
                run_id: input.runs[0].run_id,
                command: recordOf(primary).command ?? null,
                cwd: recordOf(primary).cwd ?? null,
                started_at: recordOf(primary).started_at ?? null,
                ended_at: recordOf(primary).ended_at ?? null,
                provenance: recordOf(primary).provenance ?? null,
            },
        runs: input.runs.map((run) => ({
            run_id: run.run_id,
            status: run.status,
            command: recordOf(run.record).command ?? null,
            cwd: recordOf(run.record).cwd ?? null,
            started_at: recordOf(run.record).started_at ?? null,
            ended_at: recordOf(run.record).ended_at ?? null,
            provenance: recordOf(run.record).provenance ?? null,
            artifacts: run.artifacts.map((artifact) => ({ path: recordOf(artifact).path ?? null, sha256: recordOf(artifact).sha256 ?? null })),
        })),
    };
    try {
        const submissionTarget = await modules.paths.assertSafeWriteTarget(root, `${dir}/submission.json`);
        await modules.atomic.createExclusive(submissionTarget, input.submissionBytes);
        const mappingTarget = await modules.paths.assertSafeWriteTarget(root, `${dir}/mapping.json`);
        await modules.atomic.writeJsonAtomic(mappingTarget, mapping);
    }
    catch (error) {
        return {
            ok: false,
            code: 'RECOVERY_REQUIRED',
            status: 'partial',
            issues: [diag('RECOVERY_REQUIRED', `归档记录写不成：${thrownMessage(error)}`, '确认 re/team/receipts 可写后以同一 operation ID 重入；已保留的证据不回滚')],
        };
    }
    return { ok: true, dir, mapping };
}
/**
 * 记录脚本失败阶段（best-effort）：`re/team/receipts/<D>-<A>/failed-<operation>.json`。
 * 阶段与 stdout/stderr/exitCode 原文必须保留，供 Lead 按同一 operation ID 重入。
 */
async function recordStageFailure(modules, root, input, payload) {
    try {
        const ref = `${receiptDirOf(input.dispatch_id, input.attempt_id)}/failed-${input.operation_id}.json`;
        const absolute = await modules.paths.assertSafeWriteTarget(root, ref);
        await modules.atomic.writeJsonAtomic(absolute, {
            schema_version: 1,
            kind: 'conclude_failure',
            operation_id: input.operation_id,
            dispatch_id: input.dispatch_id,
            attempt_id: input.attempt_id,
            task_id: input.task_id,
            at: modules.clock.isoNow?.() ?? new Date().toISOString(),
            ...payload,
        });
    }
    catch {
        // 失败回执也是诊断附件：写不成不改变返回码（信封已带阶段与原文）。
    }
}
/** 写一条检查输出并返回 concludeData.checks 条目。 */
async function writeCheck(input) {
    const { modules, root, dispatchId, attemptId, name, payload, exitCode } = input;
    const ref = `${receiptDirOf(dispatchId, attemptId)}/checks/${name}.json`;
    try {
        const absolute = await modules.paths.assertSafeWriteTarget(root, ref);
        await modules.atomic.writeJsonAtomic(absolute, payload);
    }
    catch {
        // 检查输出是诊断附件：写不成不影响判定（回执仍会记阶段与原始文本的引用位置）。
    }
    const exit_code = typeof exitCode === 'number' && Number.isSafeInteger(exitCode) ? exitCode : null;
    return { name, status: 'pass', output_ref: ref, exit_code };
}
async function readBusinessReceipt({ root, ref, fs, paths, dispatchId, attemptId }) {
    let text;
    try {
        text = await fs.readFile(paths.resolveInProject(root, ref), 'utf8');
    }
    catch (error) {
        const code = recordOf(error).code;
        if (code === 'ENOENT' || code === 'ENOTDIR')
            return { ok: true, exists: false };
        return {
            ok: false,
            issues: [diag('RECOVERY_REQUIRED', `读不了收口回执 ${ref}（${code ?? 'unknown'}）`, '确认 re/team/receipts 可读；读失败不能当作没有收口')],
        };
    }
    let receipt;
    try {
        receipt = JSON.parse(text);
    }
    catch (error) {
        return {
            ok: false,
            issues: [diag('RECOVERY_REQUIRED', `收口回执不是合法 JSON：${ref}（${error instanceof Error ? error.message : String(error)}）`, '按恢复流程核对回执来源；不要覆盖既有回执')],
        };
    }
    if (!isPlainObject(receipt) || receipt.dispatch_id !== dispatchId || receipt.attempt_id !== attemptId || !isPlainObject(receipt.result)) {
        return {
            ok: false,
            issues: [diag('RECOVERY_REQUIRED', `收口回执内容与业务身份不符：${ref}`, '按恢复流程核对回执；不要用别的 attempt 的回执冒充')],
        };
    }
    return { ok: true, exists: true, receipt };
}
