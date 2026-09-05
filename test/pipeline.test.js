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
  writeRepository,
} from '../pipeline/storage.js';
import {
  archiveUpstreamSnapshots,
  processBlog,
  processPodcast,
  processTweet,
  requireAIText,
} from '../pipeline/process.js';
import * as Process from '../pipeline/process.js';

const NOW = Date.parse('2026-08-30T12:00:00Z');

function tweet(id, summaryZh = '中文总结') {
  return { id, handle: 'a', builder: 'A', bio: '', text: `tweet ${id}`, summaryZh, createdAt: '2026-08-30T01:00:00Z', url: `https://x.com/a/status/${id}` };
}

function dayFile(day, overrides = {}) {
  return { schemaVersion: 3, day, generatedAt: '2026-08-30T07:00:00Z', x: [], podcasts: [], blogs: [], ...overrides };
}

function writeRepositoryFixture(root, indexValue, dayValue) {
  fs.mkdirSync(path.join(root, 'data', 'days'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'index.json'), JSON.stringify(indexValue));
  if (dayValue) fs.writeFileSync(path.join(root, 'data', 'days', `${dayValue.day}.json`), JSON.stringify(dayValue));
}

test('mergeIncoming adds new keys and preserves an existing summary', () => {
  const days = new Map([['2026-08-30', dayFile('2026-08-30', { x: [tweet('existing', '已有总结')] })]]);
  const result = mergeIncoming(days, {
    day: '2026-08-30', generatedAt: '2026-08-30T08:00:00Z',
    x: [tweet('existing', ''), tweet('new', '')], podcasts: [], blogs: [],
  });
  assert.equal(result.addedKeys.size, 1);
  assert.equal(result.addedKeys.has('x:new'), true);
  assert.equal(result.duplicates, 1);
  assert.equal(days.get('2026-08-30').x.length, 2);
  assert.equal(days.get('2026-08-30').x.find(x => x.id === 'existing').summaryZh, '已有总结');
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

test('buildWorkQueue includes new items and recent summary gaps exactly once', () => {
  const days = new Map([
    ['2026-08-30', dayFile('2026-08-30', { x: [tweet('new', ''), tweet('missing', '')] })],
    ['2026-08-20', dayFile('2026-08-20', { x: [tweet('old-missing', '')] })],
  ]);
  const result = buildWorkQueue(days, { addedKeys: new Set(['x:new']), now: NOW, aiEnabled: true });
  assert.deepEqual(result.work.map(x => x.key).sort(), ['x:missing', 'x:new']);
  assert.equal(result.newCount, 1);
  assert.equal(result.selfHealCount, 1);
});

test('buildWorkQueue does not spend AI tokens on a new item that already has a summary', () => {
  const days = new Map([
    ['2026-08-30', dayFile('2026-08-30', { x: [tweet('already-summarized')] })],
  ]);
  const result = buildWorkQueue(days, { addedKeys: new Set(['x:already-summarized']), now: NOW, aiEnabled: true });
  assert.equal(result.work.length, 0);
  assert.equal(result.newCount, 0);
});

test('v3 migration queues old missing summaries when includeAllMissing is true', () => {
  const files = new Map([
    ['2026-01-01', dayFile('2026-01-01', { x: [tweet('old', '')] })],
  ]);
  const normal = buildWorkQueue(files, { now: NOW, includeAllMissing: false, aiEnabled: true });
  const migration = buildWorkQueue(files, { now: NOW, includeAllMissing: true, aiEnabled: true });
  assert.equal(normal.work.length, 0);
  assert.deepEqual(migration.work.map(entry => entry.key), ['x:old']);
});

test('buildWorkQueue leaves missing summaries untouched when AI is paused', () => {
  const days = new Map([
    ['2026-08-30', dayFile('2026-08-30', { x: [tweet('english-only', '')] })],
  ]);
  const result = buildWorkQueue(days, { addedKeys: new Set(['x:english-only']), now: NOW });
  assert.deepEqual(result, { work: [], newCount: 0, selfHealCount: 0 });
  assert.equal(days.get('2026-08-30').x[0].text, 'tweet english-only');
  assert.equal(days.get('2026-08-30').x[0].summaryZh, '');
});

test('AI restore mode is explicit, strict, and can include the full missing backlog', () => {
  assert.deepEqual(Process.resolveAIMode([], {}), {
    enabled: false,
    includeAllMissing: false,
    requireAllSummaries: false,
  });
  assert.deepEqual(Process.resolveAIMode(
    ['--include-all-missing'],
    { AI_PROCESSING_ENABLED: 'true' },
  ), {
    enabled: true,
    includeAllMissing: true,
    requireAllSummaries: true,
  });
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
    schemaVersion: 3, generatedAt: '2026-08-30T07:00:00Z',
    days: [{ day: '2026-08-30', path: 'data/days/2026-08-30.json', counts: { x: 2, podcasts: 0, blogs: 0 } }],
  }));
  assert.throws(() => loadRepository(root, { now: NOW }), /计数不一致/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('loadRepository migrates v2 shards in memory only when explicitly enabled', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zaolangzhe-migrate-v3-'));
  fs.mkdirSync(path.join(root, 'data', 'days'), { recursive: true });
  const legacyDay = {
    ...dayFile('2026-08-30', { x: [{ ...tweet('one', ''), textZh: '旧译文' }] }),
    schemaVersion: 2,
  };
  fs.writeFileSync(path.join(root, 'data', 'days', '2026-08-30.json'), JSON.stringify(legacyDay));
  fs.writeFileSync(path.join(root, 'data', 'index.json'), JSON.stringify({
    schemaVersion: 2, generatedAt: legacyDay.generatedAt,
    days: [{ day: legacyDay.day, path: 'data/days/2026-08-30.json', counts: { x: 1, podcasts: 0, blogs: 0 } }],
  }));

  assert.throws(() => loadRepository(root), /schemaVersion 必须为 3/);
  const migrated = loadRepository(root, { migrateV2: true });
  assert.equal(migrated.index.schemaVersion, 3);
  assert.deepEqual([...migrated.migratedDays], ['2026-08-30']);
  assert.equal(migrated.dayFiles.get('2026-08-30').x[0].textZh, undefined);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'data', 'index.json'))).schemaVersion, 2, '加载迁移不得提前写盘');
  fs.rmSync(root, { recursive: true, force: true });
});

test('loadRepository refuses to migrate mixed or unsupported shard versions under a v2 index', () => {
  for (const shardVersion of [3, 4]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zaolangzhe-mixed-v2-'));
    const shard = { ...dayFile('2026-08-30', { x: [tweet('one')] }), schemaVersion: shardVersion };
    writeRepositoryFixture(root, {
      schemaVersion: 2,
      generatedAt: shard.generatedAt,
      days: [{ day: shard.day, path: `data/days/${shard.day}.json`, counts: { x: 1, podcasts: 0, blogs: 0 } }],
    }, shard);

    assert.throws(() => loadRepository(root, { migrateV2: true }), /v2.*版本|版本.*v2/);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loadRepository rejects an invalid v2 shard path before reading it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zaolangzhe-path-v2-'));
  writeRepositoryFixture(root, {
    schemaVersion: 2,
    generatedAt: '2026-08-30T07:00:00Z',
    days: [{ day: '2026-08-30', path: '../secret.json', counts: { x: 0, podcasts: 0, blogs: 0 } }],
  });

  assert.throws(() => loadRepository(root, { migrateV2: true }), /路径/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('loadRepository rejects an invalid v3 shard path before reading it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zaolangzhe-path-v3-'));
  writeRepositoryFixture(root, {
    schemaVersion: 3,
    generatedAt: '2026-08-30T07:00:00Z',
    days: [{ day: '2026-08-30', path: '../secret.json', counts: { x: 0, podcasts: 0, blogs: 0 } }],
  });

  assert.throws(() => loadRepository(root), /路径/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('loadRepository rejects index day keys that are not calendar dates', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zaolangzhe-daykey-'));
  fs.mkdirSync(path.join(root, 'data', 'days'), { recursive: true });
  // day 键 "../outside" 与 path "data/days/../outside.json" 互相印证时，
  // 读文件会落到 data/days 之外（path.join 规范化后为 data/outside.json）；
  // day 键必须是日历日。
  fs.writeFileSync(path.join(root, 'data', 'outside.json'), JSON.stringify(dayFile('2026-08-30', { x: [tweet('one')] })));
  fs.writeFileSync(path.join(root, 'data', 'index.json'), JSON.stringify({
    schemaVersion: 3, generatedAt: '2026-08-30T07:00:00Z',
    days: [{ day: '../outside', path: 'data/days/../outside.json', counts: { x: 1, podcasts: 0, blogs: 0 } }],
  }));

  assert.throws(() => loadRepository(root), /路径无效|日期/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('writeRepository refuses non-calendar day keys before touching the filesystem', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zaolangzhe-writeday-'));
  const dayFiles = new Map([['../evil', dayFile('../evil', { x: [] })]]);
  assert.throws(
    () => writeRepository(root, dayFiles, '2026-09-04T08:00:00Z', new Set(['../evil'])),
    /非日历日/,
  );
  assert.equal(fs.existsSync(path.join(root, 'data')), false, '拒绝时不得创建任何目录或文件');
  fs.rmSync(root, { recursive: true, force: true });
});

test('archiveUpstreamSnapshots replays historical snapshots and merges upstream content', async () => {
  const repository = { dayFiles: new Map() };
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    json: async () => {
      if (url.includes('api.github.com')) {
        return [{ sha: 'abc123def', commit: { author: { date: '2026-09-04T06:00:00Z' } } }];
      }
      // 上游每个 feed 文件是独立结构：feed-x.json = { generatedAt, x: [...] }
      if (url.endsWith('feed-x.json')) {
        return { generatedAt: '2026-09-04T06:00:00Z', x: [{ handle: 'a', name: 'A', bio: '', tweets: [{ id: 't1', text: 'hello world', createdAt: '2026-09-04T01:00:00Z', url: 'https://x.com/a/status/t1', handle: 'a' }] }] };
      }
      if (url.endsWith('feed-podcasts.json')) return { generatedAt: '2026-09-04T06:00:00Z', podcasts: [] };
      return { generatedAt: '2026-09-04T06:00:00Z', blogs: [] };
    },
    text: async () => '',
  });

  const result = await archiveUpstreamSnapshots(repository, { backfillDays: 2, fetchImpl, log: () => {} });

  assert.equal(result.fetched, 1);
  assert.equal(result.addedKeys.has('x:t1'), true);
  assert.equal(result.changedDays.has('2026-09-04'), true);
  const day = repository.dayFiles.get('2026-09-04');
  assert.equal(day.x.length, 1);
  assert.equal(day.x[0].id, 't1');
  assert.equal(day.x[0].handle, 'a', 'flattenSnapshot 需回填构建者信息');
  assert.equal(day.schemaVersion, 3);
});

test('splitIntoChunks splits long text at paragraph boundaries with a hard cap', async () => {
  const { splitIntoChunks } = await import('../pipeline/process.js');

  assert.deepEqual(splitIntoChunks('短文本'), ['短文本'], '不超限不分段');
  assert.equal(splitIntoChunks('').length, 1);

  // 带换行的长文本：优先在换行处切，每段不超上限
  const withNewlines = Array.from({ length: 8 }, (_, i) => `第${i}段\n${'x'.repeat(20000)}`).join('\n');
  const chunks = splitIntoChunks(withNewlines);
  assert.equal(chunks.join('').replace(/\n/g, '').length, withNewlines.replace(/\n/g, '').length, '内容不丢失');
  for (const chunk of chunks) assert.ok(chunk.length <= 60000, `每段 ${chunk.length} 应 ≤ 60000`);

  // 无换行的超长文本：硬切
  const noNewline = 'y'.repeat(150000);
  const hard = splitIntoChunks(noNewline);
  assert.equal(hard.length, 3);
  assert.equal(hard.join('').length, 150000, '硬切不丢字符');

  // 超过段数上限：明确报错而非静默丢弃
  const huge = 'z'.repeat(60000 * 25 + 1);
  assert.throws(() => splitIntoChunks(huge), /超过.*段上限/);
});

test('processPodcast segments oversized transcripts instead of truncating', async () => {
  // 130000 字符转录（旧逻辑会在 60000 处截断丢内容）→ 应分 3 段 map + 1 次 reduce
  const part = 'Episode discussion point with details. '.repeat(3400); // ~130k
  const item = { title: 'Long Episode', transcript: part };
  const calls = [];
  const aiCall = async (messages) => {
    calls.push(messages);
    if (calls.length <= 3) return `第${calls.length}段要点：讨论了 AI 安全话题。`;
    return '{"summaryZh":"整合后的完整中文总结。"}';
  };
  await processPodcast(item, aiCall);

  assert.equal(calls.length, 4, '3 次分段 + 1 次汇总');
  const joined = calls.slice(0, 3).map(c => c[1].content).join('');
  assert.ok(joined.includes(part.slice(0, 1000)), '分段请求应覆盖转录开头');
  assert.ok(joined.includes(part.slice(-1000)), '分段请求应覆盖转录结尾（不再截断丢弃）');
  assert.match(calls[3][0].content, /整合|要点/);
  assert.equal(item.summaryZh, '整合后的完整中文总结。');
});

test('processBlog segments oversized articles instead of truncating', async () => {
  const content = 'Long-form article paragraph. '.repeat(5000); // ~145k
  const item = { title: 'Long Post', content };
  const calls = [];
  const aiCall = async (messages) => {
    calls.push(messages);
    if (calls.length <= 3) return `第${calls.length}段要点：核心结论。`;
    return '{"summaryZh":"整合后的文章总结。"}';
  };
  await processBlog(item, aiCall);
  assert.equal(calls.length, 4);
  const joined = calls.slice(0, 3).map(c => c[1].content).join('');
  assert.ok(joined.includes(content.slice(-1000)), '文章结尾不再被截断');
  assert.equal(item.summaryZh, '整合后的文章总结。');
});

test('processTweet segments rare oversized long-form posts', async () => {
  const text = 'Long-form X post. '.repeat(9000); // ~162k → 3 段
  const item = { text };
  const calls = [];
  const aiCall = async (messages) => {
    calls.push(messages);
    if (calls.length <= 3) return `第${calls.length}段要点。`;
    return '整合后的长文推文总结。';
  };
  await processTweet(item, aiCall);
  assert.equal(calls.length, 4);
  assert.equal(item.summaryZh, '整合后的长文推文总结。');
  assert.doesNotMatch(item.summaryZh, /^\{/, '长文推文汇总走纯文本而非 JSON');
});

test('requireAIText rejects empty model output before state can advance', () => {
  assert.throws(() => requireAIText('   ', '推文总结'), /推文总结为空/);
  assert.throws(() => requireAIText({ value: '伪总结' }, '推文总结'), /推文总结为空/);
  assert.equal(requireAIText('  有效内容  ', '推文总结'), '有效内容');
});

test('tweet processing stores a semantic summary instead of a translation', async () => {
  const calls = [];
  const item = { text: 'We shipped a faster model today.' };
  await processTweet(item, async (messages) => {
    calls.push(messages);
    return '团队发布了速度更快的新模型。';
  });
  assert.equal(item.summaryZh, '团队发布了速度更快的新模型。');
  assert.equal(item.textZh, undefined);
  assert.match(calls[0][0].content, /总结/);
  assert.match(calls[0][0].content, /不要逐句翻译/);
});

test('podcast processing keeps only the Chinese summary', async () => {
  const item = { title: 'Episode', transcript: 'English transcript' };
  await processPodcast(item, async () => '{"summaryZh":"本期讨论模型发布及其影响。"}');
  assert.equal(item.summaryZh, '本期讨论模型发布及其影响。');
  assert.equal(item.titleZh, undefined);
});

test('blog processing makes one summary request and never writes a full translation', async () => {
  const calls = [];
  const item = { title: 'Post', content: 'Long English body' };
  await processBlog(item, async (messages) => {
    calls.push(messages);
    return '{"summaryZh":"文章概括了核心发布内容。"}';
  });
  assert.equal(item.summaryZh, '文章概括了核心发布内容。');
  assert.equal(item.contentZh, undefined);
  assert.equal(item.titleZh, undefined);
  assert.equal(calls.length, 1);
});

test('blog processing replaces a non-string summary instead of skipping AI', async () => {
  const item = { title: 'Post', content: 'Long English body', summaryZh: { invalid: true } };
  let calls = 0;
  await processBlog(item, async () => {
    calls++;
    return '{"summaryZh":"有效的中文总结。"}';
  });
  assert.equal(calls, 1);
  assert.equal(item.summaryZh, '有效的中文总结。');
});
