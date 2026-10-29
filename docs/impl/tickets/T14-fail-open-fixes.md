# T14 — 修三个 fail-open 缺陷：规则摘要守卫失效、锚点门槛可被静默清零、收口空指针

**Blocked by:** T11（已合并）

## 为什么有这个 ticket

类型化过程中撞出三处**真实的判断缺陷**。它们不是类型问题，是逻辑问题；每一条都让一个本该拦住的收口被放行，或者让一条错误路径的结论失真。规格的核心承诺是「锚点闭集」和「前提按路线和条件核查」，所以这三条必须修，并各配一条会红的测试。

## 缺陷 1（强）：`rule_digest` 从没被写入 → 规则漂移守卫是死代码

- `conclude.ts` 的 `readDispatchContext()` 读 `rule_digest`（顶层或 `contract.*`），拿不到再回退 `compatibility.ruleDigest`；`checkPremises` 里只有 `typeof dispatch.rule_digest === 'string' && SHA256.test(...)` 成立时才会 `probe()` 比对并抛 `SKILL_INCOMPATIBLE`。
- 但 `re/team/dispatches/<D>.json` **就是契约本体**，由 `contract.buildContract()` 生成，而它的键清单里**既没有 `rule_digest` 也没有 `compatibility`**；全包 grep：`rule_digest` 只出现在读取侧（conclude）与 compatibility 的字段别名表，**没有任何写入方**。
- 后果：该守卫**永不执行**，项目 skill 副本在执行期被改也不会被发现。

**修法**：让派发侧真的冻结规则摘要——`buildContract()` 记录 `rule_digest`（以及 `script_digest` / `catalog_digest`），值取自 `compatibility.computeDigests(...)`（`probe()` 已经在 dispatch 的门 1 跑过，复用其结果即可，不要为此多跑一次 Python）。收口侧沿用现有读取逻辑与比对。**不得**改成「没有摘要就跳过」——那正是现在的 bug；改为「派发记录缺 `rule_digest` 时按 `RECOVERY_REQUIRED` 拒绝收口」，因为新派发一定带它，缺了说明是旧记录。

## 缺陷 2（最强，fail-open）：锚点门槛可被静默清零

```ts
anchors_required: pick('anchors_required') ?? (Array.isArray(recordOf(post).anchors_required) ? recordOf(post).anchors_required : []),
evidence_required: pick('evidence_required') ?? [],
```

- 对 T6 写的契约，顶层 `anchors_required` **永远不存在**（契约把它放在 `post.anchors_required`），所以那条回退是承重的、且正确。
- 但若记录**两处都没有**（旧记录 / 外来记录 / `post` 被剥掉），两者都变 `[]` → `mergeRequiredKinds` 返回 `{kinds: [], issues: []}`（**不报 issue**）→ `effectiveRequiredKinds` 返回 `[]` → `evaluateDelivery` 的 `requires_anchors` 分支没有任何 kind 可要求 → **`finding` / `no_finding` 在零锚点下放行**。
- 这正是用户故事 19 与验收矩阵 A17 要拦的东西。

**修法（fail-closed）**：当派发记录**明确指向一个岗位**（有 `post_id` 或 `post`）却**两处都拿不到锚点要求**时，按 `RECOVERY_REQUIRED` 拒绝收口，诊断说明「派发记录没有冻结锚点要求，无法判断本条交付是否达到门槛，先核查该记录」。**不要**用「空数组就跳过」当作兼容旧记录——旧记录应当被显式核查，而不是静默放宽。

同时给 `evidence_required` 同样处理（它允许为空，但**必须在记录里显式存在**才允许为空）。

## 缺陷 3：收口里的空指针

`checkPremises` 里 `taskResult.task` / `routeResult.route` 直接解引用（`task.status`、`route.id`），没有 `?.`。当适配器给出 `{ok:true, task:null}`（宿主 `getTask()` 返回非对象）或路线文件 JSON 是 `null` 时，抛 `TypeError` → 外层 `catch` → `error` 信封。

**修法**：显式判断，返回**可读**的 `blocked` 信封（例如 `RECOVERY_REQUIRED` 或更贴切的稳定码），诊断里点名「任务/路线记录为空，可能被外部改写」。**必须**保留「这是异常状态、不是正常业务拒绝」的语义：不要静默当成「没有这条记录」。

## 交付

- 三个修复各配**至少两条**测试：一条证明缺陷存在过（修复前会走错的输入现在被拒）、一条证明正常路径未被误伤。
- 缺陷 1 还要一条测试断言 `buildContract()` 产出的记录里**确实有** `rule_digest` 且是 64-hex。
- 缺陷 2 还要一条测试断言：`finding` 交付在「记录无任何锚点要求」时被拒；而在「记录有 `post.anchors_required`」时照常通过。

## 门禁

```
cd D:\workSpace\Rea-Multi-agent
npm.cmd run build
node --test "packages/dsh-redteam-lead/test/**/*.test.mjs"
```
基线：tsc **0 错**、门禁 **472 pass / 0 fail**。修完必须是 **≥472 且 0 fail**（新增用例会让数字变大）。

## 约束

- 不改 `tsconfig.json`、`scripts/build.mjs`、根 `package.json`、`cordis.patch.yml`、`locale/`。
- 不引入 `any` / `@ts-expect-error` / 裸 `!`。
- `dist/` 必须重新构建并提交（改了 `src` 就得重建，否则 `dist` 与源码不同步）。
- 不动 `docs/specs/**`。

## 验收

- [ ] tsc 0 错
- [ ] 门禁 ≥472 pass / 0 fail
- [ ] 三条缺陷各有「会红的测试」+「正常路径不误伤」的测试
- [ ] `dist/` 已重建并提交，`git status` 干净
- [ ] 报告里逐条说明：修了哪一侧、为什么是这一侧、旧行为是什么、新行为是什么
