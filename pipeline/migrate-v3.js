import { hasNonEmptyText, isSafeHTTPURL, itemKey, REMOVED_TRANSLATION_FIELDS } from './contract.js';

const KINDS = ['x', 'podcasts', 'blogs'];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validateV2Index(index) {
  if (!index || typeof index !== 'object' || index.schemaVersion !== 2) {
    throw new Error('v2 index 版本无效');
  }
  if (!Array.isArray(index.days) || index.days.length === 0) throw new Error('v2 index days 不得为空');
  const seen = new Set();
  let previous = null;
  for (const entry of index.days) {
    if (!DAY_RE.test(entry?.day || '') || entry.path !== `data/days/${entry.day}.json`) {
      throw new Error(`v2 index 路径无效：${entry?.day || '未知日期'}`);
    }
    if (seen.has(entry.day)) throw new Error(`v2 index 日期重复：${entry.day}`);
    if (previous && entry.day >= previous) throw new Error('v2 index days 必须从新到旧排序');
    for (const kind of KINDS) {
      if (!Number.isInteger(entry.counts?.[kind]) || entry.counts[kind] < 0) {
        throw new Error(`v2 index 计数无效：${entry.day} ${kind}`);
      }
    }
    seen.add(entry.day);
    previous = entry.day;
  }
  return index;
}

export function validateV2Archive(index, dayFiles) {
  validateV2Index(index);
  for (const entry of index.days) {
    const file = dayFiles.get(entry.day);
    if (!file) throw new Error(`v2 ${entry.day} 缺少日分片`);
    if (file.schemaVersion !== 2) throw new Error(`v2 ${entry.day} 分片版本必须为 2`);
    if (file.day !== entry.day) throw new Error(`v2 ${entry.day} 分片日期不一致`);
    for (const kind of KINDS) {
      if (!Array.isArray(file[kind])) throw new Error(`v2 ${entry.day} ${kind} 必须是数组`);
      if (file[kind].length !== entry.counts[kind]) throw new Error(`v2 ${entry.day} ${kind} 计数不一致`);
      for (const item of file[kind]) {
        itemKey(kind, item);
        if (item.url && !isSafeHTTPURL(item.url)) throw new Error(`v2 ${entry.day} ${kind} 包含不安全链接`);
      }
    }
  }
  return { index, dayFiles };
}

export function migrateDayFileToV3(value) {
  const file = structuredClone(value);
  const missingSummaryKeys = [];
  file.schemaVersion = 3;
  for (const kind of KINDS) {
    for (const item of file[kind] || []) {
      for (const field of REMOVED_TRANSLATION_FIELDS) delete item[field];
      if (!hasNonEmptyText(item.summaryZh)) missingSummaryKeys.push(itemKey(kind, item));
    }
  }
  return {
    file,
    changed: JSON.stringify(file) !== JSON.stringify(value),
    missingSummaryKeys,
  };
}
