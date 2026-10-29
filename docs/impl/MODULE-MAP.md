# 模块与文件归属

> 每个文件只有一个 owner ticket。并行 ticket 之间不得互相编辑对方文件；跨 scope 需求报给 Lead。
> 全部路径相对 `packages/dsh-redteam-lead/`。

## 布局

```
packages/dsh-redteam-lead/
  package.json                  T2
  cordis.patch.yml              T2
  index.js                      T2   # 唯一入口：注册三工具、路由 action、装配依赖
  src/tool-schema.mjs           T2   # 从 docs/specs/rt-tools.schema.json 复制的包内 schema（带漂移测试）
  bin/doctor.mjs                T2   # 只读自检 CLI（不依赖插件已挂载）
  locale/en.json, zh.json       T2
  README.md                     T2
  src/
    envelope.mjs                T1   # 结果信封、状态、诊断、信封构造
    errors.mjs                  T1   # 稳定错误码 + ContractError
    validate.mjs                T1   # 入参校验（JSON Schema 子集）+ 规范化
    paths.mjs                   T1   # 项目根规范化、项目内相对路径校验
    atomic.mjs                  T1   # 原子写、独占创建、字节哈希
    lock.mjs                    T1   # re/team/lock 项目锁
    identity.mjs                T1   # exec.agent -> role(lead|teammate|other) + membership
    operation.mjs               T1   # operation 台账、阶段、CAS、重放去重
    audit.mjs                   T1   # re/team/audit.jsonl append-only
    catalog.data.json           T3   # 岗位目录的包内副本（漂移测试对 docs/specs/roster-catalog.json）
    catalog.mjs                 T3   # 岗位目录加载/校验、模板组合、mixed 并集
    capability.mjs              T3   # 能力族解析、matchCapabilities 纯函数、绑定
    capacity.mjs                T3   # 席位/activation 预算裁剪（含 CAPACITY_UNKNOWN）
    team-adapter.mjs            T4   # ctx.agentTeams 薄封装
    project-adapter.mjs         T4   # reverse-project-management CLI adapter
    compatibility.mjs           T4   # 项目副本/规则/脚本指纹与兼容性检查
    roster.mjs                  T5   # rt_roster handler（inspect/bind/takeover）
    binding.mjs                 T5   # re/team/binding.json、roster.json、epoch、takeover
    dispatch.mjs                T6   # rt_dispatch handler
    contract.mjs                T6   # 派发契约构建、持久化、交付信封、任务板映射
    resources.mjs               T6   # re/team/resources.json 资源租用/隔离
    conclude.mjs                T7   # rt_conclude handler
    submission.mjs              T7   # submission.json 校验
    anchors.mjs                 T7   # 六类锚点闭集校验
    baseline.mjs                T7   # 派发基准快照、seal 复用与比对
    doctor.mjs                  T2   # doctor 的共享实现（bin/doctor.mjs 薄壳）
  test/
    helpers/fake-team.mjs       T4   # 契约级团队服务替身
    helpers/fake-project.mjs    T4   # 项目管理 adapter 替身
    helpers/tmp.mjs             T1   # 临时目录/临时项目搭建
    helpers/host.mjs            T4   # 假 ctx / 假 exec 装配
    envelope.test.mjs           T1
    validate.test.mjs           T1
    paths.test.mjs              T1
    atomic.test.mjs             T1
    lock.test.mjs               T1
    identity.test.mjs           T1
    operation.test.mjs          T1
    audit.test.mjs              T1
    catalog.test.mjs            T3
    capability.test.mjs         T3
    capacity.test.mjs           T3
    schema-static.test.mjs      T3   # 对 rt-tools.schema.json 与 roster-catalog.json 的静态校验
    bundle.test.mjs             T2   # 包形状、patch 行清单、preset 行
    doctor.test.mjs             T2
    roster.test.mjs             T5
    binding.test.mjs            T5
    dispatch.test.mjs           T6
    contract.test.mjs           T6
    resources.test.mjs          T6
    conclude.test.mjs           T7
    anchors.test.mjs            T7
    baseline.test.mjs           T7
    l2/                         T8   # 真实项目 skill CLI 集成
  scripts/
    l3-verify.mjs               T9   # 第三层真服务验收的可复跑步骤
  docs/verify/                  T9   # 验收记录与清单（仓库根 docs/verify）
```

## 依赖方向（禁止反向 import）

```
envelope/errors/validate/paths/atomic/lock/identity/operation/audit   (T1, 最底层)
        ↑
catalog/capability/capacity (T3)      team-adapter/project-adapter/compatibility (T4)
        ↑                                     ↑
roster/binding (T5)   dispatch/contract/resources (T6)   conclude/submission/anchors/baseline (T7)
        ↑
index.js (T2) 装配以上全部；bin/doctor.mjs 只依赖 T1 + T2 的 doctor.mjs（不依赖适配器）
```

`index.js` 由 T2 写成**稳定接口**，后续 ticket 只替换自己 handler 的实现，不改 `index.js`：

```js
// index.js 期望的 handler 形状（T2 定义，T5/T6/T7 实现）
// src/roster.mjs   -> export async function handleRoster(ctx, input)   // input 已通过 schema 校验
// src/dispatch.mjs -> export async function handleDispatch(ctx, input)
// src/conclude.mjs -> export async function handleConclude(ctx, input)
// 三者都返回 { envelope: <result 信封对象> }，不抛异常。
// ctx 由 index.js 组装：{ deps: {...}, exec, services, config, root }
```

`deps` 的键名，T2 必须固定为：`envelope, errors, validate, paths, atomic, lock, identity, operation, audit, catalog, capability, capacity, teamAdapter, projectAdapter, compatibility, binding, contract, resources, submission, anchors, baseline, clock, fs`（尚未实现的键可先给 `null`，由对应 ticket 填入自己的实现）。**T2 只写装配，不写业务逻辑。**
