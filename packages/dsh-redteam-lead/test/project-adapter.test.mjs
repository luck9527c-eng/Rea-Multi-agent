// projectAdapter：跑项目副本里的 project.py。CLI 的退出码/JSON/文本输出按真实行为处理，
// 失败一律 {ok:false,...} 并保留 stdout/stderr/exitCode，绝不抛。
// 关键点：参数以数组传给 spawn、shell:false、-B、项目副本路径；已有 seal 时不调用 CLI。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createProjectAdapter } from '../src/project-adapter.mjs';

const ADAPTER_SOURCE = readFileSync(new URL('../src/project-adapter.mjs', import.meta.url), 'utf8');
const SKILL_ROOT = '.agents/skills/reverse-project-management';
const PYTHON = 'C:/Python312/python.exe';

/**
 * 假 spawn：按 (file, args) 决定输出，返回 Node 子进程形状。
 * `handler` 返回 `{exitCode, stdout, stderr}` 或 `{error}`（模拟 ENOENT）。
 */
function makeFakeSpawn(handler) {
  const calls = [];
  function spawn(file, args, options) {
    calls.push({ file, args, options });
    const result = handler({ file, args, options }) ?? { exitCode: 0 };
    const listeners = new Map();
    const stream = {
      setEncoding() {},
      on(event, callback) {
        listeners.set(`stream:${event}`, callback);
        return stream;
      },
    };
    const child = {
      stdout: stream,
      stderr: { ...stream, on(event, callback) { listeners.set(`err:${event}`, callback); return child.stderr; } },
      on(event, callback) {
        listeners.set(event, callback);
        return child;
      },
      kill() {},
    };
    queueMicrotask(() => {
      if (result.error !== undefined) {
        listeners.get('error')?.(result.error);
        return;
      }
      if (result.stdout) listeners.get('stream:data')?.(result.stdout);
      if (result.stderr) listeners.get('err:data')?.(result.stderr);
      listeners.get('close')?.(result.exitCode ?? 0, null);
    });
    return child;
  }
  return { spawn, calls };
}

/** 建一个最小可用项目（含 skill 副本与团队规则）。 */
function makeProject(t, overrides = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'rt4-project-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = {
    'INDEX.md': '# 逆向项目 INDEX\n',
    'docs/agents/reverse-project-management.md': '# repo config\n',
    [`${SKILL_ROOT}/SKILL.md`]: '# skill\n',
    [`${SKILL_ROOT}/references/team-coordination.md`]: '# 团队协作\n',
    [`${SKILL_ROOT}/references/tool-inventory.md`]: '# 工具清单\n',
    [`${SKILL_ROOT}/scripts/project.py`]: 'print("project")\n',
    [`${SKILL_ROOT}/scripts/governance.py`]: 'print("governance")\n',
    're/targets.json': '{"schema_version":1,"targets":[]}\n',
    're/project.json': '{"schema_version":1,"status":"active"}\n',
    ...overrides,
  };
  for (const [relative, content] of Object.entries(files)) {
    if (content === null) continue;
    const target = path.join(root, ...relative.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
  return {
    root,
    write(relative, content) {
      const target = path.join(root, ...relative.split('/'));
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content, 'utf8');
    },
    pathOf(relative) {
      return path.join(root, ...relative.split('/'));
    },
  };
}

const CHECK_JSON = '{"targets":1,"routes":1,"runs":1,"conditions":0,"pending_reviews":0,'
  + '"hashes_verified":true,"audit_pending":false,"open_disputes":0,"recovery_pending":0,'
  + '"dispute_impacts":0,"completion_checked":false}';

/** 让 `python --version` 与 CLI 调用各自有输出。 */
function pythonAware(cli) {
  return ({ args }) => {
    if (args[0] === '--version') return { exitCode: 0, stdout: 'Python 3.12.14\n' };
    return cli;
  };
}

test('check 成功：单行 JSON 解析，参数是数组且 shell:false、-B、项目副本路径', async (t) => {
  const project = makeProject(t);
  const fake = makeFakeSpawn(pythonAware({ exitCode: 0, stdout: `${CHECK_JSON}\n` }));
  const adapter = createProjectAdapter({ projectRoot: project.root, python: PYTHON, spawn: fake.spawn });

  const checked = await adapter.check({ hashes: true });
  assert.equal(checked.ok, true);
  assert.equal(checked.exitCode, 0);
  assert.equal(checked.json.hashes_verified, true);
  assert.equal(checked.json.targets, 1);

  const cliCall = fake.calls.at(-1);
  assert.equal(cliCall.file, PYTHON);
  assert.ok(Array.isArray(cliCall.args), '参数必须是数组');
  assert.deepEqual(cliCall.args, [
    '-B',
    project.pathOf(`${SKILL_ROOT}/scripts/project.py`),
    'check',
    project.root,
    '--hashes',
  ]);
  assert.equal(cliCall.options.shell, false);
  assert.equal(cliCall.options.cwd, project.root);
  assert.equal(cliCall.options.env.PYTHONIOENCODING.toLowerCase(), 'utf8');
});

test('check 失败：stderr 原文保留，退出码透传，不抛', async (t) => {
  const project = makeProject(t);
  const fake = makeFakeSpawn(pythonAware({
    exitCode: 1,
    stdout: '',
    stderr: 'ERROR: INDEX navigation stale; run index\n',
  }));
  const adapter = createProjectAdapter({ projectRoot: project.root, python: PYTHON, spawn: fake.spawn });
  const checked = await adapter.check({ hashes: true, complete: true });
  assert.equal(checked.ok, false);
  assert.equal(checked.code, 'CHECK_FAILED');
  assert.equal(checked.exitCode, 1);
  assert.match(checked.stderr, /INDEX navigation stale; run index/u);
  assert.equal(checked.failures[0].message, 'INDEX navigation stale; run index');
  assert.deepEqual(fake.calls.at(-1).args.slice(2), ['check', project.root, '--hashes', '--complete']);
});

test('check 输出不是 JSON → ok:false 且保留原文，不抛', async (t) => {
  const project = makeProject(t);
  const fake = makeFakeSpawn(pythonAware({ exitCode: 0, stdout: 'not json at all\n' }));
  const adapter = createProjectAdapter({ projectRoot: project.root, python: PYTHON, spawn: fake.spawn });
  const checked = await adapter.check({});
  assert.equal(checked.ok, false);
  assert.equal(checked.code, 'CHECK_FAILED');
  assert.match(checked.stdout, /not json at all/u);
});

test('impact / audit-scope：pretty JSON 直接 parse，非 JSON → ok:false', async (t) => {
  const project = makeProject(t);
  const good = makeFakeSpawn(pythonAware({ exitCode: 0, stdout: '{\n  "pending_reviews": [],\n  "dispute_impacts": []\n}\n' }));
  const adapter = createProjectAdapter({ projectRoot: project.root, python: PYTHON, spawn: good.spawn });
  const impact = await adapter.impact();
  assert.equal(impact.ok, true);
  assert.deepEqual(impact.json, { pending_reviews: [], dispute_impacts: [] });

  const bad = makeFakeSpawn(pythonAware({ exitCode: 0, stdout: 'Traceback (most recent call last)\n' }));
  const broken = createProjectAdapter({ projectRoot: project.root, python: PYTHON, spawn: bad.spawn });
  const audit = await broken.auditScope();
  assert.equal(audit.ok, false);
  assert.equal(audit.code, 'CHECK_FAILED');
  assert.match(audit.stdout, /Traceback/u);
});

test('index 是文本：成功保留 stdout，失败保留 stderr', async (t) => {
  const project = makeProject(t);
  const okSpawn = makeFakeSpawn(pythonAware({ exitCode: 0, stdout: 'Index refreshed: INDEX.md\n' }));
  const adapter = createProjectAdapter({ projectRoot: project.root, python: PYTHON, spawn: okSpawn.spawn });
  const refreshed = await adapter.index();
  assert.equal(refreshed.ok, true);
  assert.match(refreshed.stdout, /Index refreshed/u);
  assert.deepEqual(okSpawn.calls.at(-1).args.slice(2), ['index', project.root]);

  const failSpawn = makeFakeSpawn(pythonAware({ exitCode: 1, stderr: 'ERROR: INDEX requires exactly one navigation marker pair\n' }));
  const failing = createProjectAdapter({ projectRoot: project.root, python: PYTHON, spawn: failSpawn.spawn });
  const failed = await failing.index();
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'CHECK_FAILED');
  assert.match(failed.stderr, /navigation marker pair/u);
});

test('已有 seal 文件时不调用 CLI；否则调 seal 并区分「已封存」与真失败', async (t) => {
  const sealed = makeProject(t, { 're/seals/runs/RUN-1.json': '{"schema_version":1,"run_id":"RUN-1"}\n' });
  const skippedFake = makeFakeSpawn(pythonAware({ exitCode: 0 }));
  const skipAdapter = createProjectAdapter({ projectRoot: sealed.root, python: PYTHON, spawn: skippedFake.spawn });
  const skipped = await skipAdapter.seal({ runId: 'RUN-1' });
  assert.equal(skipped.ok, true);
  assert.equal(skipped.alreadySealed, true);
  assert.equal(skipped.called, false);
  assert.equal(skippedFake.calls.length, 0, '已有封存时不得调用 CLI');

  const fresh = makeProject(t);
  const freshFake = makeFakeSpawn(pythonAware({ exitCode: 0, stdout: 'Sealed RUN-2; preserve re/seals in reviewed version control; refresh INDEX.\n' }));
  const freshAdapter = createProjectAdapter({ projectRoot: fresh.root, python: PYTHON, spawn: freshFake.spawn });
  const sealedNow = await freshAdapter.seal({ runId: 'RUN-2' });
  assert.equal(sealedNow.ok, true);
  assert.equal(sealedNow.alreadySealed, false);
  assert.equal(sealedNow.called, true);
  assert.deepEqual(freshFake.calls.at(-1).args.slice(2), ['seal', fresh.root, 'RUN-2']);

  const refusing = makeFakeSpawn(pythonAware({
    exitCode: 1,
    stderr: 'ERROR: RUN-2: refusing to overwrite sealed execution\n',
  }));
  const refusingAdapter = createProjectAdapter({ projectRoot: fresh.root, python: PYTHON, spawn: refusing.spawn });
  const reused = await refusingAdapter.seal({ runId: 'RUN-2' });
  assert.equal(reused.ok, true, '「已封存」是可复用状态，不是失败');
  assert.equal(reused.alreadySealed, true);
  assert.equal(reused.reused, true);
  assert.equal(reused.exitCode, 1);

  const broken = makeFakeSpawn(pythonAware({
    exitCode: 1,
    stderr: 'ERROR: T-001: sealed target identity mismatch\n',
  }));
  const brokenAdapter = createProjectAdapter({ projectRoot: fresh.root, python: PYTHON, spawn: broken.spawn });
  const failed = await brokenAdapter.seal({ runId: 'RUN-2' });
  assert.equal(failed.ok, false, '身份不一致是真失败');
  assert.equal(failed.code, 'CHECK_FAILED');
  assert.equal(failed.alreadySealed, false);
});

test('readRoute / readRun / readSeals 直接读文件，非法 ID 与缺失记录都有明确结果', async (t) => {
  const project = makeProject(t, {
    're/routes/R-001.json': '{"schema_version":1,"id":"R-001","status":"active"}\n',
    're/runs/RUN-1/run.json': '{"schema_version":1,"id":"RUN-1","status":"completed"}\n',
    're/seals/runs/RUN-1.json': '{"schema_version":1,"run_id":"RUN-1"}\n',
    're/seals/targets/T-001.json': '{"schema_version":1,"identity":{"id":"T-001"}}\n',
  });
  const fake = makeFakeSpawn(pythonAware({ exitCode: 0 }));
  const adapter = createProjectAdapter({ projectRoot: project.root, python: PYTHON, spawn: fake.spawn });

  const route = await adapter.readRoute('R-001');
  assert.equal(route.ok, true);
  assert.equal(route.route.status, 'active');
  const run = await adapter.readRun('RUN-1');
  assert.equal(run.ok, true);
  assert.equal(run.run.status, 'completed');

  const seals = await adapter.readSeals();
  assert.equal(seals.ok, true);
  assert.deepEqual(seals.seals.map((seal) => seal.path), [
    're/seals/runs/RUN-1.json',
    're/seals/targets/T-001.json',
  ]);
  assert.match(seals.seals[0].sha256, /^[0-9a-f]{64}$/u);
  assert.ok(seals.seals[0].bytes > 0);
  assert.equal(fake.calls.length, 0, '读记录不走 CLI');

  const missing = await adapter.readRoute('R-999');
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'PROJECT_NOT_CONFIGURED');
  assert.equal(missing.notFound, true);

  const traversal = await adapter.readRoute('../R-001');
  assert.equal(traversal.ok, false);
  assert.equal(traversal.code, 'INVALID_ARGUMENT');
});

test('probe：完整项目给出可核对 compatibility 与零阻塞 gap', async (t) => {
  const project = makeProject(t);
  const fake = makeFakeSpawn(pythonAware({ exitCode: 0 }));
  const adapter = createProjectAdapter({ projectRoot: project.root, python: PYTHON, spawn: fake.spawn });
  const probed = await adapter.probe({ projectRoot: project.root });
  assert.equal(probed.ok, true);
  const compatibility = probed.compatibility;
  assert.equal(compatibility.projectRoot, project.root);
  assert.equal(compatibility.indexPresent, true);
  assert.equal(compatibility.configPresent, true);
  assert.equal(compatibility.skillCopyPresent, true);
  assert.equal(compatibility.hasTeamRules, true);
  assert.equal(compatibility.pythonOk, true);
  assert.equal(compatibility.versions.python, '3.12.14');
  assert.equal(compatibility.versions.pythonExe, PYTHON);
  assert.equal(compatibility.versions.pythonSource, 'explicit');
  assert.equal(compatibility.versions.adapter, 1);
  assert.match(compatibility.ruleDigest, /^[0-9a-f]{64}$/u);
  assert.match(compatibility.scriptDigest, /^[0-9a-f]{64}$/u);
  assert.match(compatibility.catalogDigest, /^[0-9a-f]{64}$/u);
  assert.deepEqual(probed.gaps.filter((gap) => gap.blocking === true), []);
});

test('probe：缺团队规则/缺 INDEX/缺 Python 各自给出具体 gap 与下一步', async (t) => {
  const bare = makeProject(t, {
    'INDEX.md': null,
    [`${SKILL_ROOT}/references/team-coordination.md`]: null,
    [`${SKILL_ROOT}/scripts/project.py`]: null,
  });
  const missingPython = makeFakeSpawn(() => ({ error: Object.assign(new Error('spawn python ENOENT'), { code: 'ENOENT' }) }));
  const adapter = createProjectAdapter({ projectRoot: bare.root, python: undefined, spawn: missingPython.spawn });
  const probed = await adapter.probe({ projectRoot: bare.root });
  assert.equal(probed.ok, false);
  const codes = probed.gaps.map((gap) => gap.code);
  assert.ok(codes.includes('PROJECT_INDEX_MISSING'), codes.join(','));
  assert.ok(codes.includes('TEAM_RULES_MISSING'), codes.join(','));
  assert.ok(codes.includes('PROJECT_SCRIPT_MISSING'), codes.join(','));
  assert.ok(codes.includes('PYTHON_MISSING'), codes.join(','));
  for (const gap of probed.gaps) {
    assert.ok(typeof gap.detail === 'string' && gap.detail.length > 0);
    assert.ok(typeof gap.nextStep === 'string' && gap.nextStep.length > 0);
  }
  assert.equal(probed.compatibility.pythonOk, false);
  assert.equal(probed.compatibility.hasTeamRules, false);
});

test('probe：项目配置里 pin 的解释器优先于 PATH', async (t) => {
  const pinned = mkdtempSync(path.join(tmpdir(), 'rt4-py-'));
  t.after(() => rmSync(pinned, { recursive: true, force: true }));
  const pinnedExe = path.join(pinned, 'python.exe');
  writeFileSync(pinnedExe, 'fake python', 'utf8');
  const project = makeProject(t, {
    'docs/agents/reverse-project-management.md': `# repo config\n\n脚本一律用 \`${pinnedExe}\` 运行\n`,
  });
  const fake = makeFakeSpawn(pythonAware({ exitCode: 0 }));
  const adapter = createProjectAdapter({ projectRoot: project.root, spawn: fake.spawn });
  const probed = await adapter.probe({ projectRoot: project.root });
  assert.equal(probed.compatibility.versions.pythonSource, 'project-config');
  assert.equal(probed.compatibility.versions.pythonExe, pinnedExe);
});

test('源码级断言：参数数组 + shell:false + 无 exec/字符串拼接命令', () => {
  assert.match(ADAPTER_SOURCE, /shell:\s*false/u);
  assert.doesNotMatch(ADAPTER_SOURCE, /shell:\s*true/u);
  assert.doesNotMatch(ADAPTER_SOURCE, /\bexec\(/u, '不得用 exec(');
  assert.doesNotMatch(ADAPTER_SOURCE, /\bexecSync\b|\bexecFile\b|\bspawnSync\b/u);
  assert.doesNotMatch(ADAPTER_SOURCE, /cmd\.exe|\/bin\/sh|\/bin\/bash/u, '不得经过 shell 解释器');
  assert.match(ADAPTER_SOURCE, /from 'node:child_process'/u, '只用 child_process.spawn');
  assert.match(ADAPTER_SOURCE, /const args = \[/u, '参数必须以数组构造');
  assert.doesNotMatch(ADAPTER_SOURCE, /args\.join\(/u);
});
