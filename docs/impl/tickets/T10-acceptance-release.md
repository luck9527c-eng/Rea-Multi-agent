# T10 — 验收总表、缺口收口与发布就绪

**Blocked by:** T8、T9

## 这个 ticket 打通什么

把 44 条验收场景**逐条**对着真实证据判定，把还缺的实现/测试缺口补齐（或如实标"未执行"），并把仓库从"能跑"变成"能交给别人装、能卸载、能复核"。这是最后一波，也是唯一允许回头改 `src/` 的 ticket（修缺口，不是加功能）。

## 读什么

- `docs/specs/acceptance-matrix.md`（A01–A44 全表 + `## 规格静态验证`）
- `docs/specs/rea-multi-agent.md` 的 34 条 user story（逐条确认有落点或明确范围外）
- `docs/specs/orchestration-contract.md` 的 `## 稳定错误码`（核对实现里的码与表一致）
- `docs/specs/tool-discovery.md`（A37–A44 的插件侧只读消费边界）
- `docs/impl/CONVENTIONS.md`

## 交付

### 1. `docs/verify/acceptance-status.md`

一张逐条表：`编号 | 层 | 状态 | 证据位置 | 备注`。

- 状态只允许：`pass`（有可复跑的自动测试或已归档的 L3 记录）、`fail`、`not-run`（尚未执行，写清缺什么）、`out-of-scope`（规格明确范围外，附出处）。
- **禁止填占位"通过"**。没有证据就写 `not-run`。
- 每条 `pass` 必须能点到一个测试文件+用例名，或 `docs/verify/` 下的记录文件。

### 2. 缺口收口

对着表格逐条核，把**实现里该有但没有**的补齐。已知的高风险缺口（每条都要给出判定）：

- `rt_roster` 的工具可见性是否真的取自实际执行者，而不是 Lead 的集合（A08）；
- `capacity()` 在宿主无受支持余额读法时是否严格返回 `CAPACITY_UNKNOWN` 而不是兜底（A09）；
- `rt_dispatch` 是否严格产出 `in_progress + owner`，且 `pending + owner` 不可达（A11）；
- `rt_conclude` 的 `UNREVIEWED_COMPLETION` 补验路径是否真的跑完全部检查（A15）；
- 六类锚点的最低字段校验是否与锚点表逐字一致（A17）；
- `baseline_ref` 冻结后旧 seal 删除/变更是否被抓住（A19）；
- 审计写失败与回执写失败的**不同**处理（A27）；
- 操作阶段重入是否在 `member_ready` / `assigned` / `integrating` 三处都不重复动作（A24/A25）。

同时核一遍**错误码全部来自稳定错误码表**（用源码扫描断言，不允许出现表外的 `code`）。

### 3. 规格静态验证（自动化）

`test/schema-static.test.mjs`（T3 建的）之外补：

- 对 `docs/specs/rt-tools.schema.json` 的合法/非法样例覆盖到 `## 规格静态验证` 列出的每一类（默认只读 inspect、bind/takeover 必填条件、拒绝不支持的 action、缺派发字段、非法角色字段/旧 `context`、收口身份与 review、成功/失败信封、三工具成功 data）；
- 对 `docs/examples/tools.json` 与 `docs/examples/tools.md`：MD 的源哈希与快照字节一致、四层未知不冒充验证成功；
- 断言实现消费的默认工具名与岗位目录一致（`fs/search/jobs/web` 族名与插件 ID **不得**当已注册工具）。

### 4. 发布就绪

- 仓库根 `README.md` 更新：把「规格阶段——还没有可安装的产物」改成实际状态，写清安装、前置（团队 profile bundle 必须启用）、`bin/doctor.mjs` 用法、**一步卸载**（从 `dsh.profile.bundles` 去掉一行 + 移除 `link:` 依赖）、三层验证怎么跑。
- `packages/dsh-redteam-lead/README.md` 与 `locale` 同步。
- 一条 `pnpm`/`node` 就能跑全量：在仓库根加 `package.json` 的 `scripts.test`（或写进 README 的等价命令），保证 `node --test packages/dsh-redteam-lead/test` 从仓库根可跑。
- 确认 `git status` 干净、无 `node_modules`/临时产物被提交（`.gitignore` 已含）。

## 验收

- [ ] `node --test packages/dsh-redteam-lead/test` 从仓库根全绿
- [ ] `docs/verify/acceptance-status.md` 覆盖 A01–A44 **全部 44 行**，状态只用允许值，每条 `pass` 有可点开的证据
- [ ] 源码扫描：所有返回信封的 `code` 都取自稳定错误码表；无表外码
- [ ] 规格静态验证的每一类都有正例与反例
- [ ] 仓库根 `README.md` 不再是「规格阶段」措辞，且含安装/卸载/验证三段
- [ ] `git status` 干净；无临时文件、无绝对机器路径被硬编码进 `src/`
- [ ] 明确列出仍为 `not-run` 的项（预期主要是 L3 的真会话条目），并写清执行它们需要什么
