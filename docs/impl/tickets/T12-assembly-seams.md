# T12 — 装配收口：`createDeps` 接齐、projectRoot 绑定、Windows rename 抖动、派发↔收口端到端

**Blocked by:** T5、T6、T7（已合并）

## 为什么有这个 ticket

七个实现 ticket 各自在独立 worktree 里完成，**装配层 `index.js` 是 T2 写的**（那时 T5/T6/T7 还不存在），合并后它没被更新。结果：

1. `createDeps` 里 `binding / contract / resources / submission / anchors / baseline` **全是 `null`**（`index.js:199-204`）。
2. `createProjectAdapter(adapterOptions)` 拿不到 `projectRoot`，所以 `readRoute/impact/readSeals` 在生产里会一律 `PROJECT_NOT_CONFIGURED`，`rt_dispatch` 在第一道门就被拒（T6、T5 各自报了这条）。
3. Windows 上 `fs.rename` 偶发 `EPERM`（`%TEMP%` 并发写），门禁大约 1/6 次会飘红，失败点随机落在当时正在改名的用例上（T5、T6、T7 都观察到）。这是**真实的 Windows 健壮性缺陷**，不是测试噪音。
4. 三个工具之间的接缝（派发记录 → 收口读取、`baseline` 的 capture/consume）**从来没有被端到端验证过**——每边都只对自己的替身证明了。

## 读什么

- [UPSTREAM-API.md](../UPSTREAM-API.md)、[SEAMS.md](../SEAMS.md) 第 1 节（`deps` 两种形状）、[DECISIONS.md](../DECISIONS.md) 的 **D25（容量组装）**、D12、D19、D20
- `packages/dsh-redteam-lead/index.js` 的 `createDeps` / `handleToolCall`
- `src/contract.mjs` 里 `captureBaseline` 与派发记录字段；`src/conclude.mjs` 里对 `dispatch.record.*` 的读取
- `src/atomic.mjs` 的 `writeJsonAtomic` / `createExclusive`

## 交付

### 1. `index.js`：`createDeps` 接齐 + 按当次 `project_root` 装配

- `deps.binding / contract / resources / submission / anchors / baseline` 改为**真实模块命名空间**（与 UPSTREAM-API 一致），不再 `null`。
- 调用顺序改为：**解析入参 → `validate` 预校验出 `project_root` → `normalizeProjectRoot` → 用一个 `try/catch` 包住（失败按 `PATH_INVALID`/`INVALID_ARGUMENT` 返回，不抛）→ 用该 root 建两个适配器 → 交给 handler**。
- `createDeps({ services, exec, config, ctx, projectRoot })` 增加 `projectRoot`；`createProjectAdapter({ ..., projectRoot })` 必须真的拿到它。`project_root` 缺失/非法时适配器不建、handler 仍要能返回可读错误。
- 保留「每次工具调用装配一次」的语义（SEAMS §1）。

### 2. `src/atomic.mjs`：对瞬时 `EPERM`/`EACCES` 做**有界**重试

- `writeJsonAtomic` 的 `rename`、`createExclusive` 的 `open(wx)`：命中 `EPERM`/`EACCES`/`EBUSY` 时按短退避重试，**最多 3 次**，仍失败则抛原文。
- 只对这几个码重试；`ENOENT`/`EEXIST`/哈希不一致**不得**重试（那是有意义的失败）。
- 重试次数与退避可通过参数注入，测试里用假 `fs` 断言「第 2 次成功 → 整体成功」「一直失败 → 抛原文且尝试了 3 次」「`EEXIST` → 一次都不重试」。

### 3. `test/assembly.test.mjs`：端到端接缝

用一个临时分析项目 + `makeCtx`，把三工具串起来跑：

- **`rt_roster inspect`** 在项目里存在 `re/team/capacity.json` 时，`data.capacity` 的来源必须是 `declared:re/team/capacity.json`，**不能是 `unavailable`**（证明 projectRoot 真的绑上了）。
- **`rt_dispatch`** 成功：`phase='delivered'`、task `in_progress`、owner 正确、派发记录落在 `re/team/dispatches/`、`baseline_ref` 有真实目标哈希。
- **`rt_conclude`** 消费同一份派发记录成功：能读到 `anchors_required` / `evidence_required` / `baseline_ref`（证明 T6 写的形状就是 T7 读的形状），`seal` 恰好调用一次、`index` 在 `check` 之前、task 变 `completed`。
- 断言 `deps.binding/contract/resources/submission/anchors/baseline` **全部非 null**（防止回归成占位装配）。

## 裁决：seal 顺序张力（写进代码注释 + `docs/impl/DECISIONS.md`）

T7 报的张力：编排契约 §135 说「seal 前先按事实解除会令全项目校验失败的旧状态」，而 T7 的固定顺序是 seal 在「更新事实」之前。

**保持 T7 的固定顺序**（写记录 → seal → 更新事实 → impact → index → check）。理由：改顺序会让「封存的是尚未更新的旧事实」这一更严重的问题出现。若旧路线状态确实会让 seal 的全项目校验失败，`rt_conclude` 返回 `CHECK_FAILED`，由 Lead 先按 skill 修好记录再重入——**不降门槛、不静默改序**。在 `conclude.mjs` 与 DECISIONS 里各写一句。

## 验收

- [ ] 门禁绿：`cd packages/dsh-redteam-lead; node --test "test/**/*.test.mjs"`；用例数 ≥ 460
- [ ] `test/assembly.test.mjs` 的四个端到端断言全部成立
- [ ] `createDeps` 返回的 `deps` 六个占位键全部非 null（有断言）
- [ ] 注入 `project_root` 后 `projectAdapter` 的 `readRoute` 真的读到文件（不是 `PROJECT_NOT_CONFIGURED`）
- [ ] `atomic` 重试三态测试（成功/耗尽/不重试）全绿
- [ ] 连跑 `node --test "test/**/*.test.mjs"` **5 次**无 `EPERM` 偶发失败（报告里贴 5 次结果）
- [ ] 未改 `cordis.patch.yml`、`locale/`、既有 `redteam` preset、`@local/dsh-rea-plugin`
- [ ] DECISIONS 补一条 seal 顺序裁决
