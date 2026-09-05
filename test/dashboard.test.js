import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDashboardServer, omlxStatus } from '../local/dashboard.js';

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zaolangzhe-dash-'));
  fs.mkdirSync(path.join(root, 'data', 'days'), { recursive: true });
  fs.mkdirSync(path.join(root, 'local'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'days', '2026-09-05.json'), JSON.stringify({ schemaVersion: 3, day: '2026-09-05', generatedAt: 'x', x: [{ id: 'a', text: 't', summaryZh: 's' }], podcasts: [], blogs: [] }));
  fs.writeFileSync(path.join(root, 'data', 'index.json'), JSON.stringify({ schemaVersion: 3, generatedAt: 'x', days: [{ day: '2026-09-05', path: 'data/days/2026-09-05.json', counts: { x: 1, podcasts: 0, blogs: 0 } }] }));
  fs.writeFileSync(path.join(root, 'local', 'run-state.json'), JSON.stringify({ running: false, phase: 'idle' }));
  fs.writeFileSync(path.join(root, 'local', 'history.jsonl'), JSON.stringify({ startedAt: 'a', processed: 3 }) + '\n');
  fs.writeFileSync(path.join(root, 'local', 'env'), 'AI_PROVIDER=openai\nAI_BASE_URL=http://127.0.0.1:8000/v1\nAI_MODEL=m\nAI_API_KEY=k\n');
  return root;
}

function startServer(deps) {
  const server = createDashboardServer(deps);
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

test('/api/status aggregates run state, data inventory, git and omlx status', async () => {
  const root = fixtureRoot();
  const { server, port } = await startServer({
    root,
    gitImpl: async (args) => args.includes('rev-list') ? '' : 'abc1234 本地中文总结 2026-09-05',
    omlxProbe: async () => ({ alive: true, models: ['Ornith-1.5-9B-MLX-4bit'] }),
  });
  try {
    const status = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
    assert.deepEqual(status.data, { days: 1, items: 1, missingSummaries: 0, newestDay: '2026-09-05' });
    assert.equal(status.run.running, false);
    assert.equal(status.git.lastCommit, 'abc1234 本地中文总结 2026-09-05');
    assert.equal(status.omlx.alive, true);
    assert.deepEqual(status.omlx.models, ['Ornith-1.5-9B-MLX-4bit']);
    assert.equal(status.history.length, 1);
    assert.equal(status.pendingTrigger, null);
  } finally { server.close(); }
});

test('/api/trigger queues a request instead of executing anything', async () => {
  const root = fixtureRoot();
  const { server, port } = await startServer({ root, gitImpl: async () => '', omlxProbe: async () => ({ alive: true, models: [] }) });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'retry' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.queued, true);
    const status = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
    assert.equal(status.pendingTrigger.action, 'retry', '投递的请求应出现在状态里');
    assert.ok(status.pendingTrigger.requestedAt, '投递需带时间戳');
  } finally { server.close(); }
});

test('/api/trigger refuses while a task is already running', async () => {
  const root = fixtureRoot();
  fs.writeFileSync(path.join(root, 'local', 'run-state.json'), JSON.stringify({ running: true, phase: 'summarize' }));
  const { server, port } = await startServer({ root, gitImpl: async () => '', omlxProbe: async () => ({ alive: true, models: [] }) });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/trigger`, { method: 'POST', body: '{"action":"run"}' });
    assert.equal(res.status, 409);
    const status = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
    assert.equal(status.pendingTrigger, null, '运行中不得投递请求');
  } finally { server.close(); }
});

test('omlxStatus normalizes base URLs that already include /v1', async () => {
  const seen = [];
  const fetchImpl = async (url) => { seen.push(url); return { ok: true, json: async () => ({ data: [{ id: 'm' }] }) }; };
  const result = await omlxStatus('http://127.0.0.1:8000/v1', 'k', fetchImpl);
  assert.deepEqual(seen, ['http://127.0.0.1:8000/v1/models'], '不得拼出 /v1/v1/models');
  assert.deepEqual(result.models, ['m']);
  assert.equal(result.alive, true);

  // 无 /v1 前缀的 base：先试 /v1/models，404 时回退 /models
  seen.length = 0;
  const fallbackFetch = async (url) => {
    seen.push(url);
    if (url.endsWith('/v1/models')) return { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => ({ data: [{ id: 'm2' }] }) };
  };
  const fallback = await omlxStatus('http://127.0.0.1:8000/', 'k', fallbackFetch);
  assert.deepEqual(seen, ['http://127.0.0.1:8000/v1/models', 'http://127.0.0.1:8000/models']);
  assert.deepEqual(fallback.models, ['m2']);
});

test('unknown paths return 404 and bad actions return 400', async () => {
  const root = fixtureRoot();
  const { server, port } = await startServer({ root, gitImpl: async () => '', omlxProbe: async () => ({ alive: false, models: [] }) });
  try {
    const notFound = await fetch(`http://127.0.0.1:${port}/nope`);
    assert.equal(notFound.status, 404);
    const badAction = await fetch(`http://127.0.0.1:${port}/api/trigger`, { method: 'POST', body: '{"action":"nuke"}' });
    assert.equal(badAction.status, 400);
  } finally { server.close(); }
});
