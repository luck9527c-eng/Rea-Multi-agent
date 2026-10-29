# T8 — 第二层验收：真实 reverse-project-management CLI 集成

**Blocked by:** T5、T6、T7

## 这个 ticket 打通什么

在**不依赖 DSH**的前提下，用真实项目 skill 副本的 `project.py` 在临时分析项目里跑通「派发→工兵写独立暂存→Lead 归档→seal→impact→index→check」的完整链路，证明适配器不是对着替身自证。这是三层里唯一能自动化的「真 skill」层。

## 读什么

- [CONVENTIONS.md](../CONVENTIONS.md)、[SEAMS.md](../SEAMS.md)
- **`D:\workSpace\rea-ma-notes\E3-project-skill.md`**（7 子命令、JSON 形状、退出码、seal 一次性、init 拒绝、`audit-scope` 的 scope 定义、ID 正则）
- `docs/specs/acceptance-matrix.md` 的 **全部 L2 行**：A04 / A05 / A14 / A15 / A16 / A17 / A18 / A19 / A20 / A21 / A23 / A24 / A28 / A29 / A30 / A32 / A35 / A36 / A37 / A41 / A42 / A43
- `docs/specs/project-management-integration.md` 的 `## 记录与写入归属`、`## 工兵交回与 rt_conclude`、`## 接缝与验收`

## 交付

`packages/dsh-redteam-lead/test/l2/` 下的集成测试，**只在 `project.py` 与 Python 真实可用时运行**（不可用时就地 `skip` 并写明原因，不得假通过）。

建议文件划分（可调整，但必须覆盖下面的场景）：

| 文件 | 覆盖 |
|---|---|
| `l2/helpers.mjs` | 建临时分析项目：`project.py init <root>` + 把真实 skill 副本放到 `.agents/skills/reverse-project-management/` + 补团队规则段 + 写最小 `re/targets.json` / `re/routes/R-001.json` / `re/runs/<RUN>/run.json` 与产物（**非可执行测试数据**） |
| `l2/seal-check.test.mjs` | 未封存 RUN 的 `seal` 成功、已封存只校验复用、`check --hashes` 通过；篡改已封存产物 → `check` 失败；`check --hashes --complete` 在验收缺口存在时失败（A19/A35） |
| `l2/archive.test.mjs` | 两个工兵分别写独立暂存 → Lead 串行归档 → 正式记录对应字节一致、执行事实（命令/cwd/时间/来源）不被改写（A28/A29） |
| `l2/impact.test.mjs` | B 的 RUN 更新 C 条件 → 真实 `impact` 报出 A 与下游复查，旧 closure 保留（A30） |
| `l2/outcomes.test.mjs` | 七类 outcome 的锚点/门槛，经真实 `check` 判定；未开始即阻塞可无 RUN（A16/A18） |
| `l2/recovery.test.mjs` | 重放/阶段失败/响应丢失不重复 seal 或 history；迟到 attempt 不污染新产物（A24/A32） |
| `l2/compat.test.mjs` | 旧副本缺团队规则、非默认布局、缺 Python 的**具体**诊断；克隆到新根/新会话后重做兼容检查（A05/A36） |
| `l2/lock.test.mjs` | 两个 Lead 并发时唯一整合者；锁持有者崩溃后不因过期夺锁（A21） |
| `l2/paths.test.mjs` | Windows 上实际验证：越界/绝对输出、junction/symlink、ADS、大小写碰撞、检查后改提交（A20） |

## 约束

- **不改** `src/` 里的业务实现。若发现实现 bug，写在报告里交回 Lead；只有测试侧的适配问题才在本 ticket 内改。
- 不写真实分析项目、不执行任何样本、不联网。
- 每个用例的临时目录在 `os.tmpdir()` 下并**显式清理**；失败时保留并打印路径。
- 断言真实 CLI 的输出与退出码，不用宽松匹配掩盖失败。
- 如果某条场景因 skill 能力所限无法构造（例如 skill 没有 dispute 文件写入命令），在测试里 `skip` 并写明**为什么不可构造**，不要伪造。

## 验收

- [ ] `node --test test` 全绿（含 L2；skip 项在输出里可见且原因具体）
- [ ] 上面 9 个场景文件全部存在且各自至少 1 个通过用例
- [ ] 至少一条用例证明「替身会通过但真 skill 会失败」的差异被真实 CLI 抓住（例如 check --hashes 对篡改产物的判定）
- [ ] 测试结束后 `os.tmpdir()` 下无残留目录
- [ ] 报告里列出：跑了哪些场景、哪些 skip 及原因、发现的实现缺陷清单
