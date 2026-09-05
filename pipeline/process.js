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
  const enabled = String(env.AI_PROCESSING_ENABLED || '').toLowerCase() === 'true';
  return {
    enabled,
    includeAllMissing: enabled && runtimeArgs.includes('--include-all-missing'),
    requireAllSummaries: enabled,
  };
}
const AI_MODE = resolveAIMode(args, process.env); // Actions 不设置开关，默认纯英文。
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

/* ---------- AI 客户端（提供者无关） ----------
 * zhipu：智谱云端 API（默认，含专有 thinking 字段，需要密钥）。
 * openai：任意 OpenAI 兼容端点（本地 MLX/LM Studio/Ollama 等，无需密钥）。
 * 凭据一律从环境变量读取，源码与配置文件不写密钥。 */
export function resolveAIConfig(env = process.env) {
  const provider = String(env.AI_PROVIDER || 'zhipu').trim().toLowerCase() || 'zhipu';
  if (provider !== 'zhipu' && provider !== 'openai') {
    throw new Error(`未知 AI_PROVIDER：${provider}（可选 zhipu / openai）`);
  }
  let baseURL = '';
  if (provider === 'zhipu') {
    baseURL = 'https://open.bigmodel.cn/api/paas/v4';
  } else {
    baseURL = String(env.AI_BASE_URL || '').trim().replace(/\/+$/, '');
    if (!baseURL) throw new Error('AI_PROVIDER=openai 需要设置 AI_BASE_URL（本地 OpenAI 兼容端点）');
    if (!/^https?:\/\//i.test(baseURL)) throw new Error(`AI_BASE_URL 必须是 http/https：${baseURL}`);
  }
  const model = String(env.AI_MODEL || (provider === 'zhipu' ? env.ZHIPU_MODEL : '') || (provider === 'zhipu' ? 'glm-5.3-flash' : '')).trim();
  if (!model) throw new Error('AI_PROVIDER=openai 需要设置 AI_MODEL（本地模型名）');
  const apiKey = String(env.AI_API_KEY || (provider === 'zhipu' ? env.ZHIPU_API_KEY : '') || '');
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
    needsKey: provider === 'zhipu',
    bodyExtras: provider === 'zhipu' ? { thinking: { type: 'enabled', length: 'low' } } : {},
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
    map: '你是科技资讯编辑。以下是一条长推文的一段节选，用简体中文提取该段的关键信息要点，1–3 句；保留关键人物、产品名、数字和结论。',
    reduce: '你是科技资讯编辑。以下是同一条长推文各段的中文要点，请整合成一条简体中文总结，通常 1–2 句、约 80 个中文字符以内；保留关键人物、产品名、数字和结论；只输出总结，不要解释或加引号。',
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
  const long = await summarizeLongText('x', item.text, aiCall, '推文总结');
  if (long !== null) { item.summaryZh = long; return; }
  item.summaryZh = requireAIText(await aiCall([
    { role: 'system', content: '你是科技资讯编辑。用简体中文总结英文推文的核心信息，通常 1–2 句、约 80 个中文字符以内；保留关键人物、产品名、数字和结论；忽略非关键链接、@提及和话题标签；不要逐句翻译，不要解释或加引号，只输出总结。若推文只有链接没有正文，输出"分享了一条链接，未附文字说明。"' },
    { role: 'user', content: item.text },
  ]), '推文总结');
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

async function collectUpstreamSnapshots(backfillDays, fetchImpl) {
  if (!backfillDays) return [{ ref: 'main', ms: Date.now() }];
  const commits = await fetchJSON(`${API_COMMITS}?path=${FEEDS.x}&per_page=100`, { headers: { Accept: 'application/vnd.github+json' } }, fetchImpl);
  const cutoff = Date.now() - backfillDays * DAY;
  return commits
    .map(commit => ({ ref: commit.sha, ms: Date.parse(commit.commit?.author?.date || '') }))
    .filter(snapshot => snapshot.ref && Number.isFinite(snapshot.ms) && snapshot.ms >= cutoff)
    .reverse();
}

/* 归档上游：拉取快照（backfillDays>0 时回放历史提交）并合并进 dayFiles。
 * 云端 process.js 与本地 summarize-local 共用这一段合并语义。 */
export async function archiveUpstreamSnapshots(repository, { backfillDays = 0, fetchImpl, log = console.log } = {}) {
  const snapshots = await collectUpstreamSnapshots(backfillDays, fetchImpl);
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
  const AI_CONFIG = resolveAIConfig(process.env);
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
  });
  const work = queue.work.slice(0, LIMIT === Infinity ? undefined : LIMIT);
  console.log(AI_MODE.enabled
    ? `待 AI 加工：新增 ${queue.newCount} · 自愈 ${queue.selfHealCount} · 重复 ${duplicateCount} · 本次 ${work.length}`
    : `纯英文模式：AI 总结已暂停 · 重复 ${duplicateCount}`);
  if (DRY_RUN) {
    console.log(`dry-run 结束：仓库警告 ${repository.warnings.length}，未调用 AI、未写文件。`);
    return;
  }
  if (work.length && AI_CONFIG.needsKey && !AI_CONFIG.apiKey) throw new Error('缺少 ZHIPU_API_KEY');

  let done = 0;
  let failed = 0;
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

  if (failed) throw new Error(`仍有 ${failed} 条 AI 加工失败`);

  const generatedAt = new Date().toISOString();
  const index = buildIndex(repository.dayFiles, generatedAt);
  const finalValidation = validateIndex(index, repository.dayFiles, {
    requireAllSummaries: AI_MODE.requireAllSummaries,
  });
  if (finalValidation.errors.length) throw new Error('最终数据校验失败:\n' + finalValidation.errors.join('\n'));
  writeRepository(ROOT, repository.dayFiles, generatedAt, changedDays, {
    requireAllSummaries: AI_MODE.requireAllSummaries,
  });
  await purge(['data/index.json', ...[...changedDays].map(day => `data/days/${day}.json`)]);
  console.log(`完成：成功 ${done}，失败 ${failed}，更新 ${changedDays.size} 天`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error('管线失败：', error.message || error); process.exit(1); });
}
