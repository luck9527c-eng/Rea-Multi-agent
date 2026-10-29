# T13（阶段二）— 测试转 TypeScript，并把替身接到真实依赖

**Blocked by:** T11（源码与打包已是 TS，测试暂时仍是 `.mjs` 且 import `dist/`）

## 这个 ticket 打通什么

1. 把 `test/**` 从 `.mjs` 迁到 `.ts`，让测试也吃类型检查（而不是只测字节）。
2. **补上 T12 指出的覆盖漏洞**：`test/helpers/host.mjs` 的 `makeCtx` 仍把 `deps.binding/contract/resources/submission/anchors/baseline` 置 `null`，于是 T6/T7 的双例走的是**回退分支**，而生产形状只有 `test/assembly.test.mjs` 一条 e2e 兜着。把 `makeCtx` 接到真实模块后，双例与生产同形。
3. 加 `dist` 漂移守卫：改了 `src` 忘了 `build` 就提交 → 红。

## 交付

### 1. 测试迁移

- `test/**/*.test.mjs` → `test/**/*.test.ts`；`test/helpers/*.mjs` → `.ts`。
- import 指向 `../dist/x.js`（类型来自 `dist/*.d.ts`）。
- **用例内容与断言不变**，只加类型标注；`any` 禁止。
- 门禁切换为：`npm run build && node --test "packages/dsh-redteam-lead/test/**/*.test.ts"`（从仓库根），并更新根 `package.json` 的 `scripts.test`、`packages/dsh-redteam-lead/README.md`、`docs/impl/CONVENTIONS.md` 的门禁命令。

### 2. `makeCtx` 接真实依赖

- `deps.binding/contract/resources/submission/anchors/baseline` 改为真实模块命名空间。
- 由此暴露出来的双例失败**逐个看**：如果是用例假定了 `null` 回退分支，改用例（并在报告里列出改了哪几条、为什么）；如果是实现 bug，修实现。

### 3. `test/dist-sync.test.ts`

- 断言 `dist/` 与 `src/` 同步：比较 `src/**/*.ts` 经 `tsc` 应产出的文件集合与 `dist/**/*.js` 实际集合，并比较内容摘要（或对比 mtime + 哈希）。
- 手动改坏 `dist` 里的任意一个文件 → 该用例必须变红；编造一个「只改 src 不 build」的场景也要红。

## 验收

- [ ] `npm run typecheck` 零错误（含测试）；`npm run build` 成功
- [ ] 门禁全绿，用例数 **≥ 472**
- [ ] `test/` 下无残留 `.mjs`
- [ ] `makeCtx` 的六个键全部为真实模块（有断言）
- [ ] `test/dist-sync.test.ts` 在故意改坏 `dist` 后变红（报告里贴出这次实验）
- [ ] 门禁命令在 `CONVENTIONS.md`、包 `README.md`、根 `package.json` 三处一致
- [ ] 无 `any`；无 `@ts-expect-error`
