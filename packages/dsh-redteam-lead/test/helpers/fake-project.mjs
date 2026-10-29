/**
 * 项目管理 adapter 的替身（SEAMS 第 4 节）。
 *
 * 它实现的是**本包 `projectAdapter` 的接口**（不是 `project.py` CLI），所以 T5/T6/T7 可以
 * 在没有 Python 的机器上把编排决策测完。每个子命令都可注入 `{exitCode, stdout, stderr,
 * delayMs}`，并可断言调用顺序。
 *
 * ```js
 * const project = createFakeProject({
 *   projectRoot: 'C:/proj',
 *   responses: { check: { exitCode: 1, stderr: 'ERROR: INDEX navigation stale; run index' } },
 *   routes: { 'R-001': { schema_version: 1, id: 'R-001', status: 'active' } },
 *   runs: { 'RUN-1': { schema_version: 1, id: 'RUN-1' } },
 *   seals: [{ path: 're/seals/runs/RUN-1.json', sha256: '…', bytes: 160 }],
 *   compatibility: { projectRoot: 'C:/proj', indexPresent: true, … },
 *   gaps: [],
 * })
 *
 * project.seal / probe / impact / index / check / auditScope / readRoute / readRun / readSeals
 * project.calls            // [{command, args, argv, at}]
 * project.callsFor(cmd)    // 过滤
 * project.order()          // 已发生命令的顺序（只含 CLI 子命令与文件读取）
 * project.queue(cmd, resp) // 追加一次性应答（FIFO），用于「第一次失败、第二次成功」
 * project.reset()          // 清空调用流水与一次性队列
 * ```
 *
 * 应答可以是对象、函数 `(args) => response`，或 `project.queue` 压入的一次性对象。
 * `responses` 缺省时给出与真实 CLI 一致的**成功**输出形状（`check` 单行 JSON、
 * `impact`/`audit-scope` pretty JSON、`index`/`seal` 文本），这样下游测试只在需要时注入失败。
 */

const DEFAULT_GAPS = [];

function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

function prettyJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function defaultResponse(command, args, fixture) {
  switch (command) {
    case 'check':
      return {
        exitCode: 0,
        stderr: '',
        stdout: jsonLine({
          targets: 1,
          routes: 1,
          runs: 1,
          conditions: 0,
          pending_reviews: 0,
          hashes_verified: args?.hashes === true,
          audit_pending: false,
          open_disputes: 0,
          recovery_pending: 0,
          dispute_impacts: 0,
          completion_checked: args?.complete === true,
        }),
      };
    case 'impact':
      return {
        exitCode: 0,
        stderr: '',
        stdout: prettyJson({ pending_reviews: [], dispute_impacts: [] }),
      };
    case 'audit-scope':
      return { exitCode: 0, stderr: '', stdout: prettyJson({ snapshot: {} }) };
    case 'index':
      return {
        exitCode: 0,
        stderr: '',
        stdout: `Index refreshed: ${fixture.projectRoot}/INDEX.md\n`,
      };
    case 'seal':
      return {
        exitCode: 0,
        stderr: '',
        stdout: `Sealed ${args?.runId}; preserve re/seals in reviewed version control; refresh INDEX.\n`,
      };
    case 'probe':
      return {
        exitCode: 0,
        stderr: '',
        stdout: prettyJson(fixture.compatibility ?? {
          projectRoot: fixture.projectRoot,
          indexPresent: true,
          configPresent: true,
          skillCopyPresent: true,
          hasTeamRules: true,
          pythonOk: true,
          versions: { python: '3.12.14', adapter: 1 },
          ruleDigest: 'r'.repeat(64),
          scriptDigest: 's'.repeat(64),
          catalogDigest: 'c'.repeat(64),
        }),
      };
    default:
      return { exitCode: 0, stderr: '', stdout: '' };
  }
}

/**
 * 建一个项目管理 adapter 替身。
 * @param {object} [options] 见文件头。
 */
export function createFakeProject(options = {}) {
  const projectRoot = options.projectRoot ?? '/fake-project';
  const responses = options.responses ?? {};
  const queues = new Map();
  const calls = [];
  let clock = typeof options.clock === 'function' ? options.clock : () => Date.now();
  const fixture = {
    projectRoot,
    compatibility: options.compatibility,
  };

  function record(command, args, argv) {
    const call = { command, args, argv, at: clock() };
    calls.push(call);
    return call;
  }

  async function delay(ms) {
    if (typeof ms === 'number' && ms > 0) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
  }

  async function invoke(command, args, argv) {
    record(command, args, argv);
    const queue = queues.get(command);
    const queued = queue !== undefined && queue.length > 0 ? queue.shift() : undefined;
    const source = queued ?? responses[command];
    const response = typeof source === 'function'
      ? source(args, { projectRoot, call: argv })
      : source;
    const resolved = response ?? defaultResponse(command, args, fixture);
    await delay(resolved.delayMs ?? options.delayMs);
    return resolved;
  }

  const adapter = {
    // ---- 调用流水 -----------------------------------------------------------
    calls,
    callsFor(command) {
      return calls.filter((call) => call.command === command);
    },
    order() {
      return calls.map((call) => call.command);
    },
    queue(command, response) {
      if (!queues.has(command)) queues.set(command, []);
      queues.get(command).push(response);
      return adapter;
    },
    reset() {
      calls.length = 0;
      queues.clear();
      return adapter;
    },
    set clock(fn) {
      clock = fn;
    },

    // ---- 项目 skill CLI -----------------------------------------------------
    /** 探测项目兼容性（真实实现在 project-adapter，这里只回放注入结果）。 */
    async probe({ projectRoot: root } = {}) {
      const call = await invoke('probe', { projectRoot: root ?? projectRoot }, ['probe']);
      const parsed = safeJson(call.stdout);
      return {
        ok: call.exitCode === 0,
        ...(call.exitCode === 0
          ? { compatibility: parsed ?? fixture.compatibility, gaps: options.gaps ?? DEFAULT_GAPS }
          : { code: 'PROJECT_NOT_CONFIGURED', exitCode: call.exitCode, stdout: call.stdout, stderr: call.stderr }),
        stdout: call.stdout,
        stderr: call.stderr,
        exitCode: call.exitCode,
      };
    },

    /** 一次性封存；`alreadySealed` 由注入应答的 `alreadySealed` 决定。 */
    async seal({ runId } = {}) {
      const call = await invoke('seal', { runId }, ['seal', projectRoot, runId]);
      return {
        ok: call.exitCode === 0,
        alreadySealed: call.alreadySealed === true,
        reused: call.reused === true,
        stdout: call.stdout,
        stderr: call.stderr,
        exitCode: call.exitCode,
        ...(call.exitCode === 0 ? {} : { code: call.code ?? 'CHECK_FAILED' }),
      };
    },

    async impact() {
      const call = await invoke('impact', {}, ['impact', projectRoot]);
      return cliJsonResult(call, ['impact']);
    },

    async auditScope() {
      const call = await invoke('audit-scope', {}, ['audit-scope', projectRoot]);
      return cliJsonResult(call, ['audit-scope']);
    },

    async index() {
      const call = await invoke('index', {}, ['index', projectRoot]);
      return {
        ok: call.exitCode === 0,
        json: null,
        stdout: call.stdout,
        stderr: call.stderr,
        exitCode: call.exitCode,
        ...(call.exitCode === 0 ? {} : { code: call.code ?? 'CHECK_FAILED' }),
      };
    },

    async check({ hashes = false, complete = false } = {}) {
      const argv = ['check', projectRoot];
      if (hashes) argv.push('--hashes');
      if (complete) argv.push('--complete');
      const call = await invoke('check', { hashes, complete }, argv);
      if (call.exitCode !== 0) {
        return {
          ok: false,
          code: call.code ?? 'CHECK_FAILED',
          exitCode: call.exitCode,
          stdout: call.stdout,
          stderr: call.stderr,
          failures: call.failures ?? parseFailures(call.stderr),
          json: safeJson(call.stdout),
        };
      }
      const parsed = safeJson(call.stdout);
      if (parsed === null) {
        return {
          ok: false,
          code: 'CHECK_FAILED',
          exitCode: call.exitCode,
          stdout: call.stdout,
          stderr: call.stderr,
          failures: [{ kind: 'invalid-json', message: 'check stdout is not JSON' }],
          json: null,
        };
      }
      return {
        ok: true,
        json: parsed,
        exitCode: call.exitCode,
        stdout: call.stdout,
        stderr: call.stderr,
        failures: [],
      };
    },

    // ---- 记录文件（真实实现直接读文件，这里读 fixture） ----------------------
    async readRoute(routeId) {
      record('readRoute', { routeId }, ['read', `re/routes/${routeId}.json`]);
      const route = options.routes?.[routeId];
      if (route === undefined) {
        return {
          ok: false,
          code: 'PROJECT_NOT_CONFIGURED',
          notFound: true,
          reason: `route ${routeId} not found in fake project ${projectRoot}`,
        };
      }
      return { ok: true, route: structuredClone(route) };
    },

    async readRun(runId) {
      record('readRun', { runId }, ['read', `re/runs/${runId}/run.json`]);
      const run = options.runs?.[runId];
      if (run === undefined) {
        return {
          ok: false,
          code: 'PROJECT_NOT_CONFIGURED',
          notFound: true,
          reason: `run ${runId} not found in fake project ${projectRoot}`,
        };
      }
      return { ok: true, run: structuredClone(run) };
    },

    async readSeals() {
      record('readSeals', {}, ['read', 're/seals/**']);
      const seals = options.seals ?? [];
      return { ok: true, seals: structuredClone(seals) };
    },
  };

  // 便于下游断言封存 fixture
  adapter.seals = options.seals ?? [];
  adapter.projectRoot = projectRoot;

  return adapter;
}

function safeJson(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function parseFailures(stderr) {
  if (typeof stderr !== 'string') return [];
  return stderr
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('ERROR:'))
    .map((line) => ({ kind: 'script', message: line.slice('ERROR:'.length).trim(), raw: line }));
}

function cliJsonResult(call, argv) {
  if (call.exitCode !== 0) {
    return {
      ok: false,
      code: call.code ?? 'CHECK_FAILED',
      exitCode: call.exitCode,
      stdout: call.stdout,
      stderr: call.stderr,
      json: safeJson(call.stdout),
      argv,
    };
  }
  const parsed = safeJson(call.stdout);
  if (parsed === null) {
    return {
      ok: false,
      code: 'CHECK_FAILED',
      exitCode: call.exitCode,
      stdout: call.stdout,
      stderr: call.stderr,
      json: null,
      reason: `${argv[0]} stdout is not JSON`,
      argv,
    };
  }
  return { ok: true, json: parsed, exitCode: call.exitCode, stdout: call.stdout, stderr: call.stderr, argv };
}
