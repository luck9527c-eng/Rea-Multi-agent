/**
 * `bin/doctor.mjs` 的共享实现：**只读**、不加载插件、不依赖团队服务、不需要 Cordis。
 *
 * 入口（契约「自检、会话接管与 Lead 循环」固定）：
 *
 * ```
 * node <bundle-root>/bin/doctor.mjs --profile <profile-root> --project <project-root>
 * ```
 *
 * 输出与三个 rt 工具一致的信封形状（八字段 + 每条诊断带 code/reason/next_step），
 * 并且**只报配置状态**：`configuration_ready` 来自本文件的结构检查，
 * `runtime_ready` 恒为 `unknown` —— 离线不可能知道团队服务是否在跑，也不许假装知道。
 * 退出码：有硬阻塞 → 1，否则 0。
 *
 * 依赖纪律：只用 `node:*` 内建。故意**不** import `src/envelope.mjs` 或任何适配器 ——
 * 自检工具要在「兄弟模块坏了/还没合入」时照样能跑；`test/doctor.test.mjs` 用源码级断言钉住这条。
 *
 * @module @local/dsh-redteam-lead/doctor
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
/** 非 null 对象（等价于 `typeof x === 'object' && x !== null`）。 */
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
/** 读记录的字段；不是记录就给空对象（与 `src/guards.ts` 的 `recordOf` 逐字等价）。 */
function recordOf(value) {
    return isRecord(value) ? value : {};
}
/** 抛出错上的 `code`；不是字符串就当没有（与 `thrownCode` 逐字等价）。 */
function thrownCode(thrown) {
    if (isRecord(thrown) && 'code' in thrown) {
        const code = thrown.code;
        return typeof code === 'string' ? code : null;
    }
    return null;
}
/** 把任意抛出物压成一句文本（与 `thrownMessage` 逐字等价）。 */
function thrownMessage(thrown) {
    if (isRecord(thrown) && 'message' in thrown) {
        const message = thrown.message;
        if (message !== undefined && message !== null)
            return String(message);
    }
    return String(thrown);
}
/**
 * `Object.keys(value ?? {})`。
 *
 * 原写法直接交给 `Object.keys`（非对象按 JS 语义处理，例如字符串会被拆成索引键），
 * 这里只在类型上断言成 `object`，运行期表达式一字未改。
 */
function objectKeys(value) {
    // 断言成立的理由：`Object.keys` 在运行期接受任意值（内部做 ToObject），这里只是满足签名。
    return Object.keys((value ?? {}));
}
/** 本包包名（profile 的 `dsh.profile.bundles` 与 `dependencies` 里必须出现）。 */
export const BUNDLE_NAME = '@local/dsh-redteam-lead';
/** 团队服务随这个 profile bundle 一起启用（D7：只能靠 bundle 成员资格开启）。 */
export const TEAM_PROFILE_BUNDLE = '@deepseek-ai/dsh-experimental-agent-team-profile';
/** 项目内项目 skill 副本的相对位置（SEAMS §4：脚本必须从项目副本内调用）。 */
export const SKILL_COPY_DIR = join('.agents', 'skills', 'reverse-project-management');
/** 离线诊断永远只能说 runtime 未知。 */
export const RUNTIME_READY = 'unknown';
/**
 * 本包 `exports["."]` 的期望值。
 *
 * TS 迁移（DECISIONS D28）把可执行源码从包根 `index.js` 挪到 `dist/index.js`：宿主仍然只经
 * `exports["."]` 找入口，所以自检断言的是这个声明，而不是某个硬编码的文件位置。
 */
const ENTRY_EXPORT = './dist/index.js';
/**
 * 诊断用的稳定错误码。只取编排契约「稳定错误码」表里的码：
 * - 安装/项目配置不完整 → PROJECT_NOT_CONFIGURED
 * - 团队服务不可用 → TEAM_SERVICE_UNAVAILABLE
 * - 项目 skill 副本/解释器不兼容 → SKILL_INCOMPATIBLE
 * - 参数写法错误 → INVALID_ARGUMENT
 */
const CODE_CONFIGURED = 'PROJECT_NOT_CONFIGURED';
const CODE_TEAM = 'TEAM_SERVICE_UNAVAILABLE';
const CODE_SKILL = 'SKILL_INCOMPATIBLE';
const CODE_ARGUMENT = 'INVALID_ARGUMENT';
/** 命令行用法（`--profile` 必填；`--project` 可省略；`--bundle` 仅用于校验打包/临时副本）。 */
export const USAGE = [
    '用法：node <bundle-root>/bin/doctor.mjs --profile <profile-root> [--project <project-root>] [--bundle <bundle-root>]',
    '',
    '  --profile  必填。DSH profile 目录（含 package.json 的 dsh.profile.bundles），',
    '             例如 %USERPROFILE%\\.dsh\\profiles\\desktop',
    '  --project  可选。分析项目根（含 INDEX.md 与 re/）。省略时项目侧检查标 skip。',
    '  --bundle   可选。默认是本包根目录；只有校验打包副本或临时目录时才需要。',
    '  --json     兼容用开关（输出本来就是 JSON）。',
    '  --help     打印本用法。',
].join('\n');
/**
 * 解析命令行参数。
 * @param {string[]} argv `process.argv.slice(2)`
 * @returns {{ profileRoot?: string, projectRoot?: string, bundleRoot?: string, help?: boolean, problems: string[] }}
 */
export function parseDoctorArgs(argv) {
    const out = { problems: [] };
    const takeValue = (index, flag) => {
        const value = argv[index + 1];
        if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
            out.problems.push(`${flag} 缺少值`);
            return undefined;
        }
        return value;
    };
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        const [flag, inline] = token.includes('=') ? [token.slice(0, token.indexOf('=')), token.slice(token.indexOf('=') + 1)] : [token, undefined];
        const value = inline ?? undefined;
        switch (flag) {
            case '--profile':
            case '--project':
            case '--bundle': {
                const resolved = value ?? takeValue(index, flag);
                if (value === undefined)
                    index += 1;
                if (resolved !== undefined) {
                    if (flag === '--profile')
                        out.profileRoot = resolve(resolved);
                    else if (flag === '--project')
                        out.projectRoot = resolve(resolved);
                    else
                        out.bundleRoot = resolve(resolved);
                }
                break;
            }
            case '--json':
                break;
            case '--help':
            case '-h':
                out.help = true;
                break;
            default:
                out.problems.push(`未知参数 ${token}`);
        }
    }
    return out;
}
/** 读 JSON 文件；失败返回 `{ok:false, error}`，绝不抛。 */
function readJson(path) {
    try {
        return { ok: true, value: JSON.parse(readFileSync(path, 'utf8')) };
    }
    catch (error) {
        return { ok: false, error: `${path}: ${thrownCode(error) ?? ''} ${thrownMessage(error)}`.trim() };
    }
}
function isDirectory(path) {
    try {
        return statSync(path).isDirectory();
    }
    catch {
        return false;
    }
}
function isFile(path) {
    try {
        return statSync(path).isFile();
    }
    catch {
        return false;
    }
}
/** 列出目录下的文件名；失败返回空数组。 */
function listNames(path) {
    try {
        return readdirSync(path);
    }
    catch {
        return [];
    }
}
/** 检查清单：pass / skip / fail，fail 同时产出一条诊断；只有 hard fail 才阻止 configuration_ready。 */
function createChecks() {
    const checks = [];
    const diagnostics = [];
    const push = (entry) => { checks.push(entry); };
    return {
        checks,
        diagnostics,
        pass(id, detail) {
            push({ id, status: 'pass', severity: 'hard', detail });
        },
        skip(id, detail) {
            push({ id, status: 'skip', severity: 'soft', detail });
        },
        /**
         * @param {string} id 检查项
         * @param {{ severity?: 'hard'|'soft', detail: string, code: string, nextStep: string }} options
         */
        fail(id, options) {
            const severity = options.severity ?? 'hard';
            push({ id, status: 'fail', severity, detail: options.detail });
            // 软失败也写诊断，只是不让 configuration_ready 变 false
            diagnostics.push({ code: options.code, reason: `[${id}] ${options.detail}`, next_step: options.nextStep });
        },
        get hardFailure() {
            return checks.some((check) => check.status === 'fail' && check.severity === 'hard');
        },
    };
}
/** 解释器探针：只验证「能启动且 `-V` 退出 0」，不解析版本文案。 */
function probeInterpreter(interpreter) {
    const probe = spawnSync(interpreter, ['-V'], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
    if (probe.error) {
        const missing = thrownCode(probe.error) === 'ENOENT';
        return { ok: false, version: null, detail: missing ? `找不到可执行文件：${interpreter}` : thrownMessage(probe.error) };
    }
    const firstLine = String(probe.stdout || probe.stderr || '').split(/\r?\n/).find((line) => line.trim().length > 0);
    return {
        ok: probe.status === 0,
        version: firstLine === undefined ? null : firstLine.trim(),
        detail: probe.status === 0 ? null : `${interpreter} -V 退出码 ${probe.status}`,
    };
}
/** 项目配置里若显式记录了实际解释器，优先采用（SEAMS §4：项目 pin > PATH）。 */
function resolveInterpreter(projectConfig) {
    const config = recordOf(projectConfig);
    const candidates = [
        [config.python, 're/project.json#python'],
        [config.python_executable, 're/project.json#python_executable'],
        [recordOf(config.environment).python, 're/project.json#environment.python'],
    ];
    for (const [value, source] of candidates) {
        if (typeof value === 'string' && value.trim().length > 0)
            return { interpreter: value.trim(), source };
    }
    return { interpreter: 'python', source: 'PATH' };
}
function checkBundle(recorder, bundleRoot) {
    const facts = {
        root: bundleRoot,
        name: null,
        version: null,
        manifest_ok: false,
        entry_present: false,
        patch_files: [],
        dependencies: [],
    };
    if (!isDirectory(bundleRoot)) {
        recorder.fail('bundle.exists', {
            code: CODE_CONFIGURED,
            detail: `bundle 目录不存在：${bundleRoot}`,
            nextStep: `确认 --bundle 指向 @local/dsh-redteam-lead 的安装目录（默认是本包根目录）；仓库内是 packages/dsh-redteam-lead`,
        });
        return facts;
    }
    recorder.pass('bundle.exists', bundleRoot);
    const manifestPath = join(bundleRoot, 'package.json');
    const manifest = readJson(manifestPath);
    if (!manifest.ok) {
        recorder.fail('bundle.manifest', {
            code: CODE_CONFIGURED,
            detail: `package.json 读不到或不是合法 JSON：${manifest.error}`,
            nextStep: '恢复 package.json（仓库内 packages/dsh-redteam-lead/package.json），然后重新 link: 安装本包',
        });
        return facts;
    }
    facts.manifest_ok = true;
    const manifestValue = recordOf(manifest.value);
    facts.name = typeof manifestValue.name === 'string' ? manifestValue.name : null;
    facts.version = typeof manifestValue.version === 'string' ? manifestValue.version : null;
    facts.dependencies = objectKeys(manifestValue.dependencies);
    recorder.pass('bundle.manifest', `${manifestPath}（name=${facts.name}）`);
    if (facts.name === BUNDLE_NAME)
        recorder.pass('bundle.name', BUNDLE_NAME);
    else {
        recorder.fail('bundle.name', {
            code: CODE_CONFIGURED,
            detail: `包名是 ${String(facts.name)}，但 profile 行与本文件都按 ${BUNDLE_NAME} 解析`,
            nextStep: `把 package.json 的 name 改回 ${BUNDLE_NAME}，否则 patch 里的 name: 解析不到模块`,
        });
    }
    if (manifestValue.type === 'module')
        recorder.pass('bundle.type', 'type: module');
    else {
        recorder.fail('bundle.type', {
            code: CODE_CONFIGURED,
            detail: `package.json 的 type 是 ${String(manifestValue.type)}，入口是 ESM`,
            nextStep: '设置 "type": "module"',
        });
    }
    const exportsMap = recordOf(manifestValue.exports);
    const entry = exportsMap['.'];
    if (entry === ENTRY_EXPORT)
        recorder.pass('bundle.exports', `${ENTRY_EXPORT} + ./locale/*.json`);
    else {
        recorder.fail('bundle.exports', {
            code: CODE_CONFIGURED,
            detail: `exports["."] 是 ${JSON.stringify(entry)}，应为 "${ENTRY_EXPORT}"`,
            nextStep: `按宿主 bundle 形态声明 "exports": { ".": "${ENTRY_EXPORT}", "./locale/*.json": "./locale/*.json" }`,
        });
    }
    if (exportsMap['./locale/*.json'] === undefined) {
        recorder.fail('bundle.exports-locale', {
            code: CODE_CONFIGURED,
            severity: 'soft',
            detail: 'exports 里缺少 "./locale/*.json"：宿主读不到显示名',
            nextStep: '加上 "./locale/*.json": "./locale/*.json"（每个 locale 文件都必须能通过 exports 解析）',
        });
    }
    else
        recorder.pass('bundle.exports-locale', './locale/*.json');
    // 入口以 manifest 声明的 exports["."] 为准（TS 迁移后是本包的 ./dist/index.js）；
    // 探针要能诊断任意 bundle 目录，所以只按声明解析，不硬编码成 dist。
    const entryPath = typeof entry === 'string' ? resolve(bundleRoot, entry) : join(bundleRoot, 'dist', 'index.js');
    facts.entry_present = isFile(entryPath);
    if (facts.entry_present)
        recorder.pass('bundle.entry', entryPath);
    else {
        recorder.fail('bundle.entry', {
            code: CODE_CONFIGURED,
            detail: `入口文件不存在：${entryPath}`,
            nextStep: `从仓库 packages/dsh-redteam-lead 重建产物（npm run build，产出 ${ENTRY_EXPORT}），再重新 link: 安装本包`,
        });
    }
    const declaredPatch = recordOf(recordOf(manifestValue.dsh).bundle).patch;
    const patchList = typeof declaredPatch === 'string' ? [declaredPatch] : Array.isArray(declaredPatch) ? declaredPatch : [];
    if (patchList.length === 0) {
        recorder.fail('bundle.patch', {
            code: CODE_CONFIGURED,
            detail: 'package.json 缺少 dsh.bundle.patch —— 这个包不被当作 bundle，patch 层不会生效',
            nextStep: '加上 "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }',
        });
    }
    else {
        for (const relative of patchList) {
            const full = resolve(bundleRoot, relative);
            const present = isFile(full);
            facts.patch_files.push({ path: full, exists: present });
            if (present)
                recorder.pass('bundle.patch', full);
            else {
                recorder.fail('bundle.patch', {
                    code: CODE_CONFIGURED,
                    detail: `dsh.bundle.patch 指向的文件不存在：${full}`,
                    nextStep: `恢复 ${full}（仓库内 packages/dsh-redteam-lead/cordis.patch.yml），或重新 link: 安装本包后重跑 doctor`,
                });
            }
        }
    }
    if (facts.dependencies.length === 0)
        recorder.pass('bundle.dependencies', 'dependencies 为空');
    else {
        recorder.fail('bundle.dependencies', {
            code: CODE_CONFIGURED,
            detail: `dependencies 非空：${facts.dependencies.join(', ')}`,
            nextStep: '删除 dependencies：link: 安装的 bundle 不会安装依赖，宿主能力只能经注入的 ctx 取',
        });
    }
    const localeDir = join(bundleRoot, 'locale');
    const enPath = join(localeDir, 'en.json');
    const en = readJson(enPath);
    const enMeta = en.ok ? recordOf(recordOf(en.value).meta) : {};
    const title = enMeta.title;
    const description = enMeta.description;
    if (en.ok && typeof title === 'string' && title.trim() && typeof description === 'string' && description.trim()) {
        recorder.pass('bundle.locale', `${enPath}（meta.title / meta.description 齐备）`);
    }
    else {
        recorder.fail('bundle.locale', {
            code: CODE_CONFIGURED,
            severity: 'soft',
            detail: en.ok ? `${enPath} 的 meta.title / meta.description 必须是非空字符串` : `读不到 ${enPath}`,
            nextStep: '补 locale/en.json 与 locale/zh.json 的 meta.title / meta.description（只影响显示名，不影响挂载）',
        });
    }
    return facts;
}
function checkProfile(recorder, profileRoot, bundleRoot) {
    const facts = {
        root: profileRoot,
        exists: false,
        manifest_ok: false,
        bundles: [],
        team_profile_enabled: false,
        bundle_listed: false,
        bundle_declared: false,
        bundle_linked: false,
        declared_local: [],
        linked_local: [],
    };
    if (!isDirectory(profileRoot)) {
        recorder.fail('profile.exists', {
            code: CODE_CONFIGURED,
            detail: `profile 目录不存在：${profileRoot}`,
            nextStep: `核对 --profile 是否指向 %USERPROFILE%\\.dsh\\profiles\\<name>；现有 profile 可用 Get-ChildItem ${join('%USERPROFILE%', '.dsh', 'profiles')} 查看`,
        });
        return facts;
    }
    facts.exists = true;
    recorder.pass('profile.exists', profileRoot);
    const manifestPath = join(profileRoot, 'package.json');
    const manifest = readJson(manifestPath);
    if (!manifest.ok) {
        recorder.fail('profile.manifest', {
            code: CODE_CONFIGURED,
            detail: `profile 的 package.json 读不到或不是合法 JSON：${manifest.error}`,
            nextStep: '恢复 profile 的 package.json（dependencies 里 link: 各 bundle，dsh.profile.bundles 里按顺序列出启用的 bundle）',
        });
        return facts;
    }
    facts.manifest_ok = true;
    recorder.pass('profile.manifest', manifestPath);
    const profileManifest = recordOf(manifest.value);
    const bundles = recordOf(recordOf(profileManifest.dsh).profile).bundles;
    if (!Array.isArray(bundles)) {
        recorder.fail('profile.bundles', {
            code: CODE_CONFIGURED,
            detail: 'profile 的 package.json 缺少 dsh.profile.bundles 数组',
            nextStep: `加上 "dsh": { "profile": { "bundles": [..., "${TEAM_PROFILE_BUNDLE}", "${BUNDLE_NAME}"] } }`,
        });
        return facts;
    }
    facts.bundles = bundles.filter((item) => typeof item === 'string');
    recorder.pass('profile.bundles', `${facts.bundles.length} 个 bundle`);
    facts.team_profile_enabled = facts.bundles.includes(TEAM_PROFILE_BUNDLE);
    if (facts.team_profile_enabled)
        recorder.pass('profile.team-bundle', TEAM_PROFILE_BUNDLE);
    else {
        recorder.fail('profile.team-bundle', {
            code: CODE_TEAM,
            detail: `dsh.profile.bundles 里没有 ${TEAM_PROFILE_BUNDLE}：ctx.agentTeams 不会存在，三个 rt 工具都会返回 TEAM_SERVICE_UNAVAILABLE`,
            nextStep: `把 "${TEAM_PROFILE_BUNDLE}" 加进 profile package.json 的 dsh.profile.bundles（它没有按 bundle 的 disabled 字段，只能靠成员资格启用），然后重启 DSH`,
        });
    }
    facts.bundle_listed = facts.bundles.includes(BUNDLE_NAME);
    if (facts.bundle_listed)
        recorder.pass('profile.bundle-listed', BUNDLE_NAME);
    else {
        recorder.fail('profile.bundle-listed', {
            code: CODE_CONFIGURED,
            detail: `dsh.profile.bundles 里没有 ${BUNDLE_NAME}：本包的 patch 层不会生效，preset 不会出现在模式列表`,
            nextStep: `把 "${BUNDLE_NAME}" 加进 dsh.profile.bundles（顺序在 ${TEAM_PROFILE_BUNDLE} 之后）`,
        });
    }
    const dependencies = { ...recordOf(profileManifest.dependencies) };
    facts.declared_local = Object.keys(dependencies).filter((name) => name.startsWith('@local/'));
    facts.bundle_declared = Object.hasOwn(dependencies, BUNDLE_NAME);
    if (facts.bundle_declared)
        recorder.pass('profile.bundle-declared', `${BUNDLE_NAME} → ${String(dependencies[BUNDLE_NAME])}`);
    else {
        recorder.fail('profile.bundle-declared', {
            code: CODE_CONFIGURED,
            detail: `profile 的 dependencies 里没有 ${BUNDLE_NAME}`,
            nextStep: `在 profile 目录执行 pnpm add "link:${bundleRoot}"（或手工把它写进 dependencies），再确认 dsh.profile.bundles 里有它`,
        });
    }
    const localDir = join(profileRoot, 'node_modules', '@local');
    facts.linked_local = listNames(localDir).filter((name) => isDirectory(join(localDir, name)));
    const linkedEntry = join(localDir, 'dsh-redteam-lead');
    facts.bundle_linked = isDirectory(linkedEntry) && isFile(join(linkedEntry, 'package.json'));
    if (facts.bundle_linked)
        recorder.pass('profile.bundle-linked', linkedEntry);
    else {
        recorder.fail('profile.bundle-linked', {
            code: CODE_CONFIGURED,
            detail: `profile 的 node_modules 里没有链接到本包：${linkedEntry}`,
            nextStep: `在 ${profileRoot} 执行 pnpm install（link: 依赖才会落到 node_modules），并确认 link: 指向 ${bundleRoot}`,
        });
    }
    const missingLinks = facts.declared_local.filter((name) => {
        const leaf = name.split('/').at(-1);
        return leaf !== undefined && !facts.linked_local.includes(leaf);
    });
    if (missingLinks.length === 0)
        recorder.pass('profile.local-links', 'dependencies 里的 @local 包都有 node_modules 链接');
    else {
        recorder.fail('profile.local-links', {
            code: CODE_CONFIGURED,
            severity: 'soft',
            detail: `dependencies 声明了但 node_modules/@local 下没有：${missingLinks.join(', ')}`,
            nextStep: `在 ${profileRoot} 重新执行 pnpm install；若某个包已废弃，把它从 dependencies 与 dsh.profile.bundles 一起去掉`,
        });
    }
    return facts;
}
// ---------------------------------------------------------------------------
// 检查：项目
// ---------------------------------------------------------------------------
/** 项目侧检查项 id —— 没给 --project 时全部标 skip。 */
const PROJECT_CHECK_IDS = [
    'project.exists',
    'project.index',
    'project.config',
    'project.skill',
    'project.team-rules',
    'project.script',
    'project.python',
];
function checkProject(recorder, projectRoot) {
    const facts = {
        root: projectRoot,
        exists: false,
        index_present: false,
        config_present: false,
        skill_copy_present: false,
        team_rules_present: false,
        project_py_present: false,
        python: { interpreter: null, source: null, ok: false, version: null },
    };
    if (!isDirectory(projectRoot)) {
        recorder.fail('project.exists', {
            code: CODE_CONFIGURED,
            detail: `项目目录不存在：${projectRoot}`,
            nextStep: '核对 --project 是否指向已经初始化过的分析项目根（含 INDEX.md 与 re/）',
        });
        for (const id of PROJECT_CHECK_IDS.slice(1))
            recorder.skip(id, '项目目录不存在，跳过');
        return facts;
    }
    facts.exists = true;
    recorder.pass('project.exists', projectRoot);
    facts.index_present = isFile(join(projectRoot, 'INDEX.md'));
    if (facts.index_present)
        recorder.pass('project.index', join(projectRoot, 'INDEX.md'));
    else {
        recorder.fail('project.index', {
            code: CODE_CONFIGURED,
            detail: `项目缺 INDEX.md：${join(projectRoot, 'INDEX.md')}`,
            nextStep: '按 reverse-project-management 的 init 在新项目上初始化；已有项目不要用 init，按 skill 的手工区补 INDEX.md',
        });
    }
    const configPath = join(projectRoot, 're', 'project.json');
    const config = readJson(configPath);
    facts.config_present = config.ok;
    if (config.ok)
        recorder.pass('project.config', configPath);
    else {
        recorder.fail('project.config', {
            code: CODE_CONFIGURED,
            detail: `读不到项目配置：${config.error}`,
            nextStep: '按项目 skill 建 re/project.json（验收/审计记录）；不要用全局副本覆盖历史项目',
        });
    }
    const skillDir = join(projectRoot, SKILL_COPY_DIR);
    const skillDoc = join(skillDir, 'SKILL.md');
    facts.skill_copy_present = isDirectory(skillDir) && isFile(skillDoc);
    if (facts.skill_copy_present)
        recorder.pass('project.skill', skillDir);
    else {
        recorder.fail('project.skill', {
            code: CODE_SKILL,
            detail: `项目内没有 reverse-project-management 副本：${skillDir}`,
            nextStep: `把 skill 复制到 ${skillDir}（必须从项目副本调用 project.py，不能用全局目录），再跑 doctor 复核`,
        });
    }
    // 团队规则段（DECISIONS D8：副本缺团队规则 → bind 拒绝；永不用全局副本覆盖项目副本）
    const teamRef = join(skillDir, 'references', 'team-coordination.md');
    let skillText = '';
    try {
        skillText = readFileSync(skillDoc, 'utf8');
    }
    catch {
        skillText = '';
    }
    facts.team_rules_present =
        isFile(teamRef) || /team-coordination|团队(?:协作|规则)/.test(skillText);
    if (facts.team_rules_present)
        recorder.pass('project.team-rules', isFile(teamRef) ? teamRef : 'SKILL.md 提到团队规则');
    else {
        recorder.fail('project.team-rules', {
            code: CODE_SKILL,
            detail: '项目 skill 副本里没有团队规则段（references/team-coordination.md 缺失，SKILL.md 也没提）',
            nextStep: '按 skill 的团队规则合并项目副本（只补规则段，不要用全局副本覆盖项目副本）；补完重跑 doctor',
        });
    }
    const scriptPath = join(skillDir, 'scripts', 'project.py');
    facts.project_py_present = isFile(scriptPath);
    if (facts.project_py_present)
        recorder.pass('project.script', scriptPath);
    else {
        recorder.fail('project.script', {
            code: CODE_SKILL,
            detail: `项目副本里没有 project.py：${scriptPath}`,
            nextStep: `从 skill 源复制 scripts/（含 project.py 与其扁平 import 的 governance/impact/integrity 模块）到 ${join(skillDir, 'scripts')}`,
        });
    }
    const resolved = resolveInterpreter(config.ok ? config.value : undefined);
    const probe = probeInterpreter(resolved.interpreter);
    facts.python = {
        interpreter: resolved.interpreter,
        source: resolved.source,
        ok: probe.ok,
        version: probe.version,
    };
    if (probe.ok)
        recorder.pass('project.python', `${resolved.interpreter}（${resolved.source}）${probe.version === null ? '' : ` ${probe.version}`}`);
    else {
        recorder.fail('project.python', {
            code: CODE_SKILL,
            detail: `Python 不可用（来源 ${resolved.source}）：${probe.detail}`,
            nextStep: '把项目使用的解释器放到 PATH，或在 re/project.json 的 "python" 字段写它的绝对路径（本机同时存在 3.15.2 与项目 pin 的 3.12.14，要写明用哪个）',
        });
    }
    return facts;
}
/** 构造一个与工具一致的信封；doctor 不成 operation，`operation_id` 恒为 null。 */
function envelope(status, { code = null, diagnostics = [], data = null } = {}) {
    return {
        schema_version: 1,
        status,
        code,
        operation_id: null,
        replayed: false,
        retryable: false,
        diagnostics,
        data,
    };
}
/**
 * 跑一次只读自检。
 *
 * @param {{
 *   profileRoot?: string,
 *   projectRoot?: string,
 *   bundleRoot?: string,
 *   problems?: string[],
 *   help?: boolean,
 * }} options `bundleRoot` 省略时用本包根目录（`bin/` 的上一级）
 * @returns {{ envelope: object, exitCode: number, report: object | null }}
 */
export function runDoctor(options = {}) {
    // 默认 bundle 根 = 本文件所在目录的上一级（`dist/`→包根，`src/`→包根）。
    const bundleRoot = options.bundleRoot ?? dirname(dirname(fileURLToPath(import.meta.url)));
    if (options.help === true) {
        return {
            envelope: envelope('ok', {
                data: {
                    configuration_ready: true,
                    runtime_ready: RUNTIME_READY,
                    bundle: null,
                    profile: null,
                    project: null,
                    checks: [],
                    usage: USAGE,
                },
            }),
            exitCode: 0,
            report: null,
        };
    }
    const problems = [...(options.problems ?? [])];
    // 先落成局部常量：`problems` 非空时早返回，之后 `profileRoot` 必是字符串。
    const profileRoot = options.profileRoot;
    if (profileRoot === undefined)
        problems.push('缺少 --profile（必填：DSH profile 目录）');
    if (problems.length > 0) {
        return {
            envelope: envelope('error', {
                code: CODE_ARGUMENT,
                diagnostics: [
                    {
                        code: CODE_ARGUMENT,
                        reason: `参数不完整：${problems.join('；')}`,
                        next_step: USAGE,
                    },
                ],
                data: {
                    configuration_ready: false,
                    runtime_ready: RUNTIME_READY,
                    bundle: null,
                    profile: null,
                    project: null,
                    checks: [],
                },
            }),
            exitCode: 1,
            report: null,
        };
    }
    const recorder = createChecks();
    const bundle = checkBundle(recorder, bundleRoot);
    // 断言成立的理由：上面 `profileRoot === undefined` 会往 `problems` 塞一条并在下一段早返回，
    // 所以走到这里 `profileRoot` 必是字符串（运行期没有任何转换）。
    const profile = checkProfile(recorder, profileRoot, bundleRoot);
    let project = null;
    if (options.projectRoot === undefined) {
        for (const id of PROJECT_CHECK_IDS)
            recorder.skip(id, '未提供 --project，跳过项目侧检查');
    }
    else {
        project = checkProject(recorder, options.projectRoot);
    }
    const configurationReady = !recorder.hardFailure;
    const report = {
        configuration_ready: configurationReady,
        runtime_ready: RUNTIME_READY,
        bundle,
        profile,
        project,
        checks: recorder.checks,
    };
    if (configurationReady)
        return { envelope: envelope('ok', { data: report }), exitCode: 0, report };
    const firstDiagnostic = recorder.diagnostics[0];
    return {
        envelope: envelope('blocked', {
            code: firstDiagnostic?.code ?? CODE_CONFIGURED,
            diagnostics: recorder.diagnostics,
            data: report,
        }),
        exitCode: 1,
        report,
    };
}
