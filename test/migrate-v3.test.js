import test from 'node:test';
import assert from 'node:assert/strict';

import { migrateDayFileToV3 } from '../pipeline/migrate-v3.js';

test('migrateDayFileToV3 strips translations and preserves summaries', () => {
  const source = {
    schemaVersion: 2,
    day: '2026-08-30',
    generatedAt: '2026-08-30T06:55:52Z',
    x: [{
      id: 'x-1', handle: 'builder', builder: 'Builder', text: 'English', textZh: '译文',
      createdAt: '2026-08-30T01:00:00Z', url: 'https://x.com/builder/status/x-1',
    }],
    podcasts: [{
      guid: 'p-1', name: 'Show', title: 'Title', titleZh: '标题',
      transcript: 'Original', transcriptZh: '转录翻译', summaryZh: '播客总结',
    }],
    blogs: [{
      url: 'https://example.com/post', name: 'Blog', title: 'Post', titleZh: '标题',
      content: 'Body', contentZh: '全文翻译', summaryZh: '博客总结',
    }],
  };

  const result = migrateDayFileToV3(source);

  assert.equal(result.file.schemaVersion, 3);
  assert.equal(result.file.x[0].textZh, undefined);
  assert.equal(result.file.x[0].summaryZh, undefined);
  assert.equal(result.file.podcasts[0].titleZh, undefined);
  assert.equal(result.file.podcasts[0].transcriptZh, undefined);
  assert.equal(result.file.podcasts[0].summaryZh, '播客总结');
  assert.equal(result.file.blogs[0].titleZh, undefined);
  assert.equal(result.file.blogs[0].contentZh, undefined);
  assert.equal(result.file.blogs[0].summaryZh, '博客总结');
  assert.equal(result.changed, true);
  assert.deepEqual(result.missingSummaryKeys, ['x:x-1']);
  assert.equal(source.schemaVersion, 2, '迁移不得修改输入对象');
});

test('migrateDayFileToV3 is stable for an existing v3 shard', () => {
  const source = {
    schemaVersion: 3,
    day: '2026-08-30',
    generatedAt: '2026-08-30T06:55:52Z',
    x: [{ id: 'x-1', text: 'English', summaryZh: '总结' }],
    podcasts: [],
    blogs: [],
  };

  const result = migrateDayFileToV3(source);

  assert.deepEqual(result.file, source);
  assert.equal(result.changed, false);
  assert.deepEqual(result.missingSummaryKeys, []);
});

test('migrateDayFileToV3 treats non-string summaries as missing', () => {
  const source = {
    schemaVersion: 2,
    day: '2026-08-30',
    generatedAt: '2026-08-30T06:55:52Z',
    x: [{ id: 'x-1', text: 'English', summaryZh: { translated: true } }],
    podcasts: [],
    blogs: [],
  };

  const result = migrateDayFileToV3(source);

  assert.deepEqual(result.missingSummaryKeys, ['x:x-1']);
});
