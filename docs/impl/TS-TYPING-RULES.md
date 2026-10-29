# TS 类型化攻坚规则（并行子任务共用）

> 背景：`t11-ts-src` 分支已完成机械迁移（26 个模块 `.mjs → .ts`，相对 import 全部 `./x.js`，外加 `src/types.ts` / `src/guards.ts`），但 `strict: true` 下仍有 **1361** 个类型错误。本文件是多个子代理**并行**把它清零时的共同约定。

## 铁律（违反即返工）

1. **只改分配给你的文件**。`src/types.ts` 与 `src/guards.ts` 是**只读共享**——不许改、不许加内容。需要新类型就在**自己模块内**用 `interface` / `type` 声明。
2. **不得改动任何导出函数的参数个数、顺序、语义、返回结构**。只允许**加类型**。导出名一字不改。
3. **禁止 `any`**。用 `unknown` + 收窄；确实需要松散处写 `Record<string, unknown>`。
4. **禁止 `@ts-expect-error` / `@ts-ignore` / 空类型断言 `as any`**。每一处 `as` 必须带一行注释说明不变量为什么成立。
5. **禁止用 `!` 非空断言糊弄**。确实成立的不变量写成判断 + 早返回，或加注释说明来源。
6. **禁止改 Behaviour**。只为类型修改表达式形态是允许的（例如把 `x.foo` 改写成 `const r = recordOf(x); if (typeof r.foo === 'string') …`），但**同一输入必须产生同一输出**。一旦发现必须改行为才能通过类型检查，**停下并在报告里说明**，不要自作主张改逻辑。
7. **禁止改 `tsconfig.json`**。`strict: true` / `noUncheckedIndexedAccess: false` 是定稿（DECISIONS D30）。
8. **禁止引入运行时依赖**。

## 已经可用的工具

```ts
// src/types.ts —— 直接 import type
import type {
  Diagnostic, Envelope, ResultStatus, Clock, FsLike,
  TeamAdapter, ProjectAdapter, Deps, HandlerCtx, HandlerResult,
} from './types.js'

// src/guards.ts —— 直接 import
import { isRecord, recordOf, thrownMessage, thrownCode } from './guards.js'
```

- `recordOf(x)`：把 `unknown` 收成 `Record<string, unknown>`（不是对象时返回 `{}`）。**读 JSON 字段统一走它**。
- `thrownMessage(e)` / `thrownCode(e)`：`catch` 里统一取消息/码，替代 `e.message` / `e.code`。
- `Deps` / `HandlerCtx` / `HandlerResult` 就是 SEAMS §1 的形状；`HandlerCtx` 已含 `deps/exec/services/config/now`。

## 常用收窄套路

```ts
// 读可选字符串字段
const r = recordOf(raw)
const routeId = typeof r.route_id === 'string' ? r.route_id : null

// 读可选数组
const items = Array.isArray(r.items) ? r.items : []

// 索引访问（noUncheckedIndexedAccess 已关，但仍要用类型表达可能缺失）
const entry = map[key] as Entry | undefined   // 注释：key 来自已校验的枚举

// 捕获
catch (error) { return failure('CHECK_FAILED', thrownMessage(error), thrownCode(error)) }
```

## 进度与验证（重要）

`tsc` 在 `noEmitOnError` 下**不会产出 `dist/`**，所以整包在你这一批完成前都编译不过 —— 这是预期的。

**你的验证方式**：只统计**你自己文件**的错误数，必须为 0。从 `packages/dsh-redteam-lead` 目录跑：

```powershell
node D:\workSpace\Rea-Multi-agent\node_modules\typescript\bin\tsc -p tsconfig.json --noEmit 2>&1 |
  Select-String -Pattern "error TS" |
  Select-String -Pattern "<你的文件名1>|<你的文件名2>" |
  Measure-Object | ForEach-Object { "my errors: $($_.Count)" }
```

报告里必须给出：全仓错误数（进了多少）→ 你的文件错误数（必须 0），以及全仓错误数的**变化量**。

## 分支与合并

- 你的分支从 **`t11-ts-src`**（不是 `feat/redteam-lead`）拉出：`git worktree add <dir> -b <branch> t11-ts-src`。
- 收工：`git add -A; git commit`。**不要** `git fetch . feat/redteam-lead`，**不要** merge 别人 —— Lead 统一合并这 5 个类型化分支。
- 不要 push。

## 报告要给的东西

1. 分支名、commit 列表。
2. `全仓错误数：进入时 N → 收工时 M`，以及 `我负责文件错误数：0`。
3. 每个我加过的 `as` 及一行理由。
4. 任何我认为「必须改行为才能过类型检查」的地方（这些不许自己改，报给我）。
5. 任何我发现的**真实缺陷**（类型检查过程中撞出来的逻辑问题），单独列出来。
