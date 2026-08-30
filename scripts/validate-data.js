#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRepository } from '../pipeline/storage.js';

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(option('--root') || path.join(scriptDirectory, '..'));

try {
  const { index, warnings } = loadRepository(root);
  const counts = index.days.reduce((total, entry) => ({
    x: total.x + entry.counts.x,
    podcasts: total.podcasts + entry.counts.podcasts,
    blogs: total.blogs + entry.counts.blogs,
  }), { x: 0, podcasts: 0, blogs: 0 });

  for (const warning of warnings) console.log(`警告：${warning}`);
  console.log(
    `数据校验通过：${index.days.length} 天 · 推文 ${counts.x} · 播客 ${counts.podcasts} · 博客 ${counts.blogs} · 警告 ${warnings.length}`,
  );
} catch (error) {
  console.error(`数据校验失败：${error.message}`);
  process.exitCode = 1;
}
