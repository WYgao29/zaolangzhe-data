#!/usr/bin/env node
/* 造浪者 v3 数据管线：抓上游 feed → 可选 AI 总结 → 按北京时间批次日原子写入日分片。 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beijingDay, buildIndex, hasNonEmptyText, validateIndex } from './contract.js';
import { buildWorkQueue, loadRepository, mergeIncoming, writeRepository } from './storage.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const UPSTREAM = 'zarazhangrui/follow-builders';
const API_COMMITS = `https://api.github.com/repos/${UPSTREAM}/commits`;
const FEEDS = { x: 'feed-x.json', podcasts: 'feed-podcasts.json', blogs: 'feed-blogs.json' };
const DAY = 86400000;

const args = process.argv.slice(2);
export function resolveAIMode(runtimeArgs = [], env = {}) {
  const xTranslationEnabled = String(env.X_TRANSLATION_ENABLED || '').toLowerCase() === 'true';
  const summariesEnabled = String(env.AI_PROCESSING_ENABLED || '').toLowerCase() === 'true';
  const kinds = summariesEnabled ? ['x', 'podcasts', 'blogs'] : xTranslationEnabled ? ['x'] : [];
  return {
    enabled: kinds.length > 0,
    kinds,
    includeAllMissing: kinds.length > 0 && runtimeArgs.includes('--include-all-missing'),
    requireAllSummaries: summariesEnabled,
    requiredKinds: kinds,
  };
}
const AI_MODE = resolveAIMode(args, process.env); // 默认不调用 AI；生产环境单独开启。
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

export function requireAIText(value, label) {
  if (!hasNonEmptyText(value)) throw new Error(`${label}为空`);
  return value.trim();
}

async function fetchJSON(url, options = {}, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    headers: { 'User-Agent': 'zaolangzhe-pipeline', ...(options.headers || {}) },
    signal: AbortSignal.timeout(options.timeout || 30000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ← ${url.slice(0, 100)}`);
  return response.json();
}

async function fetchFeed(file, ref = 'main', fetchImpl) {
  const urls = [
    `https://raw.githubusercontent.com/${UPSTREAM}/${ref}/${file}`,
    `https://cdn.jsdelivr.net/gh/${UPSTREAM}@${ref}/${file}`,
  ];
  let lastError;
  for (const url of urls) {
    try { return await fetchJSON(url, {}, fetchImpl); }
    catch (error) { lastError = error; }
  }
  throw lastError;
}

/* ---------- 本地 AI 客户端 ----------
 * 仅连接本机的 OpenAI 兼容端点（oMLX/MLX/LM Studio/Ollama 等）。
 * 凭据一律从环境变量读取，源码与配置文件不写密钥。 */
export function resolveAIConfig(env = process.env) {
  const provider = String(env.AI_PROVIDER || 'openai').trim().toLowerCase() || 'openai';
  if (provider !== 'openai') {
    throw new Error(`仅支持本地 OpenAI 兼容端点：AI_PROVIDER 必须为 openai（收到 ${provider}）`);
  }
  const baseURL = String(env.AI_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!baseURL) throw new Error('本地模型需要设置 AI_BASE_URL');
  let parsedURL;
  try { parsedURL = new URL(baseURL); }
  catch { throw new Error(`AI_BASE_URL 必须是有效的 http/https 地址：${baseURL}`); }
  if (!/^https?:$/.test(parsedURL.protocol)) {
    throw new Error(`AI_BASE_URL 必须是 http/https：${baseURL}`);
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsedURL.hostname)) {
    throw new Error(`AI_BASE_URL 必须指向本机回环地址：${baseURL}`);
  }
  const model = String(env.AI_MODEL || '').trim();
  if (!model) throw new Error('本地模型需要设置 AI_MODEL');
  const apiKey = String(env.AI_API_KEY || '');
  const parsePositive = (raw, fallback) => {
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const rawConcurrency = Math.floor(Number(env.AI_CONCURRENCY));
  return {
    provider,
    baseURL,
    model,
    apiKey,
    needsKey: false,
    bodyExtras: {},
    timeoutMs: parsePositive(env.AI_TIMEOUT_MS, 180000),
    concurrency: Number.isFinite(rawConcurrency) ? Math.max(1, rawConcurrency) : 2,
  };
}

export function createAIClient(config, { fetchImpl = fetch, sleepMs = 3000 } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = 'Bearer ' + config.apiKey;
  const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  return async function ai(messages, { maxTokens = 8192, timeout } = {}) {
    const body = JSON.stringify({
      model: config.model,
      temperature: 0.3,
      max_tokens: maxTokens,
      ...config.bodyExtras,
      messages,
    });
    const once = async () => {
      const response = await fetchImpl(`${config.baseURL}/chat/completions`, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(timeout || config.timeoutMs),
      });
      if (!response.ok) throw new Error('HTTP ' + response.status + ' ' + (await response.text()).slice(0, 120));
      const data = await response.json();
      return data.choices?.[0]?.message?.content || '';
    };
    try { return requireAIText(await once(), 'AI 返回'); }
    catch (error) {
      console.log(`    ↻ 重试（${error.message}）`);
      await wait(sleepMs);
      return requireAIText(await once(), 'AI 返回');
    }
  };
}

let defaultClient = null;
function ai(messages, options = {}) {
  if (!defaultClient) defaultClient = createAIClient(resolveAIConfig(process.env));
  return defaultClient(messages, options);
}

function parseJSONLoose(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('无 JSON 内容');
  return JSON.parse(cleaned.slice(start, end + 1));
}

/* ---------- 超长内容分段总结（map → reduce） ----------
 * 三类内容都可能遇到超长文本：先识别长度——单请求预算内直接总结；
 * 超出则按段落边界切段，逐段提取中文要点（map），最后整合成最终总结（reduce）。
 * 不再截断丢弃任何内容。段数有硬上限（超过视为异常数据，明确失败而非死循环）。 */
const CHUNK_CHARS = 60000; // 单请求安全预算：实测 6.6 万字符 ≈ 1.5 万 token，远低于 3.2 万上下文上限
const MAX_CHUNKS = 24;     // 超过约 144 万字符视为异常数据

export function splitIntoChunks(text, maxChars = CHUNK_CHARS, maxChunks = MAX_CHUNKS) {
  const full = String(text || '');
  if (full.length <= maxChars) return [full];
  const chunks = [];
  let rest = full;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf('\n', maxChars);
    if (cut < maxChars / 2) cut = maxChars; // 无换行或换行太靠前时硬切
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest.length) chunks.push(rest);
  if (chunks.length > maxChunks) throw new Error(`内容超长：${full.length} 字符超过 ${maxChunks} 段上限，请人工检查`);
  return chunks;
}

const CHUNK_PROMPTS = {
  x: {
    map: '你是专业的科技翻译。以下是一条长推文的一段节选，请完整翻译成简体中文，保留原有换行、@提及、链接、话题标签、产品名、专有名词和数字；不要总结、解释或加引号，只输出译文。',
    reduce: '你是专业的科技翻译。以下是同一条长推文按原顺序分段得到的中文译文，请按原顺序拼接并还原完整译文，不要总结、删减、解释或加引号，只输出译文。',
    reduceJSON: false,
  },
  podcasts: {
    map: '你是科技播客编辑。以下是同一期播客转录文本的一段节选，用简体中文提取该段的关键要点（嘉宾观点、事实、结论、数字），简明输出。',
    reduce: '你是科技播客编辑。以下是同一期播客各段的要点，请整合成约 400 字中文要点总结，包含嘉宾、主题和 3–5 条核心观点。直接输出 JSON：{"summaryZh":"…"}。',
    reduceJSON: true,
  },
  blogs: {
    map: '你是科技文章编辑。以下是同一篇文章的一段节选，用简体中文概括该段的核心事实和结论，1–3 句。',
    reduce: '你是科技文章编辑。以下是同一篇文章各段的要点，请整合成 2–3 句简体中文内容总结；概括核心事实和结论，不要逐段翻译。直接输出 JSON：{"summaryZh":"…"}。',
    reduceJSON: true,
  },
};

async function summarizeLongText(kind, text, aiCall, label) {
  const chunks = splitIntoChunks(text);
  if (chunks.length === 1) return null; // 单请求路径由调用方处理
  const prompts = CHUNK_PROMPTS[kind];
  const partials = [];
  for (let i = 0; i < chunks.length; i++) {
    partials.push(requireAIText(await aiCall([
      { role: 'system', content: prompts.map },
      { role: 'user', content: `（第 ${i + 1}/${chunks.length} 段）\n${chunks[i]}` },
    ]), `${label}分段要点 ${i + 1}`));
  }
  const reduceUser = partials.map((part, i) => `【第 ${i + 1} 段要点】\n${part}`).join('\n\n');
  if (prompts.reduceJSON) {
    const parsed = parseJSONLoose(await aiCall([
      { role: 'system', content: prompts.reduce },
      { role: 'user', content: reduceUser },
    ]));
    return requireAIText(parsed.summaryZh, label);
  }
  return requireAIText(await aiCall([
    { role: 'system', content: prompts.reduce },
    { role: 'user', content: reduceUser },
  ]), label);
}

export async function processTweet(item, aiCall = ai) {
  const long = await summarizeLongText('x', item.text, aiCall, '推文译文');
  if (long !== null) { item.textZh = long; delete item.summaryZh; return; }
  item.textZh = requireAIText(await aiCall([
    { role: 'system', content: '你是专业的科技翻译。将英文推文完整翻译成简体中文：准确、自然，保留原有换行、@提及、链接、话题标签、产品名、专有名词和数字；只输出译文，不要总结、解释或加引号。' },
    { role: 'user', content: item.text },
  ]), '推文译文');
  delete item.summaryZh;
}

export async function processPodcast(item, aiCall = ai) {
  const long = await summarizeLongText('podcasts', item.transcript, aiCall, '播客摘要');
  if (long !== null) { item.summaryZh = long; return; }
  const parsed = parseJSONLoose(await aiCall([
    { role: 'system', content: '你是科技播客编辑。直接输出 JSON：{"summaryZh":"约 400 字中文要点总结，包含嘉宾、主题和 3–5 条核心观点"}' },
    { role: 'user', content: `标题: ${item.title}\n转录文本:\n${item.transcript}` },
  ]));
  item.summaryZh = requireAIText(parsed.summaryZh, '播客摘要');
}

export async function processBlog(item, aiCall = ai) {
  if (hasNonEmptyText(item.summaryZh)) return;
  const long = await summarizeLongText('blogs', item.content, aiCall, '博客摘要');
  if (long !== null) { item.summaryZh = long; return; }
  const parsed = parseJSONLoose(await aiCall([
    { role: 'system', content: '你是科技文章编辑。直接输出 JSON：{"summaryZh":"2–3 句简体中文内容总结"}；概括核心事实和结论，不要逐段翻译。' },
    { role: 'user', content: `标题: ${item.title}\n正文:\n${item.content}` },
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

async function collectUpstreamSnapshots(backfillDays, fetchImpl, now = Date.now()) {
  if (!backfillDays) return [{ ref: 'main', ms: now }];
  const commits = await fetchJSON(`${API_COMMITS}?path=${FEEDS.x}&per_page=100`, { headers: { Accept: 'application/vnd.github+json' } }, fetchImpl);
  const todayStart = Date.parse(`${beijingDay(now)}T00:00:00+08:00`);
  const cutoff = todayStart - backfillDays * DAY;
  const snapshots = commits
    .map(commit => ({ ref: commit.sha, ms: Date.parse(commit.commit?.author?.date || '') }))
    .filter(snapshot => snapshot.ref && Number.isFinite(snapshot.ms) && snapshot.ms >= cutoff)
    .reverse();
  // GitHub 没有新提交时，当前 main 仍是一个合法的 no-op 快照；不能把“无新增”当成管线故障。
  return snapshots.length ? snapshots : [{ ref: 'main', ms: now }];
}

/* 归档上游：拉取快照（backfillDays>0 时回放历史提交）并合并进 dayFiles。
 * 云端 process.js 与本地 summarize-local 共用这一段合并语义。 */
export async function archiveUpstreamSnapshots(repository, { backfillDays = 0, now = Date.now(), fetchImpl, log = console.log } = {}) {
  const snapshots = await collectUpstreamSnapshots(backfillDays, fetchImpl, now);
  const addedKeys = new Set();
  const changedDays = new Set();
  let duplicateCount = 0;
  let fetched = 0;
  for (const snapshot of snapshots) {
    try {
      const feed = {
        x: await fetchFeed(FEEDS.x, snapshot.ref, fetchImpl),
        podcasts: await fetchFeed(FEEDS.podcasts, snapshot.ref, fetchImpl),
        blogs: await fetchFeed(FEEDS.blogs, snapshot.ref, fetchImpl),
      };
      const generatedMs = Date.parse(feed.x.generatedAt || '') || snapshot.ms;
      const incoming = flattenSnapshot(feed, beijingDay(generatedMs));
      const merged = mergeIncoming(repository.dayFiles, incoming);
      for (const key of merged.addedKeys) addedKeys.add(key);
      for (const day of merged.changedDays) changedDays.add(day);
      duplicateCount += merged.duplicates;
      fetched++;
      log(`快照 ${snapshot.ref.slice(0, 8).padEnd(8)} ${incoming.day}：新增 ${merged.addedKeys.size}，重复 ${merged.duplicates}`);
    } catch (error) {
      log(`快照 ${snapshot.ref.slice(0, 8)} 拉取失败（${error.message}），跳过`);
    }
  }
  if (!fetched) throw new Error('没有成功读取任何完整上游快照');
  return { addedKeys, changedDays, duplicates: duplicateCount, fetched };
}

export async function purge(paths) {
  for (const value of paths) {
    try {
      const response = await fetch(`https://purge.jsdelivr.net/gh/WYgao29/zaolangzhe-data@main/${value}`, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      console.log('  ↻ CDN 已刷新: ' + value);
    } catch (error) { console.log('  CDN 刷新失败（不影响数据）: ' + value + ' · ' + error.message); }
  }
}

export async function main() {
  // 未开启 AI 时只做英文归档；不能因为没有本地模型配置而阻断应急归档。
  const AI_CONFIG = AI_MODE.enabled ? resolveAIConfig(process.env) : null;
  console.log(`造浪者 v3 管线 · ${AI_MODE.enabled ? `AI ${AI_CONFIG.provider}:${AI_CONFIG.model}` : '纯英文'} · 回溯上游 ${BACKFILL_DAYS} 天 · ${DRY_RUN ? 'DRY-RUN' : '正式'}`);
  const repository = loadRepository(ROOT, { migrateV2: true, requireAllSummaries: false });
  const archive = await archiveUpstreamSnapshots(repository, { backfillDays: BACKFILL_DAYS });
  const addedKeys = archive.addedKeys;
  const changedDays = new Set([...repository.migratedDays, ...archive.changedDays]);
  const duplicateCount = archive.duplicates;

  const queue = buildWorkQueue(repository.dayFiles, {
    addedKeys,
    includeAllMissing: repository.migratedDays.size > 0 || AI_MODE.includeAllMissing,
    aiEnabled: AI_MODE.enabled,
    aiKinds: AI_MODE.enabled ? ['x', 'podcasts', 'blogs'] : [],
  });
  const work = queue.work.slice(0, LIMIT === Infinity ? undefined : LIMIT);
  console.log(AI_MODE.enabled
    ? `待 AI 加工：新增 ${queue.newCount} · 自愈 ${queue.selfHealCount} · 重复 ${duplicateCount} · 本次 ${work.length}`
    : `纯英文模式：AI 总结已暂停 · 重复 ${duplicateCount}`);
  if (DRY_RUN) {
    console.log(`dry-run 结束：仓库警告 ${repository.warnings.length}，未调用 AI、未写文件。`);
    return;
  }
  let done = 0;
  let failed = 0;
  if (AI_MODE.enabled) {
    const aiCall = createAIClient(AI_CONFIG);
    for (let offset = 0; offset < work.length; offset += AI_CONFIG.concurrency) {
      const chunk = work.slice(offset, offset + AI_CONFIG.concurrency);
      await Promise.all(chunk.map(async entry => {
        try {
          await PROCESSORS[entry.kind](entry.item, aiCall);
          done++;
          changedDays.add(entry.day);
          console.log(`  ✓ [${done}/${work.length}] ${entry.kind} ${entry.key}`);
        } catch (error) {
          failed++;
          console.log(`  ✗ ${entry.kind} ${entry.key}：${error.message}`);
        }
      }));
    }
  }

  if (failed) throw new Error(`仍有 ${failed} 条 AI 加工失败`);

  const generatedAt = new Date().toISOString();
  const index = buildIndex(repository.dayFiles, generatedAt);
  const finalValidation = validateIndex(index, repository.dayFiles, {
    requireAllSummaries: AI_MODE.requireAllSummaries,
    requiredKinds: AI_MODE.requiredKinds,
  });
  if (finalValidation.errors.length) throw new Error('最终数据校验失败:\n' + finalValidation.errors.join('\n'));
  writeRepository(ROOT, repository.dayFiles, generatedAt, changedDays, {
    requireAllSummaries: AI_MODE.requireAllSummaries,
    requiredKinds: AI_MODE.requiredKinds,
  });
  await purge(['data/index.json', ...[...changedDays].map(day => `data/days/${day}.json`)]);
  console.log(`完成：成功 ${done}，失败 ${failed}，更新 ${changedDays.size} 天`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error('管线失败：', error.message || error); process.exit(1); });
}
