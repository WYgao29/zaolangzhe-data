import test from 'node:test';
import assert from 'node:assert/strict';

import { runSummarizer } from '../pipeline/summarize-local.js';
import { buildWorkQueue } from '../pipeline/storage.js';

function dayFile(day, items) {
  return { schemaVersion: 3, day, generatedAt: `${day}T08:00:00Z`, x: items, podcasts: [], blogs: [] };
}

function workEntry(day, key) {
  return { kind: 'x', key: `x:${key}`, day, item: { id: key, text: `tweet ${key}` } };
}

function makeDeps(overrides = {}) {
  const calls = { pull: 0, load: 0, summarize: [], checkpoint: [], publish: 0, log: [] };
  const repository = { dayFiles: new Map([['2026-09-04', dayFile('2026-09-04', [])]]) };
  const deps = {
    pull: async () => { calls.pull++; },
    loadRepo: async () => { calls.load++; return repository; },
    buildQueue: () => ({ work: [workEntry('2026-09-04', 'a'), workEntry('2026-09-04', 'b')], newCount: 2, selfHealCount: 0 }),
    summarize: async (entry) => { calls.summarize.push(entry.key); entry.item.summaryZh = `总结 ${entry.key}`; },
    checkpoint: async (repo, day) => { calls.checkpoint.push(day); },
    validateAll: () => ({ errors: [] }),
    publish: async () => { calls.publish++; },
    log: (msg) => calls.log.push(msg),
    ...overrides,
  };
  return { deps, calls, repository };
}

test('runSummarizer pulls first, summarizes each item, checkpoints per item, publishes once', async () => {
  const order = [];
  const { deps, calls } = makeDeps({
    pull: async () => { order.push('pull'); },
    summarize: async (entry) => { order.push(`summarize:${entry.key}`); entry.item.summaryZh = 'ok'; },
    checkpoint: async (repo, day) => { order.push(`checkpoint:${day}`); calls.checkpoint.push(day); },
    publish: async ({ changedDays }) => { order.push('publish'); calls.publish++; calls.publishDays = [...changedDays]; },
  });
  const result = await runSummarizer(deps);

  assert.deepEqual(order, ['pull', 'summarize:x:a', 'checkpoint:2026-09-04', 'summarize:x:b', 'checkpoint:2026-09-04', 'publish']);
  assert.equal(calls.publish, 1);
  assert.deepEqual(result, { processed: 2, failed: 0, published: true });
});

test('runSummarizer exits without publishing when the queue is empty', async () => {
  const { deps, calls } = makeDeps({
    buildQueue: () => ({ work: [], newCount: 0, selfHealCount: 0 }),
  });
  const result = await runSummarizer(deps);
  assert.deepEqual(calls.summarize, []);
  assert.equal(calls.publish, 0);
  assert.deepEqual(result, { processed: 0, failed: 0, published: false });
});

test('runSummarizer continues past a failed item but refuses to publish', async () => {
  const { deps, calls } = makeDeps({
    summarize: async (entry) => {
      if (entry.key === 'x:a') throw new Error('端点不可用');
      calls.summarize.push(entry.key);
    },
  });
  await assert.rejects(() => runSummarizer(deps), /1 条总结失败/);
  assert.deepEqual(calls.summarize, ['x:b'], '失败后继续处理剩余条目');
  assert.equal(calls.publish, 0);
});

test('runSummarizer refuses to publish when validation fails', async () => {
  const { deps, calls } = makeDeps({
    validateAll: () => ({ errors: ['计数不一致'] }),
  });
  await assert.rejects(() => runSummarizer(deps), /数据校验失败/);
  assert.equal(calls.publish, 0);
});

test('buildWorkQueue honours the recentDays window', () => {
  const dayFiles = new Map([
    ['2026-09-04', dayFile('2026-09-04', [{ id: 'new', text: 't', summaryZh: '' }])],
    ['2026-09-01', dayFile('2026-09-01', [{ id: 'mid', text: 't', summaryZh: '' }])],
    ['2026-08-20', dayFile('2026-08-20', [{ id: 'old', text: 't', summaryZh: '' }])],
  ]);
  const now = Date.parse('2026-09-04T12:00:00Z');
  const recent2 = buildWorkQueue(dayFiles, { now, aiEnabled: true, recentDays: 2 });
  assert.deepEqual(recent2.work.map(entry => entry.key), ['x:new']);
  const recent7 = buildWorkQueue(dayFiles, { now, aiEnabled: true, recentDays: 7 });
  assert.deepEqual(recent7.work.map(entry => entry.key).sort(), ['x:mid', 'x:new']);
  const all = buildWorkQueue(dayFiles, { now, aiEnabled: true, includeAllMissing: true });
  assert.equal(all.work.length, 3);
});
