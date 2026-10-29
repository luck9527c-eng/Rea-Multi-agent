# T11 — TypeScript 迁移（机械重构，零行为变更）

**Blocked by:** T5、T6、T7（等它们的 `.mjs` 实现落地合并，避免边迁移边改逻辑）

## 这个 ticket 打通什么

把已经跑绿的 `.mjs` 实现整体迁到 TypeScript，获得编译期类型检查，同时**不改变任何运行行为、不引入任何运行时依赖**。这是纯机械重构：门的判据是「278 个已存在的行为用例一条不少地继续通过」。

**不做**：不趁机改逻辑、不顺手"优化"、不重命名导出、不调整错误码。

## 读什么

- [CONVENTIONS.md](../CONVENTIONS.md)、[UPSTREAM-API.md](../UPSTREAM-API.md)（模块的真实导出签名）、[SEAMS.md](../SEAMS.md)
- [DECISIONS.md](../DECISIONS.md) **D28（本 ticket 的规格）**、D20（门禁命令）、D26（schema 子集）、D27（envelope 参数名）
- 现有实现：`packages/dsh-redteam-lead/` 全部 `.mjs`

## 交付

> **工具链已由 Lead 预置，不要重建**：仓库根 `package.json`（`typescript@^5.9` + `@types/node@^24`）、`packages/dsh-redteam-lead/tsconfig.json`、`scripts/build.mjs` 都已提交，`tsc 5.9.3` 实测可用。
> `tsconfig` 已定 `strict: true` + **`noUncheckedIndexedAccess: false`**（理由见 [DECISIONS.md](../DECISIONS.md) D30）。**不要**为了好过编译改这两个值。
> 调外部程序时**不要** spawn `.cmd`/`.bat`（Windows 会 `spawn EINVAL`），见 D30。

### 1. 仓库根 `package.json`（已存在，只按需微调）

已含 `scripts.build` / `scripts.test` / `scripts.typecheck` / `scripts.doctor`，`devDependencies` 为 `typescript` 与 `@types/node`。你只需在需要时把它们对齐到真实命令。
**`typescript` 只在这里**；`packages/dsh-redteam-lead/package.json` 的 `dependencies` 必须继续为空。

### 2. `packages/dsh-redteam-lead/tsconfig.json`（已存在，不要改关键项）

`strict: true`、`module: "nodenext"`、`moduleResolution: "nodenext"`、`target: "es2023"`、`lib: ["ES2023"]`、`types: ["node"]`、`rootDir: "src"`、`outDir: "dist"`、`declaration: true`、`sourceMap: false`、`verbatimModuleSyntax: true`、`erasableSyntaxOnly: true`、`noUncheckedIndexedAccess: true`、`exactOptionalPropertyTypes: false`（与现有 `?.`/可选字段写法兼容；若要打开，先证明 278 用例仍绿）。
`@types/node` 也放根 `devDependencies`。

### 3. 源码迁移

- `src/*.mjs` → `src/*.ts`，**逐文件、逐个导出**加类型；导出名、参数顺序、返回值形状**一字不改**。
- `src/catalog.data.json` 留在 `src/` 作为源，构建时复制到 `dist/`；运行期路径解析以 `import.meta.url` 为基准，保证在 `dist/` 里也找得到。`package.json` 的 `files` 必须把它包含进去。
- **`any` 禁止**：确实无法精确建模的地方用 `unknown` + 收窄，或写一个局部 `interface`；每一处 `as` 都要有一行注释说明为什么安全。
- 不得为了过编译而放宽 `strict`、不得用 `// @ts-expect-error` 掩盖真实类型错误。

### 4. 入口与打包形态

- **顺带修一个装配缺陷（T5 已定位）**：现在 `index.js` 在知道 `input.project_root` **之前**就 `createTeamAdapter(...)`，于是生产环境里 `capacity()` 读不到 `re/team/capacity.json`，永远 `known:false`（T5 只能加一条 `CAPACITY_DECLARATION_UNREAD` 诊断点名）。**修法**：入口顺序改为「解析入参 → `validate` 预校验出 `project_root` 并 `normalizeProjectRoot` → 再建两个适配器 → 交给 handler」。必须新增用例：给一个含 `re/team/capacity.json` 的项目，断言 `rt_roster inspect` 拿到 `declared:re/team/capacity.json` 而不是 `unavailable`。
- `package.json`：`exports["."]` → `./dist/index.js`；`main` 同步；`files` 改为包含 `dist`（含 `dist/catalog.data.json`）、`bin`、`cordis.patch.yml`、`locale`、`icon.svg`；`dsh.bundle.patch` **不变**。
- `index.js`（根）删除；真正入口是 `src/index.ts` → `dist/index.js`。
- **`bin/doctor.mjs` 保留原路径与原文件名**（规格钉死 `node <bundle-root>/bin/doctor.mjs`），内容改为薄壳：只 `import('../dist/doctor.js')` 并转交 argv/退出码。它必须仍然**只依赖 `node:*` 与包内 `dist/`**，在插件未挂载时也能跑。
- `dist/` **提交进 git**（见 D28）；`.gitignore` 不要忽略它。

### 5. 测试迁移

- `test/**/*.test.mjs` → `test/**/*.test.ts`，import 改为 `dist/`（测的就是要发货的字节）。
- `test/helpers/*.mjs` 同样迁到 `.ts`。
- 断言与用例**内容不变**；只加类型标注。
- 新增 `test/dist-sync.test.ts`：断言 `dist/` 与 `src/` 同步（例如比较构建产物 mtime/内容摘要，或重新构建后比对文件清单与内容哈希），**不同步即红** —— 防止有人改了 `src` 忘了 build 就提交。

### 6. 门禁

```
npm run build && node --test "packages/dsh-redteam-lead/test/**/*.test.ts"
```
`node --test test` 在 Node 24 上依然不可用（D20），**不要**加 `test/index.js` 去"修好"它。

## 验收

- [ ] `npm run typecheck` 零错误；`npm run build` 成功
- [ ] 门禁全绿，**用例数不少于迁移前**（迁移前基线以集成分支当时的实际数字为准，逐条对照，不允许静默丢用例）
- [ ] `packages/dsh-redteam-lead/package.json` 的 `dependencies` 为空；`dist/**` 内无 `@deepseek-ai/` 引用
- [ ] `dist/` 已提交，`git ls-files packages/dsh-redteam-lead/dist | wc -l` 非零
- [ ] `node packages/dsh-redteam-lead/bin/doctor.mjs --profile <profile> --project <root>` 行为与迁移前**逐字段一致**
- [ ] `cordis.patch.yml` 与 `locale/` 零改动；既有 `redteam` preset 与 `@local/dsh-rea-plugin` 零改动
- [ ] `src/` 与 `test/` 下**没有**残留 `.mjs`（`bin/doctor.mjs` 除外）
- [ ] 无 `any`（除每处带注释的 `as`）；无 `@ts-expect-error`
- [ ] `test/dist-sync.test.ts` 能在手动改坏 `dist` 后变红
