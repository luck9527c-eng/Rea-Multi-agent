# T1 — 编排内核：信封、错误码、校验、路径、原子写、锁、身份、操作台账、审计

**Blocked by:** 无（可立即开工）

## 这个 ticket 打通什么

三个 rt 工具共用的最小可信内核，能让任何 handler「构造一个合规返回」「安全写一个项目内文件」「拿一次项目锁」「判断调用者是不是 Lead」「按 operation ID 重放/续做」「追加审计」，并且这些能力**全部有测试**。做完之后，后续 ticket 只写业务逻辑，不再碰这些横切关注点。

**不做**：不注册工具、不写 `index.js`、不读岗位目录、不接触 `ctx.agentTeams` 或项目 skill CLI。

## 读什么

- [CONVENTIONS.md](../CONVENTIONS.md)（全部）
- [MODULE-MAP.md](../MODULE-MAP.md)（T1 行的文件清单）
- `docs/specs/orchestration-contract.md`：`## 版本、角色与通用返回`、`## 路径、锁与资源`（锁与路径段）、`## 操作阶段与部分失败`、`## 稳定错误码`
- `docs/specs/rt-tools.schema.json`：`$defs.result`、`$defs.failureData`、`$defs.diagnostic`、`$defs.text`、`$defs.path`、`$defs.root`、`$defs.errorCode`、`$defs.id`
- `docs/specs/acceptance-matrix.md` 的 A20 / A24 / A25 / A26 / A27 / A32

## 交付

按 MODULE-MAP 写这 9 个 `src/` 模块 + `test/helpers/tmp.mjs` + 各自测试：

| 模块 | 职责要点 |
|---|---|
| `src/errors.mjs` | 稳定错误码常量（与契约表逐字一致）与 `ContractError {code, message, nextStep, details}`；`isContractError()` |
| `src/envelope.mjs` | `ok/blocked/partial/error` 四态信封构造器；强制字段 `schema_version=1, status, code, operation_id, replayed, retryable, diagnostics[], data`；`ok` 时 `code` 必须为 `null`，非 `ok` 必须有稳定码；异常到信封的转换（`fromError`），保证不抛栈 |
| `src/validate.mjs` | 零依赖 JSON Schema 子集校验（`type/required/properties/additionalProperties/items/enum/const/oneOf/anyOf/allOf/pattern/minLength/maxLength/minimum/maximum/maxItems/uniqueItems/format?`）；`validateInput(schemaDefs, defName, value)` 返回 `{ok, issues[]}`；另实现**规范化**：拒绝重复集合项 → 填默认值 → 规范化 root → 集合语义数组排序 → 计算 operation 输入哈希 |
| `src/paths.mjs` | `normalizeProjectRoot()`（真实绝对根、拒绝非目录）；`assertProjectRelative()` 拒绝绝对/盘符/UNC/空段/`.`/`..`/反斜杠/控制字符/Windows ADS；写入时逐级检查祖先与现有目标不是 symlink/junction/reparse；大小写折叠碰撞检测 |
| `src/atomic.mjs` | `writeJsonAtomic()`（同目录临时文件 + `fs.rename` 原子替换）；`createExclusive()`（`wx`，已存在且内容不同→冲突）；`sha256Bytes()/sha256File()`；`copyVerify()`（复制前后核对哈希） |
| `src/lock.mjs` | `re/team/lock` 原子独占创建；内容含 project/session、owner nonce、PID/进程启动身份、operation；冲突→`PROJECT_BUSY`；`release(force)` 只允许在显式恢复路径调用；**过期时间不自动解锁**（`isStale()` 只报告，不释放） |
| `src/identity.mjs` | 纯包装 `exec.agent` + `ctx.agentTeams.membership(agent)`；返回 `{role: 'lead'|'teammate'|'other', name, root}`；缺服务/非成员→`ROLE_REQUIRED`/`TEAM_SERVICE_UNAVAILABLE`；**绝不从入参或提示词取角色** |
| `src/operation.mjs` | operation 台账：`prepare(operationId, normalizedInputHash, phase)`、`findById`、`advance(phase, data)`、`replayResult`；相同 ID+相同哈希→恢复或重放；相同 ID+不同哈希→`OPERATION_CONFLICT`；阶段枚举与契约表逐字一致（prepared…needs_recovery）；`replayed` 标记 |
| `src/audit.mjs` | `re/team/audit.jsonl` append-only，字段 `at/kind/route/task/member/requester/verdict`；返回 `{written:boolean}`，失败不抛、由调用方写入 `audit_written=false` |

## 验收

- [ ] `node --test test` 全绿；每个模块至少一个测试文件
- [ ] 信封：`ok` 必 `code=null`；四种非 ok 态各有测试；`fromError` 对未知异常也返回合法信封且 `status=error`
- [ ] 校验器：对 `rt-tools.schema.json` 里 `rosterInput`/`dispatchInput`/`concludeInput` 各跑至少 1 个合法 + 2 个非法样例（缺必填、未知字段）
- [ ] 路径：绝对路径、`..`、反斜杠、UNC、ADS（`a:b`）、大小写碰撞各一例被拒；合法相对路径通过
- [ ] 原子写：替换后内容完整；独占创建冲突时不覆盖；`copyVerify` 在写入后篡改时抛冲突
- [ ] 锁：并发第二次获取返回 `PROJECT_BUSY`；`isStale` 为真也不自动释放（用假 clock 断言）
- [ ] 身份：`lead`/`teammate`/非成员/缺服务 四种分支；传给 handler 的自报 `role` 字段被完全忽略
- [ ] 操作台账：同 ID 同哈希重放返回原结果且 `replayed=true`；同 ID 改内容 → `OPERATION_CONFLICT`；阶段推进可持久化并重读
- [ ] 审计：写失败返回 `written=false` 且不抛；成功追加一行且字段齐全
- [ ] 零 `dependencies`；`grep -r "@deepseek-ai/" src test` 无命中
