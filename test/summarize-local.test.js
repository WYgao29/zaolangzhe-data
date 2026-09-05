import test from 'node:test';
import assert from 'node:assert/strict';

import { computeBackfillDays, runSummarizer } from '../pipeline/summarize-local.js';
import { buildWorkQueue } from '../pipeline/storage.js';

function dayFile(day, items) {
  return { schemaVersion: 3, day, generatedAt: `${day}T08:00:00Z`, x: items, podcasts: [], blogs: [] };
}

function workEntry(day, key) {
  return { kind: 'x', key: `x:${key}`, day, item: { id: key, text: `tweet ${key}` } };
}

function makeDeps(overrides = {}) {
  const calls = { pull: 0, load: 0, archive: 0, summarize: [], checkpoint: [], publish: 0, log: [], report: [] };
  const repository = { index: { days: [{ day: '2026-09-04' }] }, dayFiles: new Map([['2026-09-04', dayFile('2026-09-04', [])]]) };
  const deps = {
    pull: async () => { calls.pull++; },
    loadRepo: async () => { calls.load++; return repository; },
    archive: async () => { calls.archive++; return { addedKeys: new Set(), changedDays: new Set(), duplicates: 0, fetched: 1 }; },
    buildQueue: () => ({ work: [workEntry('2026-09-04', 'a'), workEntry('2026-09-04', 'b')], newCount: 2, selfHealCount: 0 }),
    summarize: async (entry) => { calls.summarize.push(entry.key); entry.item.summaryZh = `总结 ${entry.key}`; },
    checkpoint: async (repo, days) => { calls.checkpoint.push([...days]); },
    validateAll: () => ({ errors: [] }),
    publish: async ({ changedDays }) => { calls.publish++; calls.publishDays = [...changedDays]; },
    log: (msg) => calls.log.push(msg),
    report: (patch) => calls.report.push(patch),
    ...overrides,
  };
  return { deps, calls, repository };
}

test('runSummarizer emits report events for the dashboard', async () => {
  const { deps, calls } = makeDeps();
  await runSummarizer(deps);

  const phases = calls.report.map(patch => patch.phase).filter(Boolean);
  assert.deepEqual(phases, ['archive', 'queue', 'summarize', 'publish', 'done']);
  const workEvents = calls.report.filter(patch => patch.work);
  assert.deepEqual(workEvents[0].work, { total: 2, done: 0, failed: 0 });
  assert.deepEqual(workEvents.at(-1).work, { total: 2, done: 2, failed: 0 });
  assert.deepEqual(calls.report.at(-1).result, { processed: 2, failed: 0, published: true });
});

test('runSummarizer reports failures through the work counter and lastError', async () => {
  const { deps, calls } = makeDeps({
    summarize: async () => { throw new Error('端点不可用'); },
  });
  await runSummarizer(deps);

  const workEvents = calls.report.filter(patch => patch.work);
  assert.deepEqual(workEvents[0].work, { total: 2, done: 0, failed: 0 });
  assert.deepEqual(workEvents.at(-1).work, { total: 2, done: 0, failed: 2 });
  assert.match(calls.report.filter(p => p.lastError).at(-1).lastError, /端点不可用/);
  assert.equal(calls.report.at(-1).phase, 'done');
});

test('runSummarizer archives after load, checkpoints archive days, then summarizes and publishes once', async () => {
  const order = [];
  const { deps, calls } = makeDeps({
    pull: async () => { order.push('pull'); },
    loadRepo: async () => { order.push('load'); return { index: { days: [] }, dayFiles: new Map() }; },
    archive: async () => { order.push('archive'); return { addedKeys: new Set(['x:new']), changedDays: new Set(['2026-09-05']), duplicates: 2, fetched: 1 }; },
    buildQueue: () => { order.push('queue'); return { work: [workEntry('2026-09-04', 'a')], newCount: 1, selfHealCount: 0 }; },
    summarize: async (entry) => { order.push(`summarize:${entry.key}`); entry.item.summaryZh = 'ok'; },
    checkpoint: async (repo, days) => { order.push(`checkpoint:${[...days].join(',')}`); calls.checkpoint.push([...days]); },
    publish: async ({ changedDays }) => { order.push('publish'); calls.publish++; calls.publishDays = [...changedDays]; },
  });
  const result = await runSummarizer(deps);

  assert.deepEqual(order, [
    'pull', 'load', 'archive', 'checkpoint:2026-09-05', 'queue',
    'summarize:x:a', 'checkpoint:2026-09-04', 'publish',
  ]);
  assert.equal(calls.publish, 1);
  assert.deepEqual(result, { processed: 1, failed: 0, published: true });
});

test('runSummarizer publishes archive-only changes when the queue is empty', async () => {
  const { deps, calls } = makeDeps({
    buildQueue: () => ({ work: [], newCount: 0, selfHealCount: 0 }),
    archive: async () => ({ addedKeys: new Set(['x:n1', 'x:n2']), changedDays: new Set(['2026-09-05']), duplicates: 0, fetched: 1 }),
  });
  const result = await runSummarizer(deps);
  assert.deepEqual(calls.summarize, []);
  assert.deepEqual(calls.checkpoint.at(-1), ['2026-09-05']);
  assert.equal(calls.publish, 1, '纯归档变更也必须发布');
  assert.equal(result.processed, 0);
  assert.equal(result.published, true);
});

test('runSummarizer skips publishing when nothing changed at all', async () => {
  const { deps, calls } = makeDeps({
    buildQueue: () => ({ work: [], newCount: 0, selfHealCount: 0 }),
  });
  const result = await runSummarizer(deps);
  assert.equal(calls.publish, 0);
  assert.deepEqual(result, { processed: 0, failed: 0, published: false });
});

test('runSummarizer keeps publishing when AI items fail — summaries retry next run', async () => {
  const { deps, calls } = makeDeps({
    summarize: async (entry) => {
      if (entry.key === 'x:a') throw new Error('端点不可用');
      calls.summarize.push(entry.key);
    },
  });
  const result = await runSummarizer(deps);
  assert.deepEqual(calls.summarize, ['x:b'], '失败后继续处理剩余条目');
  assert.equal(calls.publish, 1, 'AI 失败不得阻塞归档与已成功总结的发布');
  assert.equal(result.failed, 1);
  assert.equal(result.published, true);
});

test('runSummarizer refuses to publish when validation fails', async () => {
  const { deps, calls } = makeDeps({
    validateAll: () => ({ errors: ['计数不一致'] }),
  });
  await assert.rejects(() => runSummarizer(deps), /数据校验失败/);
  assert.equal(calls.publish, 0);
});

test('computeBackfillDays derives the replay window from the newest data day', () => {
  const now = Date.parse('2026-09-05T10:00:00Z'); // 北京 09-05 18:00
  assert.equal(computeBackfillDays('2026-09-05', now), 0, '最新一天是今天 → 无需回放');
  assert.equal(computeBackfillDays('2026-09-04', now), 1, '缺昨天 → 回放 1 天');
  assert.equal(computeBackfillDays('2026-09-03', now), 2, '缺前天 → 回放 2 天');
  assert.equal(computeBackfillDays('2026-08-06', now), 30, '缺 30 天 → 回放 30 天');
  assert.equal(computeBackfillDays('2026-09-06', now), 0, '未来日期按 0 处理');
  assert.equal(computeBackfillDays('', now), 0);
});

test('computeBackfillDays respects the Beijing calendar boundary', () => {
  const now = Date.parse('2026-09-05T16:00:00Z'); // 北京 09-06 00:00，刚跨入新的一天
  assert.equal(computeBackfillDays('2026-09-05', now), 1);
  assert.equal(computeBackfillDays('2026-09-06', now), 0);
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
