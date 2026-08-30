import fs from 'node:fs';
import path from 'node:path';

import {
  beijingDay,
  buildIndex,
  itemKey,
  mergeDuplicate,
  validateIndex,
} from './contract.js';

const DAY = 86400000;
const KINDS = ['x', 'podcasts', 'blogs'];

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function loadRepository(root, { now = Date.now(), requireRecentTranslations = true } = {}) {
  const indexPath = path.join(root, 'data', 'index.json');
  const index = readJSON(indexPath);
  const dayFiles = new Map();
  for (const entry of index.days || []) dayFiles.set(entry.day, readJSON(path.join(root, entry.path)));
  const validation = validateIndex(index, dayFiles, { now, requireRecentTranslations });
  if (validation.errors.length) throw new Error('数据仓校验失败:\n' + validation.errors.join('\n'));
  return { index, dayFiles, warnings: validation.warnings };
}

export function atomicWriteJSON(file, value, validate = () => ({ errors: [] })) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, file.endsWith('index.json') ? 2 : 0) + '\n');
    const parsed = readJSON(temp);
    const result = validate(parsed) || { errors: [] };
    if (result.errors?.length) throw new Error(result.errors.join('\n'));
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function buildLocationIndex(dayFiles) {
  const locations = new Map();
  for (const [day, file] of dayFiles) {
    for (const kind of KINDS) {
      for (let index = 0; index < file[kind].length; index++) {
        locations.set(itemKey(kind, file[kind][index]), { day, file, kind, index });
      }
    }
  }
  return locations;
}

export function mergeIncoming(dayFiles, incoming) {
  const locations = buildLocationIndex(dayFiles);
  const addedKeys = new Set();
  const changedDays = new Set();
  let duplicates = 0;
  if (!dayFiles.has(incoming.day)) dayFiles.set(incoming.day, {
    schemaVersion: 2,
    day: incoming.day,
    generatedAt: incoming.generatedAt,
    x: [], podcasts: [], blogs: [],
  });
  const target = dayFiles.get(incoming.day);
  for (const kind of KINDS) {
    for (const item of incoming[kind] || []) {
      const key = itemKey(kind, item);
      const existing = locations.get(key);
      if (existing) {
        const current = existing.file[kind][existing.index];
        const merged = mergeDuplicate(kind, current, item);
        if (JSON.stringify(merged) !== JSON.stringify(current)) {
          existing.file[kind][existing.index] = merged;
          existing.file.generatedAt = incoming.generatedAt;
          changedDays.add(existing.day);
        }
        duplicates++;
        continue;
      }
      target[kind].push({ ...item });
      locations.set(key, { day: incoming.day, file: target, kind, index: target[kind].length - 1 });
      addedKeys.add(key);
      changedDays.add(incoming.day);
    }
  }
  if (changedDays.has(incoming.day)) target.generatedAt = incoming.generatedAt;
  return { addedKeys, changedDays, duplicates };
}

function missingTranslation(kind, item) {
  if (kind === 'x') return !String(item.textZh || '').trim();
  if (kind === 'podcasts') return !String(item.titleZh || '').trim() || !String(item.summaryZh || '').trim();
  return !String(item.titleZh || '').trim()
    || !String(item.summaryZh || '').trim()
    || (!!String(item.content || '').trim() && !String(item.contentZh || '').trim());
}

export function buildWorkQueue(dayFiles, { addedKeys = new Set(), now = Date.now() } = {}) {
  const cutoff = beijingDay(now - 2 * DAY);
  const work = [];
  let newCount = 0;
  let selfHealCount = 0;
  for (const [day, file] of dayFiles) {
    if (day < cutoff) continue;
    for (const kind of KINDS) {
      for (const item of file[kind]) {
        const key = itemKey(kind, item);
        const isNew = addedKeys.has(key);
        if (!isNew && !missingTranslation(kind, item)) continue;
        work.push({ kind, key, day, item });
        if (isNew) newCount++;
        else selfHealCount++;
      }
    }
  }
  return { work, newCount, selfHealCount };
}

export function writeRepository(root, dayFiles, generatedAt, changedDays = new Set(dayFiles.keys()), { now = Date.now(), requireRecentTranslations = true } = {}) {
  const index = buildIndex(dayFiles, generatedAt);
  for (const day of changedDays) {
    const file = dayFiles.get(day);
    atomicWriteJSON(path.join(root, 'data', 'days', `${day}.json`), file, (value) => {
      const files = new Map(dayFiles);
      files.set(day, value);
      return validateIndex(buildIndex(files, generatedAt), files, { now, requireRecentTranslations });
    });
  }
  atomicWriteJSON(path.join(root, 'data', 'index.json'), index, (value) => validateIndex(value, dayFiles, { now, requireRecentTranslations }));
  return index;
}
