import test from 'node:test';
import assert from 'node:assert/strict';

import {
  beijingDay,
  buildIndex,
  dedupeItems,
  itemKey,
  validateDayFile,
  validateIndex,
} from '../pipeline/contract.js';

const NOW = Date.parse('2026-08-30T12:00:00Z');

function tweet(overrides = {}) {
  return {
    id: 'x-1', handle: 'builder', builder: 'Builder', bio: '',
    text: 'English', textZh: '中文', createdAt: '2026-08-30T01:00:00Z',
    url: 'https://x.com/builder/status/x-1', likes: 1, retweets: 2, replies: 3,
    ...overrides,
  };
}

function blog(overrides = {}) {
  return {
    url: 'https://example.com/post', name: 'Example', title: 'Title',
    titleZh: '标题', description: 'Description', summaryZh: '摘要',
    content: 'Body', contentZh: '正文', publishedAt: '2026-08-30T02:00:00Z',
    author: 'Author', ...overrides,
  };
}

function dayFile(day, overrides = {}) {
  return {
    schemaVersion: 2, day, generatedAt: '2026-08-30T06:55:52Z',
    x: [], podcasts: [], blogs: [], ...overrides,
  };
}

test('beijingDay uses Asia/Shanghai across the UTC date boundary', () => {
  assert.equal(beijingDay(Date.parse('2026-08-29T15:59:59Z')), '2026-08-29');
  assert.equal(beijingDay(Date.parse('2026-08-29T16:00:00Z')), '2026-08-30');
});

test('itemKey enforces stable keys for all content kinds', () => {
  assert.equal(itemKey('x', { id: '1' }), 'x:1');
  assert.equal(itemKey('podcasts', { guid: '2' }), 'pod:2');
  assert.equal(itemKey('blogs', { url: 'https://example.com' }), 'blog:https://example.com');
  assert.throws(() => itemKey('blogs', {}), /缺少唯一键/);
});

test('dedupeItems merges complementary duplicates and preserves richer translations', () => {
  const result = dedupeItems('blogs', [
    blog({ titleZh: '', summaryZh: '', contentZh: '', author: 'First author' }),
    blog({ titleZh: '中文标题', summaryZh: '中文摘要', contentZh: '', author: '' }),
    blog({ titleZh: '', summaryZh: '', contentZh: '完整中文正文', author: '' }),
  ]);
  assert.equal(result.items.length, 1);
  assert.equal(result.duplicates, 2);
  assert.deepEqual(
    {
      titleZh: result.items[0].titleZh,
      summaryZh: result.items[0].summaryZh,
      contentZh: result.items[0].contentZh,
      author: result.items[0].author,
    },
    { titleZh: '中文标题', summaryZh: '中文摘要', contentZh: '完整中文正文', author: 'First author' },
  );
});

test('validateDayFile rejects unsafe URLs and recent missing Chinese fields', () => {
  const value = dayFile('2026-08-30', {
    x: [tweet({ textZh: '', url: 'javascript:alert(1)' })],
    blogs: [blog({ contentZh: '' })],
  });
  const result = validateDayFile(value, { now: NOW });
  assert.ok(result.errors.some(x => x.includes('textZh')));
  assert.ok(result.errors.some(x => x.includes('http/https')));
  assert.ok(result.errors.some(x => x.includes('contentZh')));
});

test('validateDayFile warns rather than fails for old missing translations', () => {
  const value = dayFile('2026-08-20', { x: [tweet({ textZh: '' })] });
  const result = validateDayFile(value, { now: NOW });
  assert.equal(result.errors.length, 0);
  assert.ok(result.warnings.some(x => x.includes('textZh')));
});

test('validateDayFile can downgrade recent translation gaps during structural migration', () => {
  const value = dayFile('2026-08-30', { x: [tweet({ textZh: '' })] });
  const result = validateDayFile(value, { now: NOW, requireRecentTranslations: false });
  assert.equal(result.errors.length, 0);
  assert.ok(result.warnings.some(x => x.includes('textZh')));
});

test('buildIndex sorts days newest first and records literal counts', () => {
  const files = new Map([
    ['2026-08-29', dayFile('2026-08-29', { blogs: [blog()] })],
    ['2026-08-30', dayFile('2026-08-30', { x: [tweet()] })],
  ]);
  assert.deepEqual(buildIndex(files, '2026-08-30T07:00:00Z'), {
    schemaVersion: 2,
    generatedAt: '2026-08-30T07:00:00Z',
    days: [
      { day: '2026-08-30', path: 'data/days/2026-08-30.json', counts: { x: 1, podcasts: 0, blogs: 0 } },
      { day: '2026-08-29', path: 'data/days/2026-08-29.json', counts: { x: 0, podcasts: 0, blogs: 1 } },
    ],
  });
});

test('validateIndex rejects path traversal, count drift, and cross-day duplicates', () => {
  const files = new Map([
    ['2026-08-30', dayFile('2026-08-30', { x: [tweet()] })],
    ['2026-08-29', dayFile('2026-08-29', { x: [tweet()] })],
  ]);
  const index = buildIndex(files, '2026-08-30T07:00:00Z');
  index.days[0].path = '../secret.json';
  index.days[0].counts.x = 99;
  const result = validateIndex(index, files, { now: NOW });
  assert.ok(result.errors.some(x => x.includes('路径')));
  assert.ok(result.errors.some(x => x.includes('计数')));
  assert.ok(result.errors.some(x => x.includes('跨日重复')));
});
