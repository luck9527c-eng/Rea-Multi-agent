// host.mjs 自身测试：T5/T6/T7 依赖它一行装配 ctx，装配结果必须与 SEAMS 第 1 节一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { DEP_KEYS, makeClock, makeCtx, makeFakeTools, makeTempProject } from './helpers/host.mjs';
import { CONTRACT_VERSION } from '../src/compatibility.mjs';

test('makeCtx 装配出 SEAMS 第 1 节的全部 deps 键（已实现的给真实模块，未实现的为 null）', (t) => {
  const ctx = makeCtx({ t });
  assert.deepEqual(Object.keys(ctx.deps).sort(), [...DEP_KEYS].sort());
  assert.equal(typeof ctx.deps.teamAdapter.listMembers, 'function');
  assert.equal(typeof ctx.deps.projectAdapter.check, 'function');
  assert.equal(ctx.deps.compatibility.CONTRACT_VERSION, CONTRACT_VERSION);
  assert.equal(typeof ctx.deps.clock.now, 'function');
  assert.match(ctx.deps.clock.isoNow(), /^\d{4}-\d{2}-\d{2}T/u);
  assert.equal(typeof ctx.deps.fs.readFile, 'function');
  // T1/T3 的模块直接可用（命名空间），T5/T6/T7 需要实例时用 depsOverrides 覆盖
  assert.equal(typeof ctx.deps.identity.resolveCaller, 'function');
  assert.equal(typeof ctx.deps.operation.createOperationLedger, 'function');
  assert.equal(typeof ctx.deps.lock.acquire, 'function');
  assert.equal(typeof ctx.deps.audit.appendAudit, 'function');
  assert.equal(typeof ctx.deps.catalog.composeTemplate, 'function');
  assert.equal(typeof ctx.deps.capability.matchCapabilities, 'function');
  assert.equal(typeof ctx.deps.capacity.planBudget, 'function');
  assert.equal(typeof ctx.deps.envelope.ok, 'function');
  // 本轮（T4）还没实现的键
  assert.equal(ctx.deps.binding, null);
  assert.equal(ctx.deps.contract, null);
  assert.equal(ctx.deps.submission, null);
  assert.equal(ctx.config.presetId, 'redteam-lead');
  assert.equal(typeof ctx.now(), 'number');
  assert.equal(ctx.root, ctx.fakes.projectRoot);
});

test('role 决定 exec.agent：lead / teammate / none', async (t) => {
  const lead = makeCtx({ t });
  const asLead = await lead.deps.teamAdapter.membership(lead.exec.agent);
  assert.equal(asLead.member.role, 'lead');
  assert.equal(asLead.member.name, 'lead');

  const teammate = makeCtx({ t, role: 'teammate', agentName: 'rt-scout' });
  const asTeammate = await teammate.deps.teamAdapter.membership(teammate.exec.agent);
  assert.equal(asTeammate.member.role, 'teammate');
  assert.equal(asTeammate.member.name, 'rt-scout');

  const bare = makeCtx({ t, role: 'none' });
  const denied = await bare.deps.teamAdapter.membership(bare.exec.agent);
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'ROLE_REQUIRED');
});

test('team:null → 服务缺席，所有团队方法 TEAM_SERVICE_UNAVAILABLE', async (t) => {
  const ctx = makeCtx({ t, team: null });
  assert.equal(ctx.services.agentTeams, undefined);
  assert.equal(ctx.deps.teamAdapter.hasService(), false);
  const listed = await ctx.deps.teamAdapter.listMembers();
  assert.equal(listed.ok, false);
  assert.equal(listed.code, 'TEAM_SERVICE_UNAVAILABLE');
});

test('容量只来自显式声明：project 文件 / profile config / 都没有', async (t) => {
  const declaredViaProject = makeCtx({
    t,
    teamOpts: { members: [{ name: 'rt-scout' }, { name: 'rt-dead', status: 'failed' }] },
    capacity: { known: true, maxMembers: 5, maxActiveSubagents: 3, via: 'project' },
  });
  const projectFile = path.join(declaredViaProject.fakes.projectRoot, 're', 'team', 'capacity.json');
  assert.ok(existsSync(projectFile), 'via:project 必须落成 re/team/capacity.json');
  const fromProject = await declaredViaProject.deps.teamAdapter.capacity();
  assert.deepEqual(fromProject.memberSlots, { known: true, remaining: 3, total: 5, used: 2 });
  assert.equal(fromProject.evidence.source, 'declared:re/team/capacity.json');

  const declaredViaConfig = makeCtx({
    t,
    teamOpts: { members: [{ name: 'rt-scout' }] },
    capacity: { known: true, maxMembers: 4, maxActiveSubagents: 2, via: 'config' },
  });
  assert.equal(existsSync(path.join(declaredViaConfig.fakes.projectRoot, 're', 'team', 'capacity.json')), false);
  const fromConfig = await declaredViaConfig.deps.teamAdapter.capacity();
  assert.deepEqual(fromConfig.memberSlots, { known: true, remaining: 3, total: 4, used: 1 });
  assert.equal(fromConfig.evidence.source, 'declared:profile-config');

  const undeclared = makeCtx({ t, teamOpts: { members: [{ name: 'rt-scout' }] } });
  const unknown = await undeclared.deps.teamAdapter.capacity();
  assert.deepEqual(unknown.memberSlots, { known: false, remaining: null, total: null, used: 1 });
  assert.equal(unknown.evidence.source, 'unavailable');
});

test('工具可见性按 agent 名字区分（T5 的 vacant 判定要用）', (t) => {
  const ctx = makeCtx({
    t,
    tools: {
      lead: { rt_roster: { type: 'object' }, rea_inspect: { type: 'object' } },
      'rt-scout': { rea_inspect: { type: 'object' } },
    },
  });
  assert.deepEqual(ctx.services.tools.names(ctx.exec.agent).sort(), ['rea_inspect', 'rt_roster']);
  assert.equal(ctx.services.tools.get('rt_roster', ctx.exec.agent).type, 'object');
  assert.equal(ctx.services.tools.get('rt_roster', { name: 'rt-scout' }), null);
});

test('depsOverrides 可以注入 T1/T3 的模块', (t) => {
  const marker = { resolveCaller: async () => ({ ok: true, role: 'lead' }) };
  const ctx = makeCtx({ t, depsOverrides: { identity: marker } });
  assert.equal(ctx.deps.identity, marker);
});

test('T1 的 identity.resolveCaller 能直接吃 makeCtx 的 ctx（适配器投影与身份模块相容）', async (t) => {
  const lead = makeCtx({ t });
  const asLead = await lead.deps.identity.resolveCaller(lead);
  assert.equal(asLead.ok, true);
  assert.equal(asLead.role, 'lead');
  assert.equal(asLead.name, 'lead');

  const bare = makeCtx({ t, role: 'none' });
  const asBare = await bare.deps.identity.resolveCaller(bare);
  assert.equal(asBare.ok, false);
  assert.equal(asBare.code, 'ROLE_REQUIRED');
});

test('makeClock 可前进且 isoNow 带时区', () => {
  const clock = makeClock(Date.parse('2026-10-29T00:00:00Z'));
  assert.equal(clock.isoNow(), '2026-10-29T00:00:00.000Z');
  clock.advance(1500);
  assert.equal(clock.now(), Date.parse('2026-10-29T00:00:01.500Z'));
});

test('makeTempProject 写出 index/config/skill 副本，files:null 可删默认文件', (t) => {
  const project = makeTempProject({
    t,
    files: { 'INDEX.md': null, 're/routes/R-001.json': { schema_version: 1, id: 'R-001' } },
  });
  assert.equal(existsSync(path.join(project.root, 'INDEX.md')), false);
  assert.ok(existsSync(path.join(project.root, '.agents', 'skills', 'reverse-project-management', 'SKILL.md')));
  const route = JSON.parse(readFileSync(project.pathOf('re/routes/R-001.json'), 'utf8'));
  assert.equal(route.id, 'R-001');
});

test('makeFakeTools 默认空集，get 不到就是 null', (t) => {
  const tools = makeFakeTools();
  assert.deepEqual(tools.schemas({ name: 'lead' }), {});
  assert.equal(tools.get('rt_roster', { name: 'lead' }), null);
});
