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

/** 适配器诊断（`code`/`detail` 必有，`nextStep` 视分支而定）。 */
export interface ProjectDiagnostic {
  code: string;
  detail: string;
  nextStep?: string;
}

/** `stderr` 里一行 `ERROR: <text>`（fail-fast，只有第一条）。 */
export interface FailureRow {
  kind: string;
  message: string;
  raw?: string;
}

/** 失败分支可能携带的上下文（不同方法的并集；不存在的一律缺席）。 */
export interface ProjectFailure {
  ok: false;
  code: string;
  /** `check` 的失败分支只有 `failures`，没有人读原因的句子，故可缺。 */
  reason?: string;
  nextStep?: string;
  notFound?: boolean;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  stage?: string;
  timedOut?: boolean;
  alreadySealed?: boolean;
  called?: boolean;
  reused?: boolean;
  failures?: FailureRow[];
  diagnostics?: ProjectDiagnostic[];
}

/**
 * 把成功分支的负载字段在失败分支上声明为可选。
 *
 * 失败时这些字段可能缺席，也可能带部分负载（例如 `check` 失败时仍带 `json`/`stderr`）；
 * `ok === true` 之后收窄成必有字段，下游不必到处写非空判断。
 */
export type FailureOf<P extends object> = ProjectFailure & { [K in keyof P]?: P[K] };

/** `probe()` 的一个接入缺口。 */
export interface ProbeGap {
  code: string;
  detail: string;
  nextStep: string;
  blocking: boolean;
}

/** `probe()` 产出的项目接入实况（SEAMS §4 的 `compatibility`）。 */
export interface ProbeCompatibility {
  projectRoot: string;
  indexPresent: boolean;
  configPresent: boolean;
  skillCopyPresent: boolean;
  hasTeamRules: boolean;
  hasToolInventoryRules: boolean;
  pythonOk: boolean;
  projectPyPresent: boolean;
  versions: {
    adapter: number;
    python: string | null;
    pythonExe: string | null;
    pythonSource: string;
    projectPy: string | null;
    schemaVersion: unknown;
  };
  skillCopyPath: string;
  layoutKind: string;
  ruleDigest: string | null;
  scriptDigest: string | null;
  catalogDigest: string | null;
}

/** `probe()` 的负载。 */
export interface ProbePayload {
  compatibility: ProbeCompatibility;
  gaps: ProbeGap[];
}

/** `probe()` 的结果（`ok` 为「没有 blocking 缺口」，不是恒 true）。 */
export type ProbeResult = ({ ok: boolean } & ProbePayload) | FailureOf<ProbePayload>;

/** `seal()` 的负载（一次性封存的三种成功形态共用）。 */
export interface SealPayload {
  alreadySealed: boolean;
  reused: boolean;
  called: boolean;
  /** CLI 没跑起来时（「已封存」竞态分支）没有实际输出，故可缺。 */
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  reason?: string;
}

/** `seal()` 的结果。 */
export type SealResult = ({ ok: true } & SealPayload) | FailureOf<SealPayload>;

/** CLI 阶段（`impact`/`audit-scope`/`check`）的负载。 */
export interface CliStagePayload {
  json: unknown;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** `impact()`/`auditScope()` 的结果。 */
export type CliStageResult = ({ ok: true } & CliStagePayload) | FailureOf<CliStagePayload>;

/** `index()` 的负载（`index` 是文本命令，`json` 恒为 null）。 */
export interface IndexPayload {
  json: null;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/** `index()` 的结果。 */
export type IndexResult = ({ ok: true } & IndexPayload) | FailureOf<IndexPayload>;

/** `check()` 的负载（单行 JSON + 逐条失败）。 */
export interface CheckPayload extends CliStagePayload {
  failures: FailureRow[];
}

/** `check()` 的结果。 */
export type CheckResult = ({ ok: true } & CheckPayload) | FailureOf<CheckPayload>;

/** `readSeals()` 的一条封存。 */
export interface SealRow {
  path: string;
  sha256: string;
  bytes: number;
}

/** `readSeals()` 的负载。 */
export interface SealsPayload {
  seals: SealRow[];
}

/** `readSeals()` 的结果。 */
export type ReadSealsResult = ({ ok: true } & SealsPayload) | FailureOf<SealsPayload>;

/**
 * `readRoute()`/`readRun()` 的结果。
 *
 * 记录内容是 JSON，形状由 skill 定义，本适配器不解释；成功/失败用同一形状表达，
 * 下游一律先判 `ok` 再取 `route`/`run`（与原实现的用法一致）。
 */
export interface RecordReadResult {
  ok: boolean;
  route?: unknown;
  run?: unknown;
  code?: string;
  reason?: string;
  nextStep?: string;
  notFound?: boolean;
  diagnostics?: ProjectDiagnostic[];
}

/** `probe()` 的入参。 */
export interface ProbeInput {
  projectRoot?: unknown;
}

/** `seal()` 的入参。 */
export interface SealInput {
  runId?: unknown;
}

/** `check()` 的入参。 */
export interface CheckInput {
  hashes?: unknown;
  complete?: unknown;
}

/** 解释器探测来源（写进 `compatibility.versions.pythonSource`）。 */
export type PythonSource = 'explicit' | 'project-config' | 'path';

/** 一次解释器探测的结果。 */
export interface ProbedInterpreter {
  exe: string;
  version: string;
  source: string;
}

/** 实际选用的解释器。 */
export interface ResolvedPython {
  exe: string | null;
  version: string | null;
  source: string;
  ok: boolean;
}

/** CLI 产物里记下的解释器身份。 */
export interface PythonIdentity {
  exe: string;
  version: string | null;
  source: string;
}

/** `spawn` 的 options 子集（只声明本适配器真的传的四个键）。 */
export interface SpawnOptionsLike {
  cwd?: string;
  shell?: boolean;
  windowsHide?: boolean;
  env?: Record<string, string | undefined>;
}

/** 子进程的 stdout/stderr 流（只声明用到的两个方法）。 */
export interface SpawnStreamLike {
  setEncoding?: (encoding: BufferEncoding) => unknown;
  on: (event: string, listener: (chunk: unknown) => void) => unknown;
}

/** `child_process.spawn` 的返回值的可用子集。 */
export interface SpawnedChildLike {
  stdout?: SpawnStreamLike | null;
  stderr?: SpawnStreamLike | null;
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
  kill: () => unknown;
}

/** 注入的 `spawn` 形状（测试替身与 `node:child_process.spawn` 共用）。 */
export type SpawnLike = (
  file: string,
  argv: string[],
  options: SpawnOptionsLike,
) => SpawnedChildLike;

/** 一次子进程的原始产物（不判定业务含义）。 */
export interface ProcessOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
  timedOut: boolean;
}

/** `python -B project.py` 的一次运行结果：要么是「跑不了」的失败，要么是原始三件套。 */
export interface CliFailure {
  ok: false;
  code: string;
  reason?: string;
  nextStep?: string;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
}

/** 解释器与脚本都就绪时的运行结果。 */
export interface CliSuccess {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  command: string;
  argv: Array<string | undefined>;
  python: PythonIdentity;
  reason?: string;
  timedOut?: boolean;
  code?: undefined;
  nextStep?: undefined;
}

/** `runCli()` 的结果（用 `code` 区分「跑不了」与「跑了」）。 */
export type CliRun = CliFailure | CliSuccess;

/** `parseJson()` 的结果。 */
export interface ParsedJson {
  parsed: unknown;
  error: string | null;
}

/** `createProjectAdapter()` 的入参（测试注入 + 装配层透传的键都在这里）。 */
export interface ProjectAdapterOptions {
  /** 项目根（必填才能跑 CLI）。 */
  projectRoot?: unknown;
  /** 显式解释器路径（优先于项目配置与 PATH）。 */
  python?: unknown;
  /** 显式 project.py 路径（默认项目副本路径）。 */
  projectPy?: unknown;
  /** 注入 `child_process.spawn` 形状的函数（测试用）。 */
  spawn?: unknown;
  /** 追加/覆盖环境变量。 */
  env?: Record<string, string>;
  /** 单次 CLI 超时（毫秒）。 */
  timeoutMs?: unknown;
  /** 岗位目录路径（默认包内副本 → 仓库 spec）。 */
  catalogPath?: string;
  /** 装配层会一并传下来的上下文；本适配器不解释它们。 */
  config?: unknown;
  ctx?: unknown;
  services?: unknown;
  exec?: unknown;
  deps?: unknown;
}

/** `createProjectAdapter()` 返回的实例（`types.ts` 的 `ProjectAdapter` 就是这个形状）。 */
export interface ProjectAdapterApi {
  contract_version: number;
  CONTRACT_VERSION: number;
  projectRoot: string | undefined;
  probe(input?: ProbeInput): Promise<ProbeResult>;
  seal(input?: SealInput): Promise<SealResult>;
  impact(): Promise<CliStageResult>;
  auditScope(): Promise<CliStageResult>;
  index(): Promise<IndexResult>;
  check(input?: CheckInput): Promise<CheckResult>;
  readRoute(routeId?: unknown): Promise<RecordReadResult>;
  readRun(runId?: unknown): Promise<RecordReadResult>;
  readSeals(): Promise<ReadSealsResult>;
}

function invalid(operation: string, reason: string): ProjectFailure {
  return {
    ok: false,
    code: INVALID_ARGUMENT,
    reason,
    diagnostics: [{ code: INVALID_ARGUMENT, detail: `${operation}: ${reason}` }],
  };
}

function notConfigured(reason: string, extra?: Pick<ProjectFailure, 'nextStep'>): ProjectFailure {
  return {
    ok: false,
    code: PROJECT_NOT_CONFIGURED,
    reason,
    ...extra,
  };
}

function failCheck(
  reason: string,
  extra?: Pick<
    ProjectFailure,
    | 'exitCode'
    | 'stdout'
    | 'stderr'
    | 'stage'
    | 'failures'
    | 'diagnostics'
    | 'alreadySealed'
    | 'called'
    | 'timedOut'
  >,
): ProjectFailure {
  return {
    ok: false,
    code: CHECK_FAILED,
    reason,
    ...extra,
  };
}

/** stderr 里 `ERROR: <text>` 是契约（fail-fast，只有第一条）。 */
function parseFailures(stderr: unknown): FailureRow[] {
  if (typeof stderr !== 'string') return [];
  return stderr
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('ERROR:'))
    .map((line) => ({ kind: 'script', message: line.slice('ERROR:'.length).trim(), raw: line }));
}

function parseJson(text: unknown): ParsedJson {
  if (typeof text !== 'string') return { parsed: null, error: 'no stdout' };
  const trimmed = text.trim();
  if (trimmed.length === 0) return { parsed: null, error: 'empty stdout' };
  try {
    return { parsed: JSON.parse(trimmed), error: null };
  } catch (error) {
    return { parsed: null, error: error instanceof Error ? error.message : String(error) };
  }
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/** 递归列出目录下所有 `.json` 文件（相对路径用 `/`）。 */
async function walkJson(root: string, prefix = ''): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(path.join(root, ...prefix.split('/').filter(Boolean)), { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...await walkJson(root, relative));
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) found.push(relative);
  }
  return found;
}

/** 注入的 `spawn` 是不是函数（测试替身与 `node:child_process.spawn` 都按此收）。 */
function isSpawnLike(value: unknown): value is SpawnLike {
  return typeof value === 'function';
}

/** 安全路径校验的结果：要么锚在项目内的绝对路径，要么一句可直接返回的失败。 */
type SafeRecordPath =
  | { ok: true; target: string }
  | { ok: false; result: ProjectFailure };

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
export function createProjectAdapter(options: ProjectAdapterOptions = {}): ProjectAdapterApi {
  const declaredRoot = typeof options.projectRoot === 'string' && options.projectRoot.length > 0
    ? path.resolve(options.projectRoot)
    : undefined;
  const spawnFn: SpawnLike = isSpawnLike(options.spawn) ? options.spawn : nodeSpawn;
  const declaredTimeout = options.timeoutMs;
  const timeoutMs = typeof declaredTimeout === 'number'
    && Number.isSafeInteger(declaredTimeout)
    && declaredTimeout > 0
    ? declaredTimeout
    : DEFAULT_TIMEOUT_MS;
  const extraEnv: Record<string, string> = {
    PYTHONIOENCODING: 'utf8',
    PYTHONUTF8: '1',
    ...options.env,
  };

  let pythonPromise: Promise<ResolvedPython> | undefined;

  function root(input: unknown): string | undefined {
    return typeof input === 'string' && input.length > 0 ? path.resolve(input) : declaredRoot;
  }

  function projectPyPath(): string | undefined {
    if (typeof options.projectPy === 'string' && options.projectPy.length > 0) {
      return path.resolve(options.projectPy);
    }
    return declaredRoot === undefined ? undefined : path.join(declaredRoot, ...PROJECT_PY_RELATIVE.split('/'));
  }

  /** 跑一次子进程，收集 stdout/stderr/exitCode；不抛。 */
  function runProcess(
    file: string,
    argv: string[],
    runOptions: { cwd?: string; timeout?: number } = {},
  ): Promise<ProcessOutcome> {
    const { cwd, timeout = timeoutMs } = runOptions;
    return new Promise((resolve) => {
      let settled = false;
      let child: SpawnedChildLike;
      try {
        child = spawnFn(file, argv, {
          cwd,
          shell: false,
          windowsHide: true,
          env: { ...process.env, ...extraEnv },
        });
      } catch (error) {
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
        } catch {
          // 已经结束
        }
      }, timeout);
      const finish = (exitCode: number | null, error?: string): void => {
        if (settled) return;
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
  async function probeInterpreter(exe: string, source: string): Promise<ProbedInterpreter | null> {
    const result = await runProcess(exe, ['--version'], { cwd: declaredRoot });
    const matched = String(result.stdout ?? '').match(/Python (\d+\.\d+\.\d+)/u)
      ?? String(result.stderr ?? '').match(/Python (\d+\.\d+\.\d+)/u);
    const version = matched === null ? null : matched[1];
    if (result.exitCode === 0 && version !== null) return { exe, version, source };
    return null;
  }

  /** 从项目配置 markdown 里找真实存在的解释器路径（D8 的 pin 解释器场景）。 */
  async function configPythonCandidate(): Promise<string | null> {
    if (declaredRoot === undefined) return null;
    const config = path.join(declaredRoot, 'docs', 'agents', 'reverse-project-management.md');
    let text: string;
    try {
      text = await readFile(config, 'utf8');
    } catch {
      return null;
    }
    for (const pattern of PYTHON_PATH_PATTERNS) {
      for (const matched of text.matchAll(pattern)) {
        if (existsSync(matched[0])) return matched[0];
      }
    }
    return null;
  }

  /** 解析实际要用的解释器：显式 > 项目配置 pin > PATH 上的 python/python3。 */
  async function resolvePython(): Promise<ResolvedPython> {
    if (pythonPromise !== undefined) return pythonPromise;
    pythonPromise = (async (): Promise<ResolvedPython> => {
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
        if (probed !== null) return { exe: probed.exe, version: probed.version, source: 'path', ok: true };
      }
      return { exe: null, version: null, source: 'unavailable', ok: false };
    })();
    return pythonPromise;
  }

  /**
   * 跑 `python -B <project.py> <argv...>`，返回原始三件套（不判定业务含义）。
   * @param {string[]} argv 子命令及其参数（不含解释器与脚本路径）
   */
  async function runCli(argv: Array<string | undefined>): Promise<CliRun> {
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
    const args = ['-B', projectPy, ...argv] as string[];
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
  function safeRecordPath(
    baseDir: string,
    id: unknown,
    pattern: RegExp,
    label: string,
    projectRoot: string,
  ): SafeRecordPath {
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

  async function readRecord(
    baseDir: string,
    id: unknown,
    pattern: RegExp,
    label: string,
    fileRelative: (target: string) => string,
  ): Promise<RecordReadResult> {
    if (declaredRoot === undefined) return notConfigured('没有 projectRoot，读不到项目记录');
    const safe = safeRecordPath(baseDir, id, pattern, label, declaredRoot);
    if (safe.ok === false) return safe.result;
    const file = fileRelative(safe.target);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
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

  const adapter: ProjectAdapterApi = {
    contract_version: CONTRACT_VERSION,
    CONTRACT_VERSION,
    projectRoot: declaredRoot,

    /** 探测项目侧的可接入性：INDEX、项目配置、skill 副本、团队规则、Python、project.py。 */
    async probe(input: ProbeInput = {}): Promise<ProbeResult> {
      const projectRoot = root(input.projectRoot);
      if (projectRoot === undefined) return invalid('probe', 'probe 需要 projectRoot');
      const gaps: ProbeGap[] = [];
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
        if (!gaps.some((existing) => existing.code === gap.code)) gaps.push({ ...gap, blocking: false });
      }

      let schemaVersion: unknown = null;
      try {
        const projectRecord: unknown = JSON.parse(await readFile(path.join(projectRoot, 're', 'project.json'), 'utf8'));
        schemaVersion = isRecord(projectRecord) ? (projectRecord.schema_version ?? null) : null;
      } catch {
        schemaVersion = null;
      }

      const compatibility: ProbeCompatibility = {
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
    async seal(input: SealInput = {}): Promise<SealResult> {
      if (declaredRoot === undefined) return notConfigured('没有 projectRoot，跑不了 seal');
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
    async impact(): Promise<CliStageResult> {
      const result = await runCli(['impact', declaredRoot]);
      if (typeof result.code === 'string') return result;
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
    async auditScope(): Promise<CliStageResult> {
      const result = await runCli(['audit-scope', declaredRoot]);
      if (typeof result.code === 'string') return result;
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
    async index(): Promise<IndexResult> {
      const result = await runCli(['index', declaredRoot]);
      if (typeof result.code === 'string') return result;
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
    async check(input: CheckInput = {}): Promise<CheckResult> {
      const argv: Array<string | undefined> = ['check', declaredRoot];
      if (input.hashes === true) argv.push('--hashes');
      if (input.complete === true) argv.push('--complete');
      const result = await runCli(argv);
      if (typeof result.code === 'string') return result;
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
    async readRoute(routeId?: unknown): Promise<RecordReadResult> {
      return readRecord('re/routes', routeId, ROUTE_ID, 'Route', (target) => `${target}.json`);
    },

    /** 直接读 `re/runs/<id>/run.json`。 */
    async readRun(runId?: unknown): Promise<RecordReadResult> {
      return readRecord('re/runs', runId, RUN_ID, 'Run', (target) => path.join(target, 'run.json'));
    },

    /** 直接枚举 `re/seals/**`（目标基线与执行基线）。 */
    async readSeals(): Promise<ReadSealsResult> {
      if (declaredRoot === undefined) return notConfigured('没有 projectRoot，读不到 re/seals');
      const sealsDir = path.join(declaredRoot, 're', 'seals');
      const relatives = await walkJson(sealsDir);
      const seals: SealRow[] = [];
      for (const relative of relatives.sort()) {
        const file = path.join(sealsDir, ...relative.split('/'));
        try {
          const bytes = await readFile(file);
          seals.push({
            path: `re/seals/${relative}`,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            bytes: bytes.length,
          });
        } catch {
          // 读不到就不列：调用方能看到缺项
        }
      }
      return { ok: true, seals };
    },
  };

  return adapter;
}
