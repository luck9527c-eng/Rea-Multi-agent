// fake-project 自身测试：可注入每个子命令的退出码/输出/延迟，并可断言调用顺序。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createFakeProject } from './helpers/fake-project.mjs';

test('默认按子命令返回可解析输出，并记录 argv', async () => {
  const project = createFakeProject({ projectRoot: 'C:/proj' });
  const checked = await project.check({ hashes: true });
  assert.equal(checked.ok, true);
  assert.deepEqual(checked.json, {
    targets: 1,
    routes: 1,
    runs: 1,
    conditions: 0,
    pending_reviews: 0,
    hashes_verified: true,
    audit_pending: false,
    open_disputes: 0,
    recovery_pending: 0,
    dispute_impacts: 0,
    completion_checked: false,
  });
  assert.deepEqual(project.callsFor('check')[0].argv, ['check', 'C:/proj', '--hashes']);
});

test('可以注入退出码、stdout、stderr 与延迟', async () => {
  const project = createFakeProject({
    responses: {
      check: { exitCode: 1, stdout: '', stderr: 'ERROR: INDEX navigation stale; run index', delayMs: 5 },
    },
  });
  const started = Date.now();
  const checked = await project.check({ hashes: true });
  assert.ok(Date.now() - started >= 4, '延迟生效');
  assert.equal(checked.ok, false);
  assert.equal(checked.code, 'CHECK_FAILED');
  assert.equal(checked.exitCode, 1);
  assert.match(checked.stderr, /INDEX navigation stale/);
});

test('queue 追加一次性应答，先入先出', async () => {
  const project = createFakeProject({
    responses: { check: { exitCode: 0, stdout: '{"targets":1}', stderr: '' } },
  });
  project.queue('check', { exitCode: 1, stderr: 'ERROR: 第一条' });
  const first = await project.check({});
  const second = await project.check({});
  assert.equal(first.exitCode, 1);
  assert.equal(second.exitCode, 0);
  assert.equal(project.callsFor('check').length, 2);
});

test('调用顺序可断言', async () => {
  const project = createFakeProject();
  await project.seal({ runId: 'RUN-1' });
  await project.impact();
  await project.index();
  await project.check({ hashes: true, complete: true });
  assert.deepEqual(project.order(), ['seal', 'impact', 'index', 'check']);
});

test('route/run/seal 文件内容由 fixture 提供，缺失时给出明确诊断', async () => {
  const project = createFakeProject({
    routes: { 'R-001': { schema_version: 1, id: 'R-001', status: 'active' } },
    runs: { 'RUN-1': { schema_version: 1, id: 'RUN-1' } },
    seals: [{ path: 're/seals/runs/RUN-1.json', sha256: 'a'.repeat(64), bytes: 160 }],
  });
  assert.equal((await project.readRoute('R-001')).route.status, 'active');
  assert.equal((await project.readRun('RUN-1')).run.id, 'RUN-1');
  assert.deepEqual((await project.readSeals()).seals, project.seals);

  const missing = await project.readRoute('R-999');
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'PROJECT_NOT_CONFIGURED');
  assert.match(missing.reason, /R-999/);
  assert.equal(project.callsFor('readRoute').length, 2);
});
