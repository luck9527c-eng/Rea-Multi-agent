# T17 — 补上「冻结所依赖产物身份」：已封存产物的篡改必须在写盘之前被抓到

**来源**：T16 在归档 L3 证据时的核对（`session-040cb6df-0826-490e-aa07-ea1a9554461a`），并已由 Lead 复核。

## 事实（三条，均已核对）

1. `src/dispatch.ts:2010`（及 `1759` 回退分支）调 `captureBaseline({ root, targetIds, projectAdapter, atomic, paths, now })` —— **从不传 `artifacts`**。
2. 因此 `re/team/baselines/<D>.json` 的 `artifacts` 恒为 `[]`。L3 回执实测：`r2-s6b-receipt.json` 的 `baseline.compared` = `{"targets":1,"preexisting_seals":0,"artifacts":0}`。
3. `src/baseline.ts` 的 `compareBaseline()` 只哈希 `baseline.targets` 与 `baseline.artifacts`；`preexisting_seals` 只比对 **seal 文件自身**的 path+sha256，**从不哈希被封存 RUN 里的产物字节**。

## 为什么这是缺陷而不是"晚检测"

编排契约 §锚点与封存绑定要求：派发前冻结「目标 ID/字节哈希、相关已有 seal 的路径和字节哈希，**以及所依赖产物的身份**」；收口「先与该快照比较」；「既存项删除、读取失败或**内容变化必须报错**」。第三条（依赖产物的身份）从来没有被冻结过，所以永远报不出来 —— 不是"检测得晚"，是**这条比对不存在的**。

后果：篡改已封存产物后，唯一的检测点是最后一步 skill `check --hashes`（实测 exit 1 `artifact/script hash mismatch`），而那时**路线已回写、index 已刷新**，项目停在半整合状态，只能前向修复。契约明确要求「任何不完整整合均阻止其他正式变更」。

## 交付

### 1. 派发侧真的冻结依赖产物

- `captureBaseline()` 增加/填实 `artifacts` 入参：对**本次派发所依赖的既有已封存 RUN**，把该 RUN `run.json` 里声明的每个 artifact 的 `{path, sha256}` 冻进快照。
- 「依赖的 RUN」从路线取（`route.dependency_runs` / 路线已登记的 `evidence` RUN），加上目标已有的 seal 所对应的 RUN。**不要**把无关路线的 RUN 全扫进来 —— 契约要求「其他路线正常新增 seal 不使旧快照失效」。
- 首次目标无任何已封存 RUN 时 `artifacts: []`，这是正确值（保留现有用例）。

### 2. 收口侧在**写盘之前**比对

`compareBaseline()` 已经会哈希 `baseline.artifacts`，确认它在收口序列里位于**归档/更新路线/impact/index 之前**（L3 回执的 checks 顺序是 `baseline → seal → impact → index → check-hashes`，baseline 确实最早）。若 `artifacts` 比对现在落在 seal 之后，前移。

### 3. 测试（两条都要）

- **正例**：项目里已有一个已封存 RUN；派发一个新任务（依赖它）；篡改该 RUN 的某个 artifact 一个字节；`rt_conclude` → `BASELINE_MISMATCH`，且**断言项目 diff 里没有路线变更、index 未刷新、任务未 complete**（证明"写盘之前"）。
- **反例（不许误伤）**：**别的、未被依赖的路线**新增 seal 后，旧派发收口仍然通过（契约：「其他路线正常新增 seal 不使旧快照失效」）。

### 4. 记录

在 `docs/impl/DECISIONS.md` 记一条：把 L3 观察到的 `SUBMISSION_INVALID`（submission.artifacts 命中）与本条（baseline.artifacts 命中）区分开 —— 前者是"提交自报的产物变了"，后者是"依赖的既有证据变了"，两者的码与触发点不同，都必须能在写盘前拒绝。

## 门禁

```
cd D:\workSpace\Rea-Multi-agent
npm.cmd run build
node --test "packages/dsh-redteam-lead/test/**/*.test.mjs"
```
基线以合并时的实际数字为准（T16 之后应 ≥564），要求 **0 fail / 0 skip**、`tsc` 0 错。改 `src/` 必须重建并提交 `dist/`。

## 验收

- [ ] tsc 0 错、门禁 0 fail / 0 skip
- [ ] 篡改**被依赖的**已封存产物 → `BASELINE_MISMATCH`，且断言零写盘（路线/index/任务都没动）
- [ ] **未被依赖**的路线新增 seal → 旧派发收口仍通过（不误伤）
- [ ] `re/team/baselines/<D>.json` 的 `artifacts` 不再是恒空（有真实条目时非空）
- [ ] `baseline.compared.artifacts` 在 L3 类似场景下 > 0
- [ ] DECISIONS 记录两者区分
