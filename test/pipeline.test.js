import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  atomicWriteJSON,
  buildWorkQueue,
  loadRepository,
  mergeIncoming,
} from '../pipeline/storage.js';
import { requireAIText } from '../pipeline/process.js';

const NOW = Date.parse('2026-08-30T12:00:00Z');

function tweet(id, textZh = '中文') {
  return { id, handle: 'a', builder: 'A', bio: '', text: `tweet ${id}`, textZh, createdAt: '2026-08-30T01:00:00Z', url: `https://x.com/a/status/${id}` };
}

function dayFile(day, overrides = {}) {
  return { schemaVersion: 2, day, generatedAt: '2026-08-30T07:00:00Z', x: [], podcasts: [], blogs: [], ...overrides };
}

test('mergeIncoming adds new keys but merges duplicate fields without adding another item', () => {
  const days = new Map([['2026-08-30', dayFile('2026-08-30', { x: [tweet('existing', '')] })]]);
  const result = mergeIncoming(days, {
    day: '2026-08-30', generatedAt: '2026-08-30T08:00:00Z',
    x: [tweet('existing', '补齐译文'), tweet('new')], podcasts: [], blogs: [],
  });
  assert.equal(result.addedKeys.size, 1);
  assert.equal(result.addedKeys.has('x:new'), true);
  assert.equal(result.duplicates, 1);
  assert.equal(days.get('2026-08-30').x.length, 2);
  assert.equal(days.get('2026-08-30').x.find(x => x.id === 'existing').textZh, '补齐译文');
});

test('mergeIncoming does not mark an identical upstream snapshot as changed', () => {
  const existing = tweet('same');
  const days = new Map([['2026-08-30', dayFile('2026-08-30', { x: [existing] })]]);
  const result = mergeIncoming(days, {
    day: '2026-08-30', generatedAt: '2026-08-30T08:00:00Z',
    x: [{ ...existing }], podcasts: [], blogs: [],
  });
  assert.equal(result.duplicates, 1);
  assert.equal(result.changedDays.size, 0);
});

test('buildWorkQueue includes new items and recent translation gaps exactly once', () => {
  const days = new Map([
    ['2026-08-30', dayFile('2026-08-30', { x: [tweet('new'), tweet('missing', '')] })],
    ['2026-08-20', dayFile('2026-08-20', { x: [tweet('old-missing', '')] })],
  ]);
  const result = buildWorkQueue(days, { addedKeys: new Set(['x:new']), now: NOW });
  assert.deepEqual(result.work.map(x => x.key).sort(), ['x:missing', 'x:new']);
  assert.equal(result.newCount, 1);
  assert.equal(result.selfHealCount, 1);
});

test('atomicWriteJSON keeps the previous file when validation rejects the replacement', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaolangzhe-atomic-'));
  const file = path.join(dir, 'value.json');
  fs.writeFileSync(file, '{"version":1}\n');
  assert.throws(() => atomicWriteJSON(file, { version: 2 }, () => ({ errors: ['拒绝'] })), /拒绝/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"version":1}\n');
  assert.deepEqual(fs.readdirSync(dir), ['value.json']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadRepository rejects an index that disagrees with a day file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zaolangzhe-load-'));
  fs.mkdirSync(path.join(root, 'data', 'days'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'days', '2026-08-30.json'), JSON.stringify(dayFile('2026-08-30', { x: [tweet('one')] })));
  fs.writeFileSync(path.join(root, 'data', 'index.json'), JSON.stringify({
    schemaVersion: 2, generatedAt: '2026-08-30T07:00:00Z',
    days: [{ day: '2026-08-30', path: 'data/days/2026-08-30.json', counts: { x: 2, podcasts: 0, blogs: 0 } }],
  }));
  assert.throws(() => loadRepository(root, { now: NOW }), /计数不一致/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('requireAIText rejects empty model output before state can advance', () => {
  assert.throws(() => requireAIText('   ', '推文译文'), /推文译文为空/);
  assert.equal(requireAIText('  有效内容  ', '推文译文'), '有效内容');
});
