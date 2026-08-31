import { itemKey, REMOVED_TRANSLATION_FIELDS } from './contract.js';

const KINDS = ['x', 'podcasts', 'blogs'];

export function migrateDayFileToV3(value) {
  const file = structuredClone(value);
  const missingSummaryKeys = [];
  file.schemaVersion = 3;
  for (const kind of KINDS) {
    for (const item of file[kind] || []) {
      for (const field of REMOVED_TRANSLATION_FIELDS) delete item[field];
      if (!String(item.summaryZh || '').trim()) missingSummaryKeys.push(itemKey(kind, item));
    }
  }
  return {
    file,
    changed: JSON.stringify(file) !== JSON.stringify(value),
    missingSummaryKeys,
  };
}
