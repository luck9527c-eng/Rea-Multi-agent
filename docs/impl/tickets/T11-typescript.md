# T11（阶段一）— 源码与打包转 TypeScript

**Blocked by:** T12（装配已收口、472 用例绿）

> 拆两步的原因：整个 import 图必须**同时**从 `src/*.mjs` 翻到 `dist/*.js`，所以 `src/` + `index.js` + `package.json` + `bin/` 必须原子迁移；而测试可以先用 `.mjs` 直接 import **已构建的** `dist/*.js`，不必跟着改。测试的类型化放到 T13（阶段二）。

## 交付

> **工具链已由 Lead 预置，不要重建**：仓库根 `package.json`（`typescript@^5.9` + `@types/node@^24`）、`packages/dsh-redteam-lead/tsconfig.json`、`scripts/build.mjs` 都已提交，`tsc 5.9.3` 实测可用。
> `tsconfig` 的 `strict: true` 与 **`noUncheckedIndexedAccess: false`** 是定稿，**不要改**（理由见 [DECISIONS.md](../DECISIONS.md) D30）。
> 调外部程序**不要** spawn `.cmd`/`.bat`（Windows 抛 `spawn EINVAL`），见 D30。

### 1. `src/` 迁移

- `packages/dsh-redteam-lead/src/*.mjs` → `src/*.ts`，共 21 个模块。**逐个导出**加类型；导出名、参数顺序、返回值形状**一字不改**。
- ESM + nodenext：**相对 import 必须写成 `./x.js`**（TS 的 nodenext 要求扩展名指向编译产物，不是 `.ts`）。
- 新增 `src/index.ts`：把现在根目录 `index.js` 的内容迁进来（`createDeps`、`invokeTool`、三工具注册、`createDeps` 的 SEAMS §1 契约）。它 **`export const name` / `export const inject` / `export function apply`** 必须与现在完全一致 —— 宿主按这三个符号识别插件。
- `src/catalog.data.json` 留在 `src/`，由 `scripts/build.mjs` 复制到 `dist/`；运行期路径以 `import.meta.url` 为基准，保证在 `dist/` 里也找得到。

### 2. 打包形态

- 删除根 `index.js`。
- `packages/dsh-redteam-lead/package.json`：`exports["."]` → `./dist/index.js`，`main` 同步；`files` 包含 `dist`（含 `dist/catalog.data.json`）、`bin`、`cordis.patch.yml`、`locale`、`icon.svg`；`dsh.bundle.patch` **不变**；`dependencies` **继续为空**。
- **`bin/doctor.mjs` 保留原路径与文件名**（规格钉死 `node <bundle-root>/bin/doctor.mjs`），内容改为薄壳：只 `import('../dist/doctor.js')` 并转交 argv / 退出码；仍然只依赖 `node:*` 与包内 `dist/`，插件未挂载时也能跑。
- `dist/` **提交进 git**（D28）；`.gitignore` 不要忽略它。

### 3. 测试保持可跑（本阶段不改测试语言）

- 测试文件**仍是 `.mjs`**，但 import 全部从 `../src/x.mjs` 改成 `../dist/x.js`。
- 门禁临时变为：`cd packages/dsh-redteam-lead; npm run build --prefix ../.. && node --test "test/**/*.test.mjs"`（或从仓库根 `npm run build && node --test "packages/dsh-redteam-lead/test/**/*.test.mjs"`）。
- **472 个用例一条不少地继续通过**，断言内容不得修改。若某用例因为「测的是源码路径」而失效（例如 `src/tool-schema.mjs` 的漂移测试比较 `docs/specs` 与包内副本），改成比对 `dist/` 里的副本或 `src/` 里的源，二者取其一但**必须仍然能发现漂移**。

### 4. 类型纪律

- **`any` 禁止**；无法精确建模处用 `unknown` + 收窄，或写局部 `interface`。每一处 `as` 要有注释说明为什么安全。
- 不得放宽 `strict`、不得用 `@ts-expect-error` 掩盖真实错误、不得加 `!` 非空断言来糊弄（确实不变量成立的地方要写注释）。
- 不得引入任何**运行时**依赖。

## 验收

- [ ] `npm run typecheck` 零错误；`npm run build` 成功
- [ ] 门禁全绿，**用例数 = 472（或更多），一条不少**；报告里贴出迁移前后的用例数对照
- [ ] `packages/dsh-redteam-lead/package.json` 的 `dependencies` 为空；`dist/**` 内无 `@deepseek-ai/` 引用
- [ ] `git ls-files packages/dsh-redteam-lead/dist` 非空（`dist/` 已提交）
- [ ] `node packages/dsh-redteam-lead/bin/doctor.mjs --profile <profile> --project <root>` 行为与迁移前**逐字段一致**（用一个迁移前的输出做对照）
- [ ] `src/` 下无残留 `.mjs`；根 `index.js` 已删除
- [ ] `cordis.patch.yml`、`locale/`、既有 `redteam` preset、`@local/dsh-rea-plugin` 零改动
- [ ] 三工具的注册形状（`name/inject/apply`、`parameters`、`output.schema`、`render`）与迁移前一致，`test/bundle.test.mjs` 与 `test/assembly.test.mjs` 全绿
