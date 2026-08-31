import test from 'node:test';
import assert from 'node:assert/strict';

import { migrateLegacy } from '../pipeline/migrate-v2.js';

test('migrateLegacy flattens feeds by batch day and merges duplicate blog fields', () => {
  const result = migrateLegacy({
    generatedAt: '2026-08-30T07:00:00Z',
    xFeed: {
      generatedAt: '2026-08-30T06:00:00Z',
      x: [{ handle: 'alice', name: 'Alice', bio: 'Builder', tweets: [
        { id: 't1', text: 'Hello', textZh: '你好', createdAt: '2026-08-30T01:00:00Z', batchDay: '2026-08-30', url: 'https://x.com/alice/status/t1' },
      ] }],
    },
    podcastFeed: {
      podcasts: [{ guid: 'p1', name: 'Show', title: 'Episode', titleZh: '单集', summaryZh: '摘要', transcript: 'Text', publishedAt: '2026-08-29', batchDay: '2026-08-29', url: 'https://example.com/p1' }],
    },
    blogFeed: {
      blogs: [
        { url: 'https://example.com/blog', name: 'Blog', title: 'Post', author: 'Alice', content: 'Body', batchDay: '2026-08-28' },
        { url: 'https://example.com/blog', name: 'Blog', title: 'Post', titleZh: '文章', summaryZh: '摘要', content: 'Body', contentZh: '正文', batchDay: '2026-08-28' },
      ],
    },
  });

  assert.deepEqual([...result.dayFiles.keys()].sort(), ['2026-08-28', '2026-08-29', '2026-08-30']);
  const migratedTweet = result.dayFiles.get('2026-08-30').x[0];
  assert.equal(migratedTweet.handle, 'alice');
  assert.equal(migratedTweet.builder, 'Alice');
  assert.equal(migratedTweet.bio, 'Builder');
  assert.equal('batchDay' in migratedTweet, false);

  const blogs = result.dayFiles.get('2026-08-28').blogs;
  assert.equal(blogs.length, 1);
  assert.equal(blogs[0].author, 'Alice');
  assert.equal(blogs[0].titleZh, '文章');
  assert.equal(blogs[0].summaryZh, '摘要');
  assert.equal(blogs[0].contentZh, '正文');
  assert.equal(result.duplicates.blogs, 1);
  assert.deepEqual(result.index.days.map(x => x.day), ['2026-08-30', '2026-08-29', '2026-08-28']);
  assert.deepEqual(result.index.days[2].counts, { x: 0, podcasts: 0, blogs: 1 });
});

test('migrateLegacy rejects items without a valid batch day', () => {
  assert.throws(() => migrateLegacy({
    generatedAt: '2026-08-30T07:00:00Z',
    xFeed: { x: [{ handle: 'alice', tweets: [{ id: 'bad', text: 'x' }] }] },
    podcastFeed: { podcasts: [] },
    blogFeed: { blogs: [] },
  }), /缺少有效 batchDay/);
});
