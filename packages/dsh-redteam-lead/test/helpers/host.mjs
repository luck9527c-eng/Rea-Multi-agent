/**
 * 假 ctx 装配（SEAMS 第 1 节 + 第 5 节）：一行拿到可直接传给 handler 的 `ctx`。
 *
 * ```js
 * import { makeCtx } from './helpers/host.mjs'
 *
 * const ctx = makeCtx({ role: 'lead' })
 * const { envelope } = await handleRoster(ctx, input)
 * ```
 *
 * 装配出来的东西：
 *
 * - `ctx.services.agentTeams` = `createFakeTeam(...).service`（`team: null` 时不挂，用于
 *   `TEAM_SERVICE_UNAVAILABLE` 分支）；
 * - `ctx.services.tools` = 假工具注册表（`schemas(agent)` / `get(name, agent)`），用于
 *   「工具可见性从实际执行者取」的测试；
 * - `ctx.deps.teamAdapter` = **真实** `src/team-adapter.mjs` 套在假宿主上（所以映射逻辑被测到）；
 * - `ctx.deps.projectAdapter` = `test/helpers/fake-project.mjs` 替身；
 * - `ctx.deps.compatibility` = **真实** `src/compatibility.mjs` 模块；
 * - `ctx.deps` 里 T1/T3 的模块（`envelope`/`errors`/`validate`/`paths`/`atomic`/`lock`/`identity`/
 *   `operation`/`audit`/`catalog`/`capability`/`capacity`）默认装配**真实模块命名空间**；
 *   需要实例而不是命名空间时（例如 `operation` 的 ledger、已加载的 `catalog`）用
 *   `depsOverrides` 覆盖；
 * - 本轮尚未实现的键（`binding`/`contract`/`resources`/`submission`/`anchors`/`baseline`）为 `null`；
 * - `ctx.deps.clock` / `ctx.deps.fs` = 假时钟与 `fs/promises` 薄封装。
 *
 * 容量：真实宿主没有容量查询（D1），所以容量只能来自**显式声明**
 * （`re/team/capacity.json` 或 `ctx.config.capacity`）。`makeCtx({capacity})` 只负责把这份
 * 声明落到项目文件或 config 里；不传就什么都不落（→ `capacity().memberSlots.known === false`）。
 *
 * | `capacity` | 行为 |
 * |---|---|
 * | `{known:true, maxMembers, maxActiveSubagents, via:'project'}` | 写 `re/team/capacity.json` |
 * | `{known:true, maxMembers, maxActiveSubagents, via:'config'}` | 写 `ctx.config.capacity` |
 * | `{known:false}` / 不传 | 不声明 |
 *
 * `teamOpts.capacity` 也会被当作同一个 fixture 使用（`createFakeTeam` 只是它的载体）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createTeamAdapter } from '../dist/team-adapter.js';
import * as compatibility from '../dist/compatibility.js';
import * as envelope from '../dist/envelope.js';
import * as errors from '../dist/errors.js';
import * as validate from '../dist/validate.js';
import * as paths from '../dist/paths.js';
import * as atomic from '../dist/atomic.js';
import * as lock from '../dist/lock.js';
import * as identity from '../dist/identity.js';
import * as operation from '../dist/operation.js';
import * as audit from '../dist/audit.js';
import * as catalog from '../dist/catalog.js';
import * as capability from '../dist/capability.js';
import * as capacity from '../dist/capacity.js';
import { createFakeTeam } from './fake-team.mjs';
import { createFakeProject } from './fake-project.mjs';

const SKILL_ROOT = '.agents/skills/reverse-project-management';

/** `deps` 的键名（SEAMS 第 1 节，T2 的 index.js 必须与之一致）。 */
export const DEP_KEYS = Object.freeze([
  'envelope', 'errors', 'validate', 'paths', 'atomic', 'lock', 'identity', 'operation', 'audit',
  'catalog', 'capability', 'capacity', 'teamAdapter', 'projectAdapter', 'compatibility',
  'binding', 'contract', 'resources', 'submission', 'anchors', 'baseline', 'clock', 'fs',
]);

/** 建一个临时目录；传了 node:test 的 `t` 会在测试结束时自动删除。 */
export function makeTempDir(t, prefix = 'rt4-host-') {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  if (t !== undefined && typeof t.after === 'function') {
    t.after(() => rmSync(directory, { recursive: true, force: true }));
  }
  return directory;
}

/**
 * 建一个最小分析项目骨架（含 INDEX、项目配置、skill 副本、re/ 记录）。
 * @param {object} [options]
 * @param {import('node:test').TestContext} [options.t] 传了即自动清理
 * @param {Record<string, string|object|null>} [options.files] 追加/覆盖文件；`null` 表示删掉默认文件
 */
export function makeTempProject(options = {}) {
  const root = makeTempDir(options.t, options.prefix ?? 'rt4-project-');
  const defaults = {
    'INDEX.md': '# 逆向项目 INDEX\n',
    'docs/agents/reverse-project-management.md': '# repo config\n',
    [`${SKILL_ROOT}/SKILL.md`]: '# skill\n',
    [`${SKILL_ROOT}/references/team-coordination.md`]: '# 团队协作\n',
    [`${SKILL_ROOT}/references/tool-inventory.md`]: '# 工具清单\n',
    [`${SKILL_ROOT}/references/layout.md`]: '# 布局\n',
    [`${SKILL_ROOT}/scripts/project.py`]: 'print("project")\n',
    [`${SKILL_ROOT}/scripts/governance.py`]: 'print("governance")\n',
    're/targets.json': '{"schema_version":1,"targets":[]}\n',
    're/project.json': '{"schema_version":1,"status":"active"}\n',
  };
  const files = { ...defaults, ...(options.files ?? {}) };
  const project = {
    root,
    pathOf(relative) {
      return path.join(root, ...relative.split('/'));
    },
    write(relative, content) {
      const target = project.pathOf(relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8');
    },
    remove(relative) {
      rmSync(project.pathOf(relative), { force: true });
    },
    read(relative) {
      return fsp.readFile(project.pathOf(relative), 'utf8');
    },
  };
  for (const [relative, content] of Object.entries(files)) {
    if (content === null) continue;
    project.write(relative, content);
  }
  return project;
}

/** 假时钟：`{now(), isoNow(), advance(ms), set(ms)}`。 */
export function makeClock(start = Date.UTC(2026, 0, 1, 0, 0, 0)) {
  let current = start;
  return {
    now() {
      return current;
    },
    isoNow() {
      return new Date(current).toISOString();
    },
    advance(ms) {
      current += ms;
      return current;
    },
    set(ms) {
      current = ms;
      return current;
    },
  };
}

/**
 * 假工具注册表：按 agent 名字给不同工具集，用来测「工具可见性从实际执行者取」。
 * @param {Record<string, Record<string, object>|string[]>} [spec] `{lead: {...}, 'rt-scout': {...}, default: {...}}`
 */
export function makeFakeTools(spec = {}) {
  const byName = spec ?? {};
  const fallback = byName.default ?? {};
  function mapFor(agent) {
    const key = agent && typeof agent === 'object' ? agent.name : undefined;
    return (key !== undefined && byName[key] !== undefined ? byName[key] : fallback) ?? {};
  }
  return {
    schemas(agent) {
      return { ...mapFor(agent) };
    },
    get(name, agent) {
      const map = mapFor(agent);
      return map[name] ?? null;
    },
    names(agent) {
      return Object.keys(mapFor(agent));
    },
    has(name, agent) {
      return mapFor(agent)[name] !== undefined;
    },
  };
}

/** `fs/promises` 的薄封装（SEAMS 第 1 节的 `deps.fs`）。 */
export function makeFs() {
  return {
    readFile: fsp.readFile,
    writeFile: fsp.writeFile,
    rename: fsp.rename,
    mkdir: fsp.mkdir,
    stat: fsp.stat,
    lstat: fsp.lstat,
    readdir: fsp.readdir,
    unlink: fsp.unlink,
    open: fsp.open,
    rm: fsp.rm,
    copyFile: fsp.copyFile,
  };
}

/**
 * 一行装配假 `ctx`。
 * @param {object} [options]
 * @param {'lead'|'teammate'|'none'} [options.role] 调用者角色
 * @param {string} [options.agentName] 调用者名字
 * @param {object|null} [options.team] 直接给一个 fake team；`null` 表示不挂团队服务
 * @param {object} [options.teamOpts] 传给 `createFakeTeam`
 * @param {object|null} [options.project] 直接给一个项目 adapter；`null` 表示不挂
 * @param {object} [options.projectOpts] 传给 `createFakeProject`
 * @param {object} [options.capacity] 容量声明 fixture（见文件头）
 * @param {object} [options.tools] 传给 `makeFakeTools`
 * @param {object} [options.depsOverrides] 覆盖/注入 `deps` 的任意键
 * @param {object} [options.config] 合并进 `ctx.config`
 * @param {string} [options.projectRoot] 项目根；不给就临时建一个
 * @param {import('node:test').TestContext} [options.t] 传了即自动清理临时项目
 * @param {number} [options.now] 假时钟起点
 */
export function makeCtx(options = {}) {
  const clock = makeClock(options.now ?? Date.UTC(2026, 0, 1, 0, 0, 0));
  const projectRoot = options.projectRoot ?? makeTempProject({ t: options.t }).root;

  const team = options.team === null
    ? null
    : (options.team ?? createFakeTeam({
      role: options.role ?? 'lead',
      ...(options.agentName === undefined ? {} : { agentName: options.agentName }),
      clock: () => clock.now(),
      ...(options.teamOpts ?? {}),
    }));

  const declared = options.capacity
    ?? (team !== null && team.capacityDeclaration !== null ? team.capacityDeclaration : null);

  if (declared !== null && declared !== undefined) {
    if (declared.known === true && declared.via === 'config') {
      // 由下面 config 分支写入
    } else if (declared.known === true) {
      const payload = {
        schema_version: 1,
        declared_at: declared.declared_at ?? new Date(clock.now()).toISOString(),
        declared_by: declared.declared_by ?? 'host-helper',
        maxMembers: declared.maxMembers,
        maxActiveSubagents: declared.maxActiveSubagents,
      };
      const target = path.join(projectRoot, 're', 'team', 'capacity.json');
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    }
  }

  const config = {
    defaults: {},
    presetId: 'redteam-lead',
    bundleRoot: undefined,
    projectRoot,
    ...(options.config ?? {}),
    ...(declared !== null && declared !== undefined && declared.known === true && declared.via === 'config'
      ? { capacity: { maxMembers: declared.maxMembers, maxActiveSubagents: declared.maxActiveSubagents } }
      : {}),
  };

  const execAgent = team !== null ? team.agent : undefined;
  const exec = {
    agent: execAgent,
    signal: new AbortController().signal,
    cwd: projectRoot,
  };

  const services = {
    ...(team === null ? {} : { agentTeams: team.service }),
    tools: makeFakeTools(options.tools ?? options.toolsSpec ?? {}),
  };

  const teamAdapter = createTeamAdapter({
    services,
    exec,
    config,
    projectRoot,
  });

  const project = options.project === null
    ? null
    : (options.project ?? createFakeProject({ projectRoot, ...(options.projectOpts ?? {}) }));

  const deps = {
    envelope,
    errors,
    validate,
    paths,
    atomic,
    lock,
    identity,
    operation,
    audit,
    catalog,
    capability,
    capacity,
    teamAdapter,
    projectAdapter: project,
    compatibility,
    binding: null,
    contract: null,
    resources: null,
    submission: null,
    anchors: null,
    baseline: null,
    clock,
    fs: makeFs(),
    ...(options.depsOverrides ?? {}),
  };

  const ctx = {
    deps,
    exec,
    services,
    config,
    now: () => clock.now(),
    root: projectRoot,
    fakes: {
      team,
      project,
      clock,
      projectRoot,
      cleanup() {
        rmSync(projectRoot, { recursive: true, force: true });
      },
    },
  };
  return ctx;
}
