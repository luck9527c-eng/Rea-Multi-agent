/**
 * 项目管理 adapter（SEAMS 第 4 节）：跑项目副本里的 `project.py`，并直接读写 skill 约定的
 * 记录文件。
 *
 * 硬事实（E3 笔记，实现必须照做）：
 *
 * - 只有 7 个子命令：`init | index | check | impact | audit-scope | probe | seal`；**没有**
 *   `--json`，可解析的只有 `check`（单行 JSON）、`impact`（pretty JSON）、`audit-scope`（pretty JSON），
 *   `index`/`seal` 是文本。
 * - 退出码 `0` 成功、`1` 校验/IO 错误（stderr 一条 `ERROR: …`）、`2` argparse 用法错误；
 *   失败是 fail-fast，只报第一条，所以诊断要保留 stderr 原文。
 * - 脚本必须从**项目副本**调用：`<root>/.agents/skills/reverse-project-management/scripts/project.py`，
 *   并用 `python -B`（不写 `__pycache__`）。`project.py` 是扁平 import，不能只拷单文件。
 * - 参数以**数组**交给 `child_process.spawn`，`shell:false`，绝不拼 shell 字符串。
 * - 写文件只有 `init/index/seal/probe --output`；`routes/runs/conditions/project.json` 由本插件
 *   直接读写、CLI 只校验，所以 `readRoute/readRun/readSeals` 直接读文件。
 * - `seal` 一次性：`re/seals/runs/<RUN>.json` 已存在时**不调用** CLI，直接返回 `alreadySealed`；
 *   退出码 1 时要区分「拒绝覆盖已封存（可复用）」与真失败。
 *
 * 所有方法永不 reject：脚本失败一律 `{ok:false, code, exitCode, stdout, stderr, ...}`。
 *
 * 类型约定：CLI 的入参/产物、`spawn` 的注入替身、`re/routes|runs/**` 的 JSON 内容全部按
 * `unknown` 收；本模块只在**自己真正解释**的地方收窄（`guards.recordOf` / `guards.isRecord`）。
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { CONTRACT_VERSION, SKILL_COPY_RELATIVE, computeDigests } from './compatibility.js';
import { isRecord, thrownCode } from './guards.js';
const CHECK_FAILED = 'CHECK_FAILED';
const PROJECT_NOT_CONFIGURED = 'PROJECT_NOT_CONFIGURED';
const INVALID_ARGUMENT = 'INVALID_ARGUMENT';
const RECOVERY_REQUIRED = 'RECOVERY_REQUIRED';
const DEFAULT_TIMEOUT_MS = 120000;
const ROUTE_ID = /^R-[A-Za-z0-9_-]+$/u;
const RUN_ID = /^RUN-[A-Za-z0-9_-]+$/u;
/** `python -B <project.py>` 的固定前缀里，脚本相对路径。 */
const PROJECT_PY_RELATIVE = `${SKILL_COPY_RELATIVE}/scripts/project.py`;
/** 项目配置（Markdown）里 pin 解释器的启发式匹配；只在文件真实存在时才采用。 */
const PYTHON_PATH_PATTERNS = [
    /[A-Za-z]:[\\/][^\s`"'<>|*?]*python(?:\.exe)?/giu,
    /\/(?:[^\s`"'<>|*?]+\/)*python(?:\d+(?:\.\d+)?)?/gu,
];
function invalid(operation, reason) {
    return {
        ok: false,
        code: INVALID_ARGUMENT,
        reason,
        diagnostics: [{ code: INVALID_ARGUMENT, detail: `${operation}: ${reason}` }],
    };
}
function notConfigured(reason, extra) {
    return {
        ok: false,
        code: PROJECT_NOT_CONFIGURED,
        reason,
        ...extra,
    };
}
function failCheck(reason, extra) {
    return {
        ok: false,
        code: CHECK_FAILED,
        reason,
        ...extra,
    };
}
/** stderr 里 `ERROR: <text>` 是契约（fail-fast，只有第一条）。 */
function parseFailures(stderr) {
    if (typeof stderr !== 'string')
        return [];
    return stderr
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.startsWith('ERROR:'))
        .map((line) => ({ kind: 'script', message: line.slice('ERROR:'.length).trim(), raw: line }));
}
function parseJson(text) {
    if (typeof text !== 'string')
        return { parsed: null, error: 'no stdout' };
    const trimmed = text.trim();
    if (trimmed.length === 0)
        return { parsed: null, error: 'empty stdout' };
    try {
        return { parsed: JSON.parse(trimmed), error: null };
    }
    catch (error) {
        return { parsed: null, error: error instanceof Error ? error.message : String(error) };
    }
}
async function isFile(target) {
    try {
        return (await stat(target)).isFile();
    }
    catch {
        return false;
    }
}
async function isDirectory(target) {
    try {
        return (await stat(target)).isDirectory();
    }
    catch {
        return false;
    }
}
/** 递归列出目录下所有 `.json` 文件（相对路径用 `/`）。 */
async function walkJson(root, prefix = '') {
    let entries;
    try {
        entries = await readdir(path.join(root, ...prefix.split('/').filter(Boolean)), { withFileTypes: true });
    }
    catch {
        return [];
    }
    const found = [];
    for (const entry of entries) {
        const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) {
            found.push(...await walkJson(root, relative));
            continue;
        }
        if (entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
            found.push(relative);
    }
    return found;
}
/** 注入的 `spawn` 是不是函数（测试替身与 `node:child_process.spawn` 都按此收）。 */
function isSpawnLike(value) {
    return typeof value === 'function';
}
/**
 * 建一个 projectAdapter。
 *
 * @param {object} [options]
 * @param {string} [options.projectRoot] 项目根（必填才能跑 CLI）
 * @param {string} [options.python] 显式解释器路径（优先于项目配置与 PATH）
 * @param {string} [options.projectPy] 显式 project.py 路径（默认项目副本路径）
 * @param {Function} [options.spawn] 注入 `child_process.spawn` 形状的函数（测试用）
 * @param {Record<string, string>} [options.env] 追加/覆盖环境变量
 * @param {number} [options.timeoutMs] 单次 CLI 超时（毫秒）
 * @param {string} [options.catalogPath] 岗位目录路径（默认包内副本 → 仓库 spec）
 */
export function createProjectAdapter(options = {}) {
    const declaredRoot = typeof options.projectRoot === 'string' && options.projectRoot.length > 0
        ? path.resolve(options.projectRoot)
        : undefined;
    const spawnFn = isSpawnLike(options.spawn) ? options.spawn : nodeSpawn;
    const declaredTimeout = options.timeoutMs;
    const timeoutMs = typeof declaredTimeout === 'number'
        && Number.isSafeInteger(declaredTimeout)
        && declaredTimeout > 0
        ? declaredTimeout
        : DEFAULT_TIMEOUT_MS;
    const extraEnv = {
        PYTHONIOENCODING: 'utf8',
        PYTHONUTF8: '1',
        ...options.env,
    };
    let pythonPromise;
    function root(input) {
        return typeof input === 'string' && input.length > 0 ? path.resolve(input) : declaredRoot;
    }
    function projectPyPath() {
        if (typeof options.projectPy === 'string' && options.projectPy.length > 0) {
            return path.resolve(options.projectPy);
        }
        return declaredRoot === undefined ? undefined : path.join(declaredRoot, ...PROJECT_PY_RELATIVE.split('/'));
    }
    /** 跑一次子进程，收集 stdout/stderr/exitCode；不抛。 */
    function runProcess(file, argv, runOptions = {}) {
        const { cwd, timeout = timeoutMs } = runOptions;
        return new Promise((resolve) => {
            let settled = false;
            let child;
            try {
                child = spawnFn(file, argv, {
                    cwd,
                    shell: false,
                    windowsHide: true,
                    env: { ...process.env, ...extraEnv },
                });
            }
            catch (error) {
                resolve({
                    exitCode: null,
                    stdout: '',
                    stderr: '',
                    error: error instanceof Error ? error.message : String(error),
                    timedOut: false,
                });
                return;
            }
            let stdout = '';
            let stderr = '';
            let timedOut = false;
            const timer = setTimeout(() => {
                timedOut = true;
                try {
                    child.kill();
                }
                catch {
                    // 已经结束
                }
            }, timeout);
            const finish = (exitCode, error) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                resolve({
                    exitCode,
                    stdout,
                    stderr,
                    ...(error === undefined ? {} : { error }),
                    timedOut,
                });
            };
            child.stdout?.setEncoding?.('utf8');
            child.stderr?.setEncoding?.('utf8');
            child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
            child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
            child.on('error', (error) => finish(null, error instanceof Error ? error.message : String(error)));
            child.on('close', (code) => finish(typeof code === 'number' ? code : null));
        });
    }
    /** 探测候选解释器的版本；返回 `{exe, version, source}` 或 null。 */
    async function probeInterpreter(exe, source) {
        const result = await runProcess(exe, ['--version'], { cwd: declaredRoot });
        const matched = String(result.stdout ?? '').match(/Python (\d+\.\d+\.\d+)/u)
            ?? String(result.stderr ?? '').match(/Python (\d+\.\d+\.\d+)/u);
        const version = matched === null ? null : matched[1];
        if (result.exitCode === 0 && version !== null)
            return { exe, version, source };
        return null;
    }
    /** 从项目配置 markdown 里找真实存在的解释器路径（D8 的 pin 解释器场景）。 */
    async function configPythonCandidate() {
        if (declaredRoot === undefined)
            return null;
        const config = path.join(declaredRoot, 'docs', 'agents', 'reverse-project-management.md');
        let text;
        try {
            text = await readFile(config, 'utf8');
        }
        catch {
            return null;
        }
        for (const pattern of PYTHON_PATH_PATTERNS) {
            for (const matched of text.matchAll(pattern)) {
                if (existsSync(matched[0]))
                    return matched[0];
            }
        }
        return null;
    }
    /** 解析实际要用的解释器：显式 > 项目配置 pin > PATH 上的 python/python3。 */
    async function resolvePython() {
        if (pythonPromise !== undefined)
            return pythonPromise;
        pythonPromise = (async () => {
            if (typeof options.python === 'string' && options.python.length > 0) {
                const probed = await probeInterpreter(options.python, 'explicit');
                return {
                    exe: options.python,
                    version: probed?.version ?? null,
                    source: 'explicit',
                    ok: probed !== null,
                };
            }
            const pinned = await configPythonCandidate();
            if (pinned !== null) {
                const probed = await probeInterpreter(pinned, 'project-config');
                return { exe: pinned, version: probed?.version ?? null, source: 'project-config', ok: probed !== null };
            }
            for (const candidate of ['python', 'python3']) {
                const probed = await probeInterpreter(candidate, 'path');
                if (probed !== null)
                    return { exe: probed.exe, version: probed.version, source: 'path', ok: true };
            }
            return { exe: null, version: null, source: 'unavailable', ok: false };
        })();
        return pythonPromise;
    }
    /**
     * 跑 `python -B <project.py> <argv...>`，返回原始三件套（不判定业务含义）。
     * @param {string[]} argv 子命令及其参数（不含解释器与脚本路径）
     */
    async function runCli(argv) {
        if (declaredRoot === undefined) {
            return notConfigured('没有 projectRoot，跑不了项目 skill CLI');
        }
        const projectPy = projectPyPath();
        if (projectPy === undefined || !existsSync(projectPy)) {
            return notConfigured(`项目里没有 skill 副本脚本 ${PROJECT_PY_RELATIVE}`, {
                nextStep: '先按 skill 的 init 建项目副本，或按团队规则把副本合并进项目；不要用全局副本跑项目（D8）',
            });
        }
        const python = await resolvePython();
        if (python.exe === null) {
            return notConfigured('找不到可用的 python 解释器（PATH 上没有 python/python3）', {
                nextStep: '在项目配置里登记解释器路径，或在 profile/环境里提供 python；不要假设某个固定路径',
            });
        }
        // 不变式：上面已确认 `declaredRoot` 存在，而 argv 里唯一可能缺席的元素就是调用方传的
        // `declaredRoot`；argv 只在「没有 projectRoot」时才是 undefined，那条路径已经早返回。
        const args = ['-B', projectPy, ...argv];
        const result = await runProcess(python.exe, args, { cwd: declaredRoot });
        return {
            ok: result.exitCode === 0,
            exitCode: result.exitCode,
            stdout: result.stdout ?? '',
            stderr: result.stderr ?? '',
            command: 'python -B project.py',
            argv,
            python: { exe: python.exe, version: python.version, source: python.source },
            ...(result.error === undefined ? {} : { reason: result.error }),
            ...(result.timedOut === true ? { timedOut: true } : {}),
        };
    }
    /** 校验 ID 并把它锚在项目目录里（防 `..` 逃逸）。 */
    function safeRecordPath(baseDir, id, pattern, label, projectRoot) {
        if (typeof id !== 'string' || !pattern.test(id)) {
            return { ok: false, result: invalid(`read${label}`, `${label} 标识不合法：${JSON.stringify(id)}`) };
        }
        const base = path.join(projectRoot, ...baseDir.split('/'));
        const target = path.resolve(base, id);
        const relative = path.relative(base, target);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            return { ok: false, result: invalid(`read${label}`, `${label} 标识越出项目目录：${id}`) };
        }
        return { ok: true, target };
    }
    async function readRecord(baseDir, id, pattern, label, fileRelative) {
        if (declaredRoot === undefined)
            return notConfigured('没有 projectRoot，读不到项目记录');
        const safe = safeRecordPath(baseDir, id, pattern, label, declaredRoot);
        if (safe.ok === false)
            return safe.result;
        const file = fileRelative(safe.target);
        let text;
        try {
            text = await readFile(file, 'utf8');
        }
        catch (error) {
            const missing = thrownCode(error) === 'ENOENT';
            return {
                ok: false,
                code: PROJECT_NOT_CONFIGURED,
                notFound: missing,
                reason: missing
                    ? `${label} ${id} not found at ${path.relative(declaredRoot, file).split(path.sep).join('/')}`
                    : `读不了 ${label} ${id}: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
        const { parsed, error } = parseJson(text);
        if (parsed === null) {
            return {
                ok: false,
                code: RECOVERY_REQUIRED,
                reason: `${label} ${id} 的 JSON 解析失败：${error}`,
                diagnostics: [{ code: RECOVERY_REQUIRED, detail: '记录文件损坏，需要人工核对/恢复；不要当作「没有这条记录」' }],
            };
        }
        return { ok: true, [label === 'Route' ? 'route' : 'run']: parsed };
    }
    const adapter = {
        contract_version: CONTRACT_VERSION,
        CONTRACT_VERSION,
        projectRoot: declaredRoot,
        /** 探测项目侧的可接入性：INDEX、项目配置、skill 副本、团队规则、Python、project.py。 */
        async probe(input = {}) {
            const projectRoot = root(input.projectRoot);
            if (projectRoot === undefined)
                return invalid('probe', 'probe 需要 projectRoot');
            const gaps = [];
            const skillCopy = path.join(projectRoot, ...SKILL_COPY_RELATIVE.split('/'));
            const indexPresent = await isFile(path.join(projectRoot, 'INDEX.md'));
            if (!indexPresent) {
                gaps.push({
                    code: 'PROJECT_INDEX_MISSING',
                    blocking: true,
                    detail: '项目根没有 INDEX.md',
                    nextStep: '用项目 skill 的 init 建 INDEX.md，或确认传的是分析项目根而不是父目录',
                });
            }
            const configPresent = await isFile(path.join(projectRoot, 'docs', 'agents', 'reverse-project-management.md'));
            if (!configPresent) {
                gaps.push({
                    code: 'PROJECT_CONFIG_MISSING',
                    blocking: true,
                    detail: '缺少 docs/agents/reverse-project-management.md（项目仓库配置）',
                    nextStep: '按 skill 的模板建立项目配置；已有项目要局部合并，不要重新 init 覆盖历史（D8）',
                });
            }
            const skillCopyPresent = await isDirectory(skillCopy);
            if (!skillCopyPresent) {
                gaps.push({
                    code: 'SKILL_COPY_MISSING',
                    blocking: true,
                    detail: `缺少项目内 skill 副本 ${SKILL_COPY_RELATIVE}`,
                    nextStep: '按团队规则把项目副本合并进项目；不要用全局副本覆盖或代替项目副本（D8）',
                });
            }
            const hasTeamRules = skillCopyPresent
                && await isFile(path.join(skillCopy, 'references', 'team-coordination.md'));
            if (!hasTeamRules) {
                gaps.push({
                    code: 'TEAM_RULES_MISSING',
                    blocking: true,
                    detail: '项目副本缺少 references/team-coordination.md（团队规则段）',
                    nextStep: '按 skill 的团队规则合并项目副本（保留历史），不要用全局副本覆盖；合并前不要 bind 团队模式（D8）',
                });
            }
            const hasToolInventoryRules = skillCopyPresent
                && await isFile(path.join(skillCopy, 'references', 'tool-inventory.md'));
            if (!hasToolInventoryRules) {
                gaps.push({
                    code: 'TOOL_INVENTORY_RULES_MISSING',
                    blocking: false,
                    detail: '项目副本缺少 references/tool-inventory.md（工具清单规则）',
                    nextStep: '只有需要消费 re/env/tools.json 时才合并这份规则；工具清单本身可能根本不存在（D11），不得自己生成',
                });
            }
            const projectPy = projectPyPath();
            const projectPyPresent = projectPy !== undefined && await isFile(projectPy);
            if (!projectPyPresent) {
                gaps.push({
                    code: 'PROJECT_SCRIPT_MISSING',
                    blocking: true,
                    detail: `缺少 ${PROJECT_PY_RELATIVE}`,
                    nextStep: '按 skill 的 init 建项目副本（project.py 需要 governance/impact/integrity 三个 sibling 一起），不要只拷单文件',
                });
            }
            const python = await resolvePython();
            if (python.ok !== true) {
                gaps.push({
                    code: 'PYTHON_MISSING',
                    blocking: true,
                    detail: python.exe === null
                        ? 'PATH 上找不到可用的 python/python3'
                        : `解释器 ${python.exe} 没有可用的 --version 输出`,
                    nextStep: '在项目配置里登记可用的解释器路径（本机存在多个版本时必须记清用了哪个），或在环境里提供 python',
                });
            }
            const digests = await computeDigests({ projectRoot, catalogPath: options.catalogPath });
            for (const gap of digests.gaps) {
                if (!gaps.some((existing) => existing.code === gap.code))
                    gaps.push({ ...gap, blocking: false });
            }
            let schemaVersion = null;
            try {
                const projectRecord = JSON.parse(await readFile(path.join(projectRoot, 're', 'project.json'), 'utf8'));
                schemaVersion = isRecord(projectRecord) ? (projectRecord.schema_version ?? null) : null;
            }
            catch {
                schemaVersion = null;
            }
            const compatibility = {
                projectRoot,
                indexPresent,
                configPresent,
                skillCopyPresent,
                hasTeamRules,
                hasToolInventoryRules,
                pythonOk: python.ok === true,
                projectPyPresent,
                versions: {
                    adapter: CONTRACT_VERSION,
                    python: python.version,
                    pythonExe: python.exe,
                    pythonSource: python.source,
                    projectPy: projectPy === undefined ? null : projectPy,
                    schemaVersion,
                },
                skillCopyPath: SKILL_COPY_RELATIVE,
                layoutKind: 'default',
                ruleDigest: digests.ruleDigest,
                scriptDigest: digests.scriptDigest,
                catalogDigest: digests.catalogDigest,
            };
            return {
                ok: gaps.every((gap) => gap.blocking !== true),
                compatibility,
                gaps,
            };
        },
        /** 一次性封存：已有 seal 文件时不调用 CLI；退出码 1 时区分「已封存」与真失败。 */
        async seal(input = {}) {
            if (declaredRoot === undefined)
                return notConfigured('没有 projectRoot，跑不了 seal');
            const runId = input.runId;
            if (typeof runId !== 'string' || !RUN_ID.test(runId)) {
                return invalid('seal', `RUN 标识不合法：${JSON.stringify(runId)}`);
            }
            const sealPath = path.join(declaredRoot, 're', 'seals', 'runs', `${runId}.json`);
            if (await isFile(sealPath)) {
                return {
                    ok: true,
                    alreadySealed: true,
                    reused: true,
                    called: false,
                    stdout: '',
                    stderr: '',
                    exitCode: 0,
                    reason: `已有封存 ${['re', 'seals', 'runs', `${runId}.json`].join('/')}，只校验复用，不重封存`,
                };
            }
            const result = await runCli(['seal', declaredRoot, runId]);
            if (result.ok === true && result.exitCode === 0) {
                return {
                    ok: true,
                    alreadySealed: false,
                    reused: false,
                    called: true,
                    stdout: result.stdout,
                    stderr: result.stderr,
                    exitCode: result.exitCode,
                };
            }
            if (typeof result.stderr === 'string' && /refusing to overwrite sealed execution/iu.test(result.stderr)) {
                // 竞态：宿主在检查与调用之间已有别人封存。这是「已封存可复用」，不是失败。
                return {
                    ok: true,
                    alreadySealed: true,
                    reused: true,
                    called: true,
                    stdout: result.stdout,
                    stderr: result.stderr,
                    exitCode: result.exitCode,
                };
            }
            return failCheck('seal 失败（skill 逐条校验项目后拒绝封存）', {
                alreadySealed: false,
                called: true,
                stdout: result.stdout,
                stderr: result.stderr,
                exitCode: result.exitCode,
                stage: 'seal',
                ...(result.reason === undefined ? {} : { diagnostics: [{ code: CHECK_FAILED, detail: result.reason }] }),
            });
        },
        /** `impact`：纯派生，pretty JSON。 */
        async impact() {
            const result = await runCli(['impact', declaredRoot]);
            if (typeof result.code === 'string')
                return result;
            if (result.ok !== true) {
                return failCheck('impact 失败', {
                    exitCode: result.exitCode,
                    stdout: result.stdout,
                    stderr: result.stderr,
                    stage: 'impact',
                    failures: parseFailures(result.stderr),
                });
            }
            const { parsed, error } = parseJson(result.stdout);
            if (parsed === null) {
                return failCheck(`impact 的输出不是 JSON：${error}`, {
                    exitCode: result.exitCode,
                    stdout: result.stdout,
                    stderr: result.stderr,
                    stage: 'impact',
                });
            }
            return { ok: true, json: parsed, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
        },
        /** `audit-scope`：纯派生，pretty JSON。 */
        async auditScope() {
            const result = await runCli(['audit-scope', declaredRoot]);
            if (typeof result.code === 'string')
                return result;
            if (result.ok !== true) {
                return failCheck('audit-scope 失败', {
                    exitCode: result.exitCode,
                    stdout: result.stdout,
                    stderr: result.stderr,
                    stage: 'audit-scope',
                    failures: parseFailures(result.stderr),
                });
            }
            const { parsed, error } = parseJson(result.stdout);
            if (parsed === null) {
                return failCheck(`audit-scope 的输出不是 JSON：${error}`, {
                    exitCode: result.exitCode,
                    stdout: result.stdout,
                    stderr: result.stderr,
                    stage: 'audit-scope',
                });
            }
            return { ok: true, json: parsed, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
        },
        /** `index`：文本输出，只当诊断；失败保留 stderr。 */
        async index() {
            const result = await runCli(['index', declaredRoot]);
            if (typeof result.code === 'string')
                return result;
            if (result.ok !== true) {
                return failCheck('index 失败', {
                    exitCode: result.exitCode,
                    stdout: result.stdout,
                    stderr: result.stderr,
                    stage: 'index',
                    failures: parseFailures(result.stderr),
                });
            }
            return {
                ok: true,
                json: null,
                stdout: result.stdout,
                stderr: result.stderr,
                exitCode: result.exitCode,
            };
        },
        /**
         * `check [--hashes] [--complete]`：单行 JSON。
         * @param {{hashes?: boolean, complete?: boolean}} input
         */
        async check(input = {}) {
            const argv = ['check', declaredRoot];
            if (input.hashes === true)
                argv.push('--hashes');
            if (input.complete === true)
                argv.push('--complete');
            const result = await runCli(argv);
            if (typeof result.code === 'string')
                return result;
            const { parsed, error } = parseJson(result.stdout);
            if (result.ok !== true) {
                return {
                    ok: false,
                    code: CHECK_FAILED,
                    exitCode: result.exitCode,
                    stdout: result.stdout,
                    stderr: result.stderr,
                    json: parsed,
                    failures: parseFailures(result.stderr),
                    stage: 'check',
                };
            }
            if (parsed === null) {
                return {
                    ok: false,
                    code: CHECK_FAILED,
                    exitCode: result.exitCode,
                    stdout: result.stdout,
                    stderr: result.stderr,
                    json: null,
                    failures: [{ kind: 'invalid-json', message: `check 的输出不是 JSON：${error}` }],
                    stage: 'check',
                };
            }
            return {
                ok: true,
                json: parsed,
                exitCode: result.exitCode,
                stdout: result.stdout,
                stderr: result.stderr,
                failures: [],
            };
        },
        /** 直接读 `re/routes/<id>.json`（CLI 只校验，不提供读命令）。 */
        async readRoute(routeId) {
            return readRecord('re/routes', routeId, ROUTE_ID, 'Route', (target) => `${target}.json`);
        },
        /** 直接读 `re/runs/<id>/run.json`。 */
        async readRun(runId) {
            return readRecord('re/runs', runId, RUN_ID, 'Run', (target) => path.join(target, 'run.json'));
        },
        /** 直接枚举 `re/seals/**`（目标基线与执行基线）。 */
        async readSeals() {
            if (declaredRoot === undefined)
                return notConfigured('没有 projectRoot，读不到 re/seals');
            const sealsDir = path.join(declaredRoot, 're', 'seals');
            const relatives = await walkJson(sealsDir);
            const seals = [];
            for (const relative of relatives.sort()) {
                const file = path.join(sealsDir, ...relative.split('/'));
                try {
                    const bytes = await readFile(file);
                    seals.push({
                        path: `re/seals/${relative}`,
                        sha256: createHash('sha256').update(bytes).digest('hex'),
                        bytes: bytes.length,
                    });
                }
                catch {
                    // 读不到就不列：调用方能看到缺项
                }
            }
            return { ok: true, seals };
        },
    };
    return adapter;
}
