const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = ['x', 'podcasts', 'blogs'];
const STRICT_TEXT_FIELDS = new Set(['summaryZh', 'text', 'title', 'transcript', 'content']);
export const REMOVED_TRANSLATION_FIELDS = ['textZh', 'titleZh', 'contentZh', 'transcriptZh'];

export function beijingDay(ms) {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) throw new Error('无效时间');
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

export function itemKey(kind, item) {
  const raw = kind === 'x' ? item?.id : kind === 'podcasts' ? item?.guid : kind === 'blogs' ? item?.url : null;
  if (raw == null || String(raw).trim() === '') throw new Error(`${kind} 条目缺少唯一键`);
  const prefix = kind === 'x' ? 'x:' : kind === 'podcasts' ? 'pod:' : 'blog:';
  return prefix + String(raw);
}

function hasValue(value) {
  return value !== undefined && value !== null && (typeof value !== 'string' || value.trim() !== '');
}

export function hasNonEmptyText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function fieldHasValue(field, value) {
  return STRICT_TEXT_FIELDS.has(field) ? hasNonEmptyText(value) : hasValue(value);
}

export function richnessScore(kind, item) {
  const zhFields = ['summaryZh'];
  const contentFields = kind === 'x' ? ['text'] : kind === 'podcasts' ? ['title', 'transcript'] : ['title', 'content'];
  return zhFields.reduce((n, field) => n + (fieldHasValue(field, item?.[field]) ? 10 : 0), 0)
    + contentFields.reduce((n, field) => n + (fieldHasValue(field, item?.[field]) ? 2 : 0), 0)
    + Object.values(item || {}).reduce((n, value) => n + (hasValue(value) ? 1 : 0), 0);
}

export function mergeDuplicate(kind, older, newer) {
  const preferred = richnessScore(kind, newer) >= richnessScore(kind, older) ? newer : older;
  const fallback = preferred === newer ? older : newer;
  const merged = { ...fallback, ...preferred };
  for (const field of new Set([...Object.keys(fallback || {}), ...Object.keys(preferred || {})])) {
    if (!fieldHasValue(field, merged[field]) && fieldHasValue(field, fallback[field])) merged[field] = fallback[field];
    if (!fieldHasValue(field, merged[field]) && fieldHasValue(field, preferred[field])) merged[field] = preferred[field];
  }
  return merged;
}

export function dedupeItems(kind, items) {
  const map = new Map();
  let duplicates = 0;
  for (const item of items || []) {
    const key = itemKey(kind, item);
    if (map.has(key)) {
      duplicates++;
      map.set(key, mergeDuplicate(kind, map.get(key), item));
    } else {
      map.set(key, { ...item });
    }
  }
  return { items: [...map.values()], duplicates };
}

export function isSafeHTTPURL(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return false;
  try {
    const value = new URL(raw);
    return value.protocol === 'http:' || value.protocol === 'https:';
  } catch {
    return false;
  }
}

function validationResult() {
  return { errors: [], warnings: [] };
}

function reportMissing(result, required, location, field) {
  const list = required ? result.errors : result.warnings;
  list.push(`${location} 缺少 ${field}`);
}

export function validateDayFile(value, { requireAllSummaries = true } = {}) {
  const result = validationResult();
  if (!value || typeof value !== 'object') {
    result.errors.push('日分片必须是对象');
    return result;
  }
  if (value.schemaVersion !== 3) result.errors.push('schemaVersion 必须为 3');
  if (!DAY_RE.test(value.day || '')) result.errors.push('day 必须为 YYYY-MM-DD');
  if (!value.generatedAt || Number.isNaN(Date.parse(value.generatedAt))) result.errors.push('generatedAt 无效');
  for (const kind of KINDS) {
    if (!Array.isArray(value[kind])) {
      result.errors.push(`${kind} 必须是数组`);
      continue;
    }
    const seen = new Set();
    value[kind].forEach((item, index) => {
      const location = `${kind}[${index}]`;
      let key;
      try { key = itemKey(kind, item); }
      catch (error) { result.errors.push(`${location} ${error.message}`); return; }
      if (seen.has(key)) result.errors.push(`${location} 分片内重复 ${key}`);
      seen.add(key);
      if (item.url && !isSafeHTTPURL(item.url)) result.errors.push(`${location}.url 必须是 http/https`);
      for (const field of REMOVED_TRANSLATION_FIELDS) {
        if (Object.hasOwn(item, field)) result.errors.push(`${location} 不允许翻译字段 ${field}`);
      }
      if (kind === 'x') {
        if (!hasNonEmptyText(item.text)) result.errors.push(`${location} 缺少 text`);
      } else if (kind === 'podcasts') {
        if (!hasNonEmptyText(item.title)) result.errors.push(`${location} 缺少 title`);
        if (!hasNonEmptyText(item.transcript)) result.errors.push(`${location} 缺少 transcript`);
      } else {
        if (!hasNonEmptyText(item.title)) result.errors.push(`${location} 缺少 title`);
        if (!hasNonEmptyText(item.content)) result.errors.push(`${location} 缺少 content`);
      }
      if (!hasNonEmptyText(item.summaryZh)) reportMissing(result, requireAllSummaries, location, 'summaryZh');
    });
  }
  return result;
}

export function buildIndex(dayFiles, generatedAt) {
  const days = [...dayFiles.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([day, value]) => ({
      day,
      path: `data/days/${day}.json`,
      counts: { x: value.x.length, podcasts: value.podcasts.length, blogs: value.blogs.length },
    }));
  return { schemaVersion: 3, generatedAt, days };
}

export function validateIndex(index, dayFiles, { requireAllSummaries = true } = {}) {
  const result = validationResult();
  if (!index || typeof index !== 'object') {
    result.errors.push('index 必须是对象');
    return result;
  }
  if (index.schemaVersion !== 3) result.errors.push('index schemaVersion 必须为 3');
  if (!Array.isArray(index.days) || index.days.length === 0) {
    result.errors.push('index days 不得为空');
    return result;
  }
  const sorted = [...index.days].sort((a, b) => b.day.localeCompare(a.day));
  if (JSON.stringify(sorted.map(x => x.day)) !== JSON.stringify(index.days.map(x => x.day))) result.errors.push('index days 必须从新到旧排序');
  const daySeen = new Set();
  const itemSeen = new Map();
  for (const entry of index.days) {
    if (daySeen.has(entry.day)) result.errors.push(`index 日期重复 ${entry.day}`);
    daySeen.add(entry.day);
    if (entry.path !== `data/days/${entry.day}.json`) result.errors.push(`${entry.day} 路径无效`);
    const file = dayFiles.get(entry.day);
    if (!file) { result.errors.push(`${entry.day} 缺少日分片`); continue; }
    const validation = validateDayFile(file, { requireAllSummaries });
    result.errors.push(...validation.errors.map(x => `${entry.day}: ${x}`));
    result.warnings.push(...validation.warnings.map(x => `${entry.day}: ${x}`));
    for (const kind of KINDS) {
      if (entry.counts?.[kind] !== file[kind].length) result.errors.push(`${entry.day} ${kind} 计数不一致`);
      for (const item of file[kind]) {
        let key;
        try { key = itemKey(kind, item); } catch { continue; }
        if (itemSeen.has(key)) result.errors.push(`跨日重复 ${key}: ${itemSeen.get(key)} / ${entry.day}`);
        else itemSeen.set(key, entry.day);
      }
    }
  }
  for (const day of dayFiles.keys()) if (!daySeen.has(day)) result.errors.push(`${day} 日分片未列入 index`);
  return result;
}
