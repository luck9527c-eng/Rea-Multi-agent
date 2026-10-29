/**
 * 项目根规范化与项目内相对路径校验。
 *
 * 规则来自编排契约「路径、锁与资源」：
 * - `project_root` 必须是显式选择的本地分析目录，规范化为真实绝对根（`realpath`）并核对是目录。
 * - 插件生成的项目内路径统一用 `/`；拒绝绝对/盘符/UNC、空段、`.`/`..`、反斜杠、控制字符和 Windows ADS。
 * - 写入前逐级检查所有祖先及现有目标都不是 symlink/junction/reparse point，且新文件父目录在根内。
 * - 大小写折叠后的路径碰撞拒绝（Windows 文件系统不区分大小写，`Re` 与 `re` 会互相覆盖）。
 *
 * 判定函数（`assertProjectRelative` / `findCaseCollision` / `resolveInProject`）是纯函数；
 * 文件系统检查集中在 `normalizeProjectRoot` / `assertSafeWriteTarget` / `assertNoCaseCollision`。
 */
/**
 * 校验并返回项目内相对路径。
 *
 * 通过时原样返回（调用方已保证 `/` 分隔、无空段），不做大小写或文本改写。
 *
 * @throws {ContractError} code=PATH_INVALID
 */
export declare function assertProjectRelative(relativePath: unknown): string;
/**
 * 非抛出版本，供快速判定。
 */
export declare function isProjectRelative(value: unknown): boolean;
/**
 * 把项目内相对路径解析为绝对路径（不做文件系统检查）。
 */
export declare function resolveInProject(root: unknown, relativePath: unknown): string;
/**
 * 规范化项目根：必须是已存在的绝对目录，返回 `realpath` 后的真实绝对根。
 *
 * 链接/重解析点会被解析到真实位置；调用方得到的是可比较的规范根。
 *
 * @throws {ContractError} code=PATH_INVALID
 */
export declare function normalizeProjectRoot(projectRoot: unknown): Promise<string>;
/**
 * 写入前的路径安全检查：逐级确认祖先与现有目标不是链接/重解析点，
 * 且最深的已存在祖先真实路径仍在根内。返回写目标绝对路径。
 *
 * @throws {ContractError} code=PATH_INVALID
 */
export declare function assertSafeWriteTarget(root: unknown, relativePath: unknown): Promise<string>;
/**
 * 大小写折叠碰撞：若存在仅大小写不同的既有条目则返回该条目名，否则 null。
 *
 * 完全同名不算碰撞（那是同一个条目，由调用方决定覆盖语义）。
 */
export declare function findCaseCollision(existingNames: Iterable<unknown>, candidate: unknown): string | null;
/**
 * 逐级检查待写入路径是否与既有条目仅大小写不同；一旦发现即拒绝。
 *
 * 尚不存在的层级无需检查（更深的层级也不可能已存在）。
 *
 * @throws {ContractError} code=PATH_INVALID
 */
export declare function assertNoCaseCollision(root: unknown, relativePath: unknown): Promise<void>;
