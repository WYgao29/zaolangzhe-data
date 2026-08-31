#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildIndex, dedupeItems, itemKey, mergeDuplicate, validateIndex } from './contract.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function withoutBatchDay(item) {
  const copy = { ...item };
  delete copy.batchDay;
  return copy;
}

function collectGlobal(kind, items) {
  const map = new Map();
  let duplicates = 0;
  for (const item of items) {
    if (!DAY_RE.test(item.batchDay || '')) throw new Error(`${kind} ${itemKey(kind, item)} 缺少有效 batchDay`);
    const key = itemKey(kind, item);
    if (map.has(key)) {
      duplicates++;
      map.set(key, mergeDuplicate(kind, map.get(key), item));
    } else map.set(key, { ...item });
  }
  return { items: [...map.values()], duplicates };
}

export function migrateLegacy({ xFeed, podcastFeed, blogFeed, generatedAt }) {
  const flattenedX = [];
  for (const builder of xFeed?.x || []) {
    for (const raw of builder.tweets || []) {
      flattenedX.push({
        ...raw,
        handle: raw.handle || builder.handle,
        builder: raw.builder || builder.name || builder.handle,
        bio: raw.bio || builder.bio || '',
      });
    }
  }
  const source = {
    x: collectGlobal('x', flattenedX),
    podcasts: collectGlobal('podcasts', podcastFeed?.podcasts || []),
    blogs: collectGlobal('blogs', blogFeed?.blogs || []),
  };
  const dayFiles = new Map();
  const ensureDay = (day) => {
    if (!dayFiles.has(day)) dayFiles.set(day, {
      schemaVersion: 2, day, generatedAt,
      x: [], podcasts: [], blogs: [],
    });
    return dayFiles.get(day);
  };
  for (const kind of ['x', 'podcasts', 'blogs']) {
    for (const item of source[kind].items) ensureDay(item.batchDay)[kind].push(withoutBatchDay(item));
    for (const file of dayFiles.values()) file[kind] = dedupeItems(kind, file[kind]).items;
  }
  const index = buildIndex(dayFiles, generatedAt);
  return {
    index,
    dayFiles,
    duplicates: {
      x: source.x.duplicates,
      podcasts: source.podcasts.duplicates,
      blogs: source.blogs.duplicates,
    },
  };
}

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadV2(root) {
  const index = readJSON(path.join(root, 'data', 'index.json'));
  const dayFiles = new Map(index.days.map(entry => [entry.day, readJSON(path.join(root, entry.path))]));
  return { index, dayFiles };
}

function validateOrThrow(index, dayFiles, options) {
  const result = validateIndex(index, dayFiles, options);
  if (result.errors.length) throw new Error('v2 校验失败:\n' + result.errors.join('\n'));
  return result;
}

function writeV2Atomically(root, migration) {
  const tempRoot = path.join(root, `.data-v2-${process.pid}`);
  const tempData = path.join(tempRoot, 'data');
  const backup = path.join(root, `.data-v1-backup-${process.pid}`);
  fs.rmSync(tempRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(tempData, 'days'), { recursive: true });
  try {
    for (const [day, value] of migration.dayFiles) {
      fs.writeFileSync(path.join(tempData, 'days', `${day}.json`), JSON.stringify(value));
    }
    fs.writeFileSync(path.join(tempData, 'index.json'), JSON.stringify(migration.index, null, 2) + '\n');
    const check = loadV2(tempRoot);
    validateOrThrow(check.index, check.dayFiles, { requireRecentTranslations: false });

    fs.renameSync(path.join(root, 'data'), backup);
    try {
      fs.renameSync(tempData, path.join(root, 'data'));
    } catch (error) {
      fs.renameSync(backup, path.join(root, 'data'));
      throw error;
    }
    fs.rmSync(backup, { recursive: true, force: true });
    fs.rmSync(path.join(root, 'digest'), { recursive: true, force: true });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    if (fs.existsSync(backup) && !fs.existsSync(path.join(root, 'data'))) fs.renameSync(backup, path.join(root, 'data'));
  }
}

function cli() {
  if (process.argv.includes('--check-v2')) {
    const repository = loadV2(ROOT);
    const result = validateOrThrow(repository.index, repository.dayFiles, { requireRecentTranslations: false });
    console.log(`v2 校验通过：${repository.index.days.length} 天，警告 ${result.warnings.length}`);
    for (const warning of result.warnings) console.log('  ⚠ ' + warning);
    return;
  }
  const xFeed = readJSON(path.join(ROOT, 'data', 'feed-x.json'));
  const podcastFeed = readJSON(path.join(ROOT, 'data', 'feed-podcasts.json'));
  const blogFeed = readJSON(path.join(ROOT, 'data', 'feed-blogs.json'));
  const generatedAt = [xFeed.generatedAt, podcastFeed.generatedAt, blogFeed.generatedAt]
    .filter(Boolean).sort().at(-1) || new Date().toISOString();
  const migration = migrateLegacy({ xFeed, podcastFeed, blogFeed, generatedAt });
  validateOrThrow(migration.index, migration.dayFiles, { requireRecentTranslations: false });
  console.log(`迁移预检：${migration.index.days.length} 天，重复 { x ${migration.duplicates.x} / podcast ${migration.duplicates.podcasts} / blog ${migration.duplicates.blogs} }`);
  if (process.argv.includes('--check')) return;
  writeV2Atomically(ROOT, migration);
  console.log('v2 数据迁移完成');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { cli(); }
  catch (error) { console.error(error.message || error); process.exit(1); }
}
