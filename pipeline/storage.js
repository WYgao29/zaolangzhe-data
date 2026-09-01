import fs from 'node:fs';
import path from 'node:path';

import {
  beijingDay,
  buildIndex,
  hasNonEmptyText,
  itemKey,
  mergeDuplicate,
  validateIndex,
} from './contract.js';
import { migrateDayFileToV3, validateV2Archive, validateV2Index } from './migrate-v3.js';

const DAY = 86400000;
const KINDS = ['x', 'podcasts', 'blogs'];

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function validateIndexPathsForRead(index) {
  if (!Array.isArray(index?.days)) throw new Error('index days 必须是数组');
  for (const entry of index.days) {
    if (entry?.path !== `data/days/${entry?.day}.json`) {
      throw new Error(`index 路径无效：${entry?.day || '未知日期'}`);
    }
  }
}

export function loadRepository(root, { migrateV2 = false, requireAllSummaries = false } = {}) {
  const indexPath = path.join(root, 'data', 'index.json');
  let index = readJSON(indexPath);
  if (migrateV2 && index.schemaVersion === 2) validateV2Index(index);
  validateIndexPathsForRead(index);
  const dayFiles = new Map();
  for (const entry of index.days || []) dayFiles.set(entry.day, readJSON(path.join(root, entry.path)));
  const migratedDays = new Set();
  if (migrateV2 && index.schemaVersion === 2) {
    validateV2Archive(index, dayFiles);
    for (const [day, file] of dayFiles) {
      const migrated = migrateDayFileToV3(file);
      dayFiles.set(day, migrated.file);
      if (migrated.changed) migratedDays.add(day);
    }
    index = buildIndex(dayFiles, index.generatedAt);
    requireAllSummaries = false;
  }
  const validation = validateIndex(index, dayFiles, { requireAllSummaries });
  if (validation.errors.length) throw new Error('数据仓校验失败:\n' + validation.errors.join('\n'));
  return { index, dayFiles, warnings: validation.warnings, migratedDays };
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
    schemaVersion: 3,
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

function missingSummary(item) {
  return !hasNonEmptyText(item.summaryZh);
}

export function buildWorkQueue(dayFiles, {
  addedKeys = new Set(), now = Date.now(), includeAllMissing = false, aiEnabled = false,
} = {}) {
  // AI 总结暂停。原队列代码保留，未来恢复时显式传入 aiEnabled: true。
  if (!aiEnabled) return { work: [], newCount: 0, selfHealCount: 0 };
  const cutoff = beijingDay(now - 2 * DAY);
  const work = [];
  let newCount = 0;
  let selfHealCount = 0;
  for (const [day, file] of dayFiles) {
    if (!includeAllMissing && day < cutoff) continue;
    for (const kind of KINDS) {
      for (const item of file[kind]) {
        const key = itemKey(kind, item);
        const isNew = addedKeys.has(key);
        if (!missingSummary(item)) continue;
        work.push({ kind, key, day, item });
        if (isNew) newCount++;
        else selfHealCount++;
      }
    }
  }
  return { work, newCount, selfHealCount };
}

export function writeRepository(root, dayFiles, generatedAt, changedDays = new Set(dayFiles.keys()), { requireAllSummaries = false } = {}) {
  const index = buildIndex(dayFiles, generatedAt);
  for (const day of changedDays) {
    const file = dayFiles.get(day);
    atomicWriteJSON(path.join(root, 'data', 'days', `${day}.json`), file, (value) => {
      const files = new Map(dayFiles);
      files.set(day, value);
      return validateIndex(buildIndex(files, generatedAt), files, { requireAllSummaries });
    });
  }
  atomicWriteJSON(path.join(root, 'data', 'index.json'), index, (value) => validateIndex(value, dayFiles, { requireAllSummaries }));
  return index;
}
