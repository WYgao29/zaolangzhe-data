#!/usr/bin/env node
/* 造浪者 v3 数据管线：抓上游 feed → 智谱总结 → 按北京时间批次日原子写入日分片。 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beijingDay, buildIndex, hasNonEmptyText, validateIndex } from './contract.js';
import { atomicWriteJSON, buildWorkQueue, loadRepository, mergeIncoming, writeRepository } from './storage.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const STATE_PATH = path.join(ROOT, 'state', 'processed.json');
const UPSTREAM = 'zarazhangrui/follow-builders';
const API_COMMITS = `https://api.github.com/repos/${UPSTREAM}/commits`;
const FEEDS = { x: 'feed-x.json', podcasts: 'feed-podcasts.json', blogs: 'feed-blogs.json' };
const ZHIPU = 'https://open.bigmodel.cn/api/paas/v4';
const MODEL = process.env.ZHIPU_MODEL || 'glm-5.3-flash';
const KEY = process.env.ZHIPU_API_KEY || '';
const CONCURRENCY = 2;
const DAY = 86400000;

const args = process.argv.slice(2);
const getArg = (name) => {
  const index = args.indexOf('--' + name);
  if (index === -1) return undefined;
  const raw = args[index + 1];
  return raw && !raw.startsWith('--') ? Number(raw) : true;
};
const backfillArg = getArg('backfill-days');
const BACKFILL_DAYS = Number.isFinite(backfillArg) ? Math.max(0, backfillArg) : 0;
const parsedLimit = getArg('limit');
const LIMIT = Number.isFinite(parsedLimit) && parsedLimit >= 0 ? parsedLimit : Infinity;
const DRY_RUN = args.includes('--dry-run');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const cap = (value, limit) => String(value || '').slice(0, limit);

export function requireAIText(value, label) {
  if (!hasNonEmptyText(value)) throw new Error(`${label}为空`);
  return value.trim();
}

async function fetchJSON(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'zaolangzhe-pipeline', ...(options.headers || {}) },
    signal: AbortSignal.timeout(options.timeout || 30000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ← ${url.slice(0, 100)}`);
  return response.json();
}

async function fetchFeed(file, ref = 'main') {
  const urls = [
    `https://raw.githubusercontent.com/${UPSTREAM}/${ref}/${file}`,
    `https://cdn.jsdelivr.net/gh/${UPSTREAM}@${ref}/${file}`,
  ];
  let lastError;
  for (const url of urls) {
    try { return await fetchJSON(url); }
    catch (error) { lastError = error; }
  }
  throw lastError;
}

async function ai(messages, { maxTokens = 8192, timeout = 180000 } = {}) {
  const body = JSON.stringify({
    model: MODEL,
    temperature: 0.3,
    max_tokens: maxTokens,
    thinking: { type: 'enabled', length: 'low' },
    messages,
  });
  const once = async () => {
    const response = await fetch(`${ZHIPU}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
      body,
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) throw new Error('HTTP ' + response.status + ' ' + (await response.text()).slice(0, 120));
    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  };
  try { return await once(); }
  catch (error) {
    console.log(`    ↻ 重试（${error.message}）`);
    await sleep(3000);
    return once();
  }
}

function parseJSONLoose(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('无 JSON 内容');
  return JSON.parse(cleaned.slice(start, end + 1));
}

export async function processTweet(item, aiCall = ai) {
  item.summaryZh = requireAIText(await aiCall([
    { role: 'system', content: '你是科技资讯编辑。用简体中文总结英文推文的核心信息，通常 1–2 句、约 80 个中文字符以内；保留关键人物、产品名、数字和结论；忽略非关键链接、@提及和话题标签；不要逐句翻译，不要解释或加引号，只输出总结。' },
    { role: 'user', content: item.text },
  ]), '推文总结');
}

export async function processPodcast(item, aiCall = ai) {
  const parsed = parseJSONLoose(await aiCall([
    { role: 'system', content: '你是科技播客编辑。直接输出 JSON：{"summaryZh":"约 400 字中文要点总结，包含嘉宾、主题和 3–5 条核心观点"}' },
    { role: 'user', content: `标题: ${item.title}\n转录文本:\n${cap(item.transcript, 60000)}` },
  ]));
  item.summaryZh = requireAIText(parsed.summaryZh, '播客摘要');
}

export async function processBlog(item, aiCall = ai) {
  if (hasNonEmptyText(item.summaryZh)) return;
  const parsed = parseJSONLoose(await aiCall([
    { role: 'system', content: '你是科技文章编辑。直接输出 JSON：{"summaryZh":"2–3 句简体中文内容总结"}；概括核心事实和结论，不要逐段翻译。' },
    { role: 'user', content: `标题: ${item.title}\n正文:\n${cap(item.content, 6000)}` },
  ]));
  item.summaryZh = requireAIText(parsed.summaryZh, '博客摘要');
}

const PROCESSORS = { x: processTweet, podcasts: processPodcast, blogs: processBlog };

function flattenSnapshot(feed, batchDay) {
  const x = [];
  for (const builder of feed.x.x || []) {
    for (const raw of builder.tweets || []) {
      if (!raw.id) continue;
      const item = { ...raw };
      delete item.batchDay;
      item.handle = raw.handle || builder.handle;
      item.builder = raw.builder || builder.name || builder.handle;
      item.bio = raw.bio || builder.bio || '';
      x.push(item);
    }
  }
  const clean = (items) => items.map(raw => { const item = { ...raw }; delete item.batchDay; return item; });
  return {
    day: batchDay,
    generatedAt: feed.x.generatedAt || new Date().toISOString(),
    x,
    podcasts: clean(feed.podcasts.podcasts || []),
    blogs: clean(feed.blogs.blogs || []),
  };
}

async function collectSnapshots() {
  if (!BACKFILL_DAYS) return [{ ref: 'main', ms: Date.now() }];
  const commits = await fetchJSON(`${API_COMMITS}?path=${FEEDS.x}&per_page=100`, { headers: { Accept: 'application/vnd.github+json' } });
  const cutoff = Date.now() - BACKFILL_DAYS * DAY;
  return commits
    .map(commit => ({ ref: commit.sha, ms: Date.parse(commit.commit?.author?.date || '') }))
    .filter(snapshot => snapshot.ref && Number.isFinite(snapshot.ms) && snapshot.ms >= cutoff)
    .reverse();
}

function readState() {
  if (!fs.existsSync(STATE_PATH)) return { upstreamSha: '' };
  const value = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  return { upstreamSha: value.upstreamSha || '' };
}

async function purge(paths) {
  for (const value of paths) {
    try {
      const response = await fetch(`https://purge.jsdelivr.net/gh/WYgao29/zaolangzhe-data@main/${value}`, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      console.log('  ↻ CDN 已刷新: ' + value);
    } catch (error) { console.log('  CDN 刷新失败（不影响数据）: ' + value + ' · ' + error.message); }
  }
}

export async function main() {
  console.log(`造浪者 v3 管线 · 模型 ${MODEL} · 补总结 ${BACKFILL_DAYS} 天 · ${DRY_RUN ? 'DRY-RUN' : '正式'}`);
  const repository = loadRepository(ROOT, { migrateV2: true, requireAllSummaries: false });
  const state = readState();
  const snapshots = await collectSnapshots();
  const addedKeys = new Set();
  const changedDays = new Set(repository.migratedDays);
  let duplicateCount = 0;
  let fetched = 0;
  let newestSha = state.upstreamSha;

  for (const snapshot of snapshots) {
    try {
      const feed = {
        x: await fetchFeed(FEEDS.x, snapshot.ref),
        podcasts: await fetchFeed(FEEDS.podcasts, snapshot.ref),
        blogs: await fetchFeed(FEEDS.blogs, snapshot.ref),
      };
      const generatedMs = Date.parse(feed.x.generatedAt || '') || snapshot.ms;
      const incoming = flattenSnapshot(feed, beijingDay(generatedMs));
      const merged = mergeIncoming(repository.dayFiles, incoming);
      for (const key of merged.addedKeys) addedKeys.add(key);
      for (const day of merged.changedDays) changedDays.add(day);
      duplicateCount += merged.duplicates;
      fetched++;
      if (snapshot.ref !== 'main') newestSha = snapshot.ref;
      console.log(`快照 ${snapshot.ref.slice(0, 8).padEnd(8)} ${incoming.day}：新增 ${merged.addedKeys.size}，重复 ${merged.duplicates}`);
    } catch (error) {
      console.log(`快照 ${snapshot.ref.slice(0, 8)} 拉取失败（${error.message}），跳过`);
    }
  }
  if (!fetched) throw new Error('没有成功读取任何完整上游快照');

  const queue = buildWorkQueue(repository.dayFiles, {
    addedKeys,
    includeAllMissing: repository.migratedDays.size > 0,
  });
  const work = queue.work.slice(0, LIMIT === Infinity ? undefined : LIMIT);
  console.log(`待 AI 加工：新增 ${queue.newCount} · 自愈 ${queue.selfHealCount} · 重复 ${duplicateCount} · 本次 ${work.length}`);
  if (DRY_RUN) {
    console.log(`dry-run 结束：仓库警告 ${repository.warnings.length}，未调用 AI、未写文件。`);
    return;
  }
  if (work.length && !KEY) throw new Error('缺少 ZHIPU_API_KEY');

  let done = 0;
  let failed = 0;
  for (let offset = 0; offset < work.length; offset += CONCURRENCY) {
    const chunk = work.slice(offset, offset + CONCURRENCY);
    await Promise.all(chunk.map(async entry => {
      try {
        await PROCESSORS[entry.kind](entry.item);
        done++;
        changedDays.add(entry.day);
        console.log(`  ✓ [${done}/${work.length}] ${entry.kind} ${entry.key}`);
      } catch (error) {
        failed++;
        console.log(`  ✗ ${entry.kind} ${entry.key}：${error.message}`);
      }
    }));
  }

  if (failed) throw new Error(`仍有 ${failed} 条 AI 加工失败`);

  const generatedAt = new Date().toISOString();
  const index = buildIndex(repository.dayFiles, generatedAt);
  const finalValidation = validateIndex(index, repository.dayFiles);
  if (finalValidation.errors.length) throw new Error('最终数据校验失败:\n' + finalValidation.errors.join('\n'));
  writeRepository(ROOT, repository.dayFiles, generatedAt, changedDays);
  atomicWriteJSON(STATE_PATH, { upstreamSha: newestSha });
  await purge(['data/index.json', ...[...changedDays].map(day => `data/days/${day}.json`)]);
  console.log(`完成：成功 ${done}，失败 ${failed}，更新 ${changedDays.size} 天`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error('管线失败：', error.message || error); process.exit(1); });
}
