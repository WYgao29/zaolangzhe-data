#!/usr/bin/env node
/* 造浪者数据管线：抓上游 feed → 智谱 GLM 加工（翻译/摘要）→ 产出中文数据集
 *
 * 用法:
 *   node pipeline/process.js                        # 增量：处理上游最新快照中的新内容
 *   node pipeline/process.js --backfill-days 30     # 补加工：遍历上游近 30 天提交历史
 *   node pipeline/process.js --limit 6              # 限制本次 AI 处理条数（测试用）
 *   node pipeline/process.js --dry-run              # 只统计要处理什么，不调 AI 不写文件
 *
 * 环境变量: ZHIPU_API_KEY（必填，dry-run 除外）; ZHIPU_MODEL（可选，默认 glm-5.3-flash）
 */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DIR_DATA = path.join(ROOT, 'data');
const DIR_DIGEST = path.join(ROOT, 'digest');
const DIR_STATE = path.join(ROOT, 'state');

const UPSTREAM = 'zarazhangrui/follow-builders';
const RAW = 'https://raw.githubusercontent.com/' + UPSTREAM + '/main/';
const JSDELIVR = 'https://cdn.jsdelivr.net/gh/' + UPSTREAM + '@main/';
const API_COMMITS = 'https://api.github.com/repos/' + UPSTREAM + '/commits';
const FEEDS = { x: 'feed-x.json', podcasts: 'feed-podcasts.json', blogs: 'feed-blogs.json' };
const ZHIPU = 'https://open.bigmodel.cn/api/paas/v4';
const MODEL = process.env.ZHIPU_MODEL || 'glm-5.3-flash';
const KEY = process.env.ZHIPU_API_KEY || '';
const CONCURRENCY = 2;
const DAY = 86400000;

/* ---------- 参数 ---------- */
const args = process.argv.slice(2);
const getArg = (name) => {
  const i = args.indexOf('--' + name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  return (v && !v.startsWith('--')) ? Number(v) : true;
};
const BACKFILL_DAYS = getArg('backfill-days') || 0;
const LIMIT = getArg('limit') || Infinity;
const DRY_RUN = args.includes('--dry-run');

const pad2 = (n) => String(n).padStart(2, '0');
const dayKey = (ms) => { const d = new Date(ms); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); };
const cap = (s, n) => (s || '').slice(0, n);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'zaolangzhe-pipeline', ...(opts.headers || {}) },
    signal: AbortSignal.timeout(opts.timeout || 30000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ← ${url.slice(0, 90)}`);
  return res.json();
}

/* 上游文件：raw 优先、jsDelivr 兜底 */
async function fetchFeed(file, ref = 'main') {
  const urls = [
    `https://raw.githubusercontent.com/${UPSTREAM}/${ref}/${file}`,
    `https://cdn.jsdelivr.net/gh/${UPSTREAM}@${ref}/${file}`,
  ];
  let lastErr;
  for (const u of urls) {
    try { return await fetchJSON(u); } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

/* ---------- 智谱调用（失败重试一次） ---------- */
async function ai(messages, { maxTokens = 4096, timeout = 180000 } = {}) {
  if (DRY_RUN) return '(dry-run 跳过)';
  // glm-5.3 系列始终思考（思考 token 计入 max_tokens）：用 low 档并预留足够输出预算，
  // 否则长内容会"思考耗尽预算 → 正文输出为空"
  const body = JSON.stringify({ model: MODEL, temperature: 0.3, max_tokens: maxTokens, thinking: { type: 'enabled', length: 'low' }, messages });
  const once = async () => {
    const res = await fetch(ZHIPU + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + KEY },
      body,
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 120));
    const data = await res.json();
    return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  };
  try { return await once(); }
  catch (e) { console.log(`    ↻ 重试（${e.message}）`); await sleep(3000); return await once(); }
}

function parseJSONLoose(text) {
  let t = (text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a === -1 || b === -1) throw new Error('无 JSON 内容');
  return JSON.parse(t.slice(a, b + 1));
}

/* ---------- 三类内容的 AI 加工 ---------- */
async function processTweet(p) {
  const text = await ai([
    { role: 'system', content: '你是专业的科技翻译。将英文推文翻译成简体中文：准确、简洁；@提及、链接、话题标签保留原样；专有名词与产品名保留英文；只输出译文，不要任何解释或引号。' },
    { role: 'user', content: p.text },
  ], { maxTokens: 8192 });
  p.textZh = text.trim();
}

async function processPodcast(e) {
  const out = await ai([
    { role: 'system', content: '你是科技播客编辑。根据英文转录文本输出 JSON（直接输出 JSON，不要 markdown 代码块）：{"titleZh":"单集标题的简体中文翻译","summaryZh":"400 字左右的中文要点摘要：嘉宾是谁、聊了什么、3-5 条核心观点"}' },
    { role: 'user', content: `标题: ${e.title}\n转录文本:\n${cap(e.transcript, 60000)}` },
  ], { maxTokens: 8192 });
  const j = parseJSONLoose(out);
  if (!j.titleZh || !j.summaryZh) throw new Error('JSON 字段缺失');
  e.titleZh = String(j.titleZh); e.summaryZh = String(j.summaryZh);
}

async function processBlog(b) {
  // 第 1 步：标题 + 摘要（小 JSON，稳定）
  const meta = await ai([
    { role: 'system', content: '你是科技文章编辑。输出 JSON（直接输出，不要代码块）：{"titleZh":"标题的简体中文翻译","summaryZh":"2-3 句中文内容摘要"}' },
    { role: 'user', content: `标题: ${b.title}\n正文:\n${cap(b.content, 6000)}` },
  ], { maxTokens: 8192 });
  const mj = parseJSONLoose(meta);
  if (!mj.titleZh || !mj.summaryZh) throw new Error('标题/摘要 JSON 字段缺失');
  b.titleZh = String(mj.titleZh); b.summaryZh = String(mj.summaryZh);

  // 第 2 步：正文翻译。glm-5.3 系列思考 token 不可控（实测会把 16k 预算全部花在思考上），
  // 因此按段落切块逐段翻译（每块预算独立，天然规避"思考吃光预算→输出为空"）
  const splitChunks = (text, size) => {
    // 硬切：不依赖空行分段（很多文章没有空行），保证每块 ≤ size
    const out = [];
    let cur = '';
    for (const para of (text || '').split('\n')) {
      let line = para;
      while (line.length > 0) {
        const take = Math.min(size - cur.length - 1, line.length);
        if (take <= 0) { out.push(cur); cur = ''; continue; }
        cur += (cur ? '\n' : '') + line.slice(0, take);
        line = line.slice(take);
        if (cur.length >= size) { out.push(cur); cur = ''; }
      }
    }
    if (cur.trim()) out.push(cur);
    return out.length ? out : [text];
  };
  try {
    const chunks = splitChunks(b.content, 8000);
    const parts = [];
    for (let ci = 0; ci < chunks.length; ci++) {
      const out = await ai([
        { role: 'system', content: '你是专业的科技文章翻译。将英文翻译成简体中文：保留 Markdown 结构与链接（URL 原样）；只输出译文。' },
        { role: 'user', content: chunks[ci] },
      ], { maxTokens: 8192, timeout: 420000 });
      if (!out.trim()) throw new Error(`第 ${ci + 1} 块译文为空`);
      parts.push(out.trim());
    }
    b.contentZh = parts.join('\n\n');
  } catch (e) {
    // 部分翻译失败不回滚标题/摘要：网页会回退展示英文正文
    console.log(`    ↱ 正文翻译失败（${e.message}），保留英文正文`);
  }
}

const PROCESSORS = { x: processTweet, podcasts: processPodcast, blogs: processBlog };

/* ---------- 日报生成 ---------- */
async function generateDigest(day, items) {
  const L = [];
  const brief = (en, zh) => (zh || en || '');
  if (items.podcasts.length) {
    L.push('【播客】');
    for (const e of items.podcasts) L.push(`- ${e.show}《${brief(e.title, e.titleZh)}》 ${e.url}\n  摘要: ${cap(e.summaryZh, 500)}`);
  }
  if (items.x.length) {
    L.push('【X 推文】');
    for (const p of items.x) L.push(`- @${p.handle}: ${brief(p.text, p.textZh)}${p.url ? ' ' + p.url : ''}`);
  }
  if (items.blogs.length) {
    L.push('【博客】');
    for (const b of items.blogs) L.push(`- ${b.source}《${brief(b.title, b.titleZh)}》 ${b.url}\n  摘要: ${cap(b.summaryZh, 300)}`);
  }
  const md = await ai([
    { role: 'system', content: '你是「造浪者」日报编辑。基于当天采集内容输出中文日报 Markdown：开头 "## 今日焦点" 一两句话点出最重要动向；然后 "## 播客" "## X 推文" "## 博客" 分节（空节跳过），每条 1-2 句中文摘要并保留原链接；结尾可加一行 "**编辑注**：…"。只基于材料，不编造。' },
    { role: 'user', content: L.join('\n').slice(0, 30000) },
  ], { maxTokens: 8192 });
  return md.trim();
}

/* ---------- 主流程 ---------- */
async function main() {
  console.log(`造浪者数据管线 · 模型 ${MODEL} · 补加工 ${BACKFILL_DAYS || 0} 天 · ${DRY_RUN ? 'DRY-RUN' : '正式'}`);

  // 快照收集：增量（main）或回填（近 N 天提交历史，旧→新）
  const snapshots = [];
  if (BACKFILL_DAYS > 0) {
    const commits = await fetchJSON(`${API_COMMITS}?path=${FEEDS.x}&per_page=100`, { headers: { Accept: 'application/vnd.github+json' } });
    const cutoff = Date.now() - BACKFILL_DAYS * DAY;
    const inRange = commits.filter(c => {
      const t = Date.parse(c.commit && c.commit.author && c.commit.author.date || '') || 0;
      return t >= cutoff;
    });
    console.log(`上游近 ${BACKFILL_DAYS} 天共 ${inRange.length} 个快照，旧→新处理…`);
    for (const c of [...inRange].reverse()) snapshots.push({ sha: c.sha });
  } else {
    snapshots.push({ sha: null, ref: 'main' });
  }

  // 状态与归档加载
  fs.mkdirSync(DIR_DATA, { recursive: true });
  fs.mkdirSync(DIR_DIGEST, { recursive: true });
  fs.mkdirSync(DIR_STATE, { recursive: true });
  const statePath = path.join(DIR_STATE, 'processed.json');
  const state = fs.existsSync(statePath)
    ? JSON.parse(fs.readFileSync(statePath, 'utf8'))
    : { upstreamSha: '', items: {}, digests: {} };

  const archivePath = (f) => path.join(DIR_DATA, FEEDS[f]);
  const archive = {};
  for (const f of Object.keys(FEEDS)) {
    archive[f] = fs.existsSync(archivePath(f))
      ? JSON.parse(fs.readFileSync(archivePath(f), 'utf8'))
      : (f === 'x' ? { generatedAt: '', x: [] } : f === 'podcasts' ? { generatedAt: '', podcasts: [] } : { generatedAt: '', blogs: [] });
  }
  // 归档索引：唯一键 → 条目引用（用于回填 zh 字段）
  const index = { x: new Map(), podcasts: new Map(), blogs: new Map() };
  const xBuilders = new Map(archive.x.x.map(b => [b.handle, b]));
  for (const b of archive.x.x) for (const t of b.tweets) index.x.set('x:' + t.id, { item: t, builder: b });
  for (const e of archive.podcasts.podcasts) index.podcasts.set('pod:' + e.guid, { item: e });
  for (const b of archive.blogs.blogs) index.blogs.set('blog:' + b.url, { item: b });

  // 逐快照收集新内容
  const newItems = { x: [], podcasts: [], blogs: [] }; // 待 AI 加工
  const newByDay = {}; // batchDay -> {x:[],podcasts:[],blogs:[]}（本轮新增，用于日报）
  let newestSha = state.upstreamSha;

  for (let si = 0; si < snapshots.length; si++) {
    const snap = snapshots[si];
    const ref = snap.sha || snap.ref;
    let feed;
    try {
      feed = {
        x: await fetchFeed(FEEDS.x, ref),
        podcasts: await fetchFeed(FEEDS.podcasts, ref),
        blogs: await fetchFeed(FEEDS.blogs, ref),
      };
    } catch (e) {
      console.log(`快照 ${ref.slice(0, 8)} 拉取失败（${e.message}），跳过`);
      continue;
    }
    if (snap.sha) newestSha = snap.sha;
    const batchDay = dayKey(Date.parse(feed.x.generatedAt || '') || (snap.sha ? Date.parse(new Date(ref).toISOString()) : Date.now()));
    const seen = { added: 0 };
    const collect = (kind, key, enriched, builderWrap) => {
      // 入归档（推文按构建者分组；播客/博客为扁平列表）
      if (kind === 'x') {
        let b = xBuilders.get(builderWrap.handle);
        if (!b) { b = { handle: builderWrap.handle, name: builderWrap.name, bio: builderWrap.bio, tweets: [] }; archive.x.x.push(b); xBuilders.set(b.handle, b); }
        b.tweets.push(enriched);
        index.x.set(key, { item: enriched, builder: b });
      } else if (kind === 'podcasts') {
        archive.podcasts.podcasts.push(enriched);
        index.podcasts.set(key, { item: enriched });
      } else {
        archive.blogs.blogs.push(enriched);
        index.blogs.set(key, { item: enriched });
      }
      (kind === 'x' ? newItems.x : kind === 'podcasts' ? newItems.podcasts : newItems.blogs).push(enriched);
      (newByDay[batchDay] ||= { x: [], podcasts: [], blogs: [] })[kind].push(enriched);
      seen.added++;
    };
    // X feed 是 构建者→推文 两层结构
    for (const b of feed.x.x || []) {
      for (const raw of b.tweets || []) {
        const key = 'x:' + raw.id;
        if (!raw.id) continue;
        if (state.items[key] || index.x.has(key)) { state.items[key] = 1; continue; } // 已入库：补记台账防重复
        collect('x', key, { ...raw, batchDay, handle: b.handle, builder: b.name || b.handle, bio: b.bio || '' },
                { handle: b.handle, name: b.name, bio: b.bio });
      }
    }
    for (const raw of feed.podcasts.podcasts || []) {
      const key = 'pod:' + raw.guid;
      if (!raw.guid) continue;
      if (state.items[key] || index.podcasts.has(key)) { state.items[key] = 1; continue; }
      state.items[key] = 1;
      collect('podcasts', key, { ...raw, batchDay });
    }
    for (const raw of feed.blogs.blogs || []) {
      const key = 'blog:' + raw.url;
      if (!raw.url) continue;
      if (state.items[key] || index.blogs.has(key)) { state.items[key] = 1; continue; }
      state.items[key] = 1;
      collect('blogs', key, { ...raw, batchDay });
    }
    console.log(`快照 ${String(snap.sha ? snap.sha.slice(0, 8) : 'main').padEnd(8)} ${batchDay}：新增 ${seen.added} 条`);
  }

  const totalNew = newItems.x.length + newItems.podcasts.length + newItems.blogs.length;
  console.log(`\n待 AI 加工：推文 ${newItems.x.length} · 播客 ${newItems.podcasts.length} · 博客 ${newItems.blogs.length}（共 ${totalNew}）`);
  if (DRY_RUN) { console.log('dry-run 结束，未调用 AI、未写文件。'); return; }
  if (totalNew > 0 && !KEY) { console.error('缺少 ZHIPU_API_KEY'); process.exit(1); }

  // 只加工最近 3 天：窗口外的条目保留英文原版入库，不再消耗 AI
  const RECENT_DAYS = 3;
  const recentCutoff = dayKey(Date.now() - (RECENT_DAYS - 1) * DAY);
  const isRecent = (it) => (it.batchDay || '') >= recentCutoff;

  // 自愈：近 3 天内已入库但缺译文的条目（如上次运行被中断）重新排队
  const requeue = (kind, map, keyOf, listOf) => {
    for (const [key, wrap] of [...map]) {
      const it = wrap.item || wrap;
      if (!isRecent(it)) continue;
      const missing = kind === 'x' ? !it.textZh : kind === 'podcasts' ? !it.summaryZh : !it.contentZh;
      if (missing && !newItems[kind].some(x => x === it)) {
        newItems[kind].push(it);
        (newByDay[it.batchDay] ||= { x: [], podcasts: [], blogs: [] })[kind].push(it);
      }
    }
  };
  requeue('x', index.x);
  requeue('podcasts', index.podcasts);
  requeue('blogs', index.blogs);

  // AI 加工（有限并发 + 限额）
  const work = [
    ...newItems.x.map(item => ({ kind: 'x', item })),
    ...newItems.podcasts.map(item => ({ kind: 'podcasts', item })),
    ...newItems.blogs.map(item => ({ kind: 'blogs', item })),
  ].filter(w => isRecent(w.item))
   .slice(0, LIMIT === Infinity ? undefined : LIMIT);
  const skipped = totalNew - work.length;
  if (skipped > 0) console.log(`（--limit 生效：本次只处理 ${work.length} 条，剩余 ${skipped} 条下次运行）`);

  let done = 0, failed = 0;
  for (let i = 0; i < work.length; i += CONCURRENCY) {
    const chunk = work.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map(async (w) => {
      try { await PROCESSORS[w.kind](w.item); done++; console.log(`  ✓ [${done}/${work.length}] ${w.kind} ${w.item.id || w.item.guid || w.item.url}`); }
      catch (e) { failed++; console.log(`  ✗ ${w.kind} ${w.item.id || w.item.guid || w.item.url}：${e.message}`);
        // 失败项从 state 移除，下次运行重试
        const key = w.kind === 'x' ? 'x:' + w.item.id : w.kind === 'podcasts' ? 'pod:' + w.item.guid : 'blog:' + w.item.url;
        delete state.items[key];
      }
    }));
    // 每批落盘一次（中断不丢进度）
    for (const f of Object.keys(FEEDS)) fs.writeFileSync(archivePath(f), JSON.stringify(archive[f]));
  }
  console.log(`AI 加工完成：成功 ${done}，失败 ${failed}`);

  // 日报（每批次日一份）
  for (const [day, items] of Object.entries(newByDay)) {
    if (state.digests[day] || day < recentCutoff) continue;
    if (!items.x.length && !items.podcasts.length && !items.blogs.length) continue;
    console.log(`生成日报 ${day} …`);
    try {
      const markdown = await generateDigest(day, items);
      fs.writeFileSync(path.join(DIR_DIGEST, day + '.json'), JSON.stringify({ day, markdown }));
      state.digests[day] = 1;
    } catch (e) { console.log(`日报 ${day} 失败：${e.message}（下次运行重试）`); delete state.digests[day]; }
  }

  // 收尾：写归档与状态
  for (const f of Object.keys(FEEDS)) {
    archive[f].generatedAt = new Date().toISOString();
    fs.writeFileSync(archivePath(f), JSON.stringify(archive[f]));
  }
  state.upstreamSha = newestSha || state.upstreamSha;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

  // 主动刷新 jsDelivr 缓存（它对 main 分支有最长半天的缓存，不 purge 网页会读到旧数据）
  if (!DRY_RUN) {
    const purge = async (p) => {
      try { await fetch('https://purge.jsdelivr.net/gh/WYgao29/zaolangzhe-data@main/' + p); console.log('  ↻ CDN 已刷新: ' + p); }
      catch (e) { console.log('  CDN 刷新失败（不影响数据）: ' + p); }
    };
    for (const f of Object.values(FEEDS)) await purge(f);
  }

  console.log(`\n完成：归档 { 推文 ${archive.x.x.reduce((n, b) => n + b.tweets.length, 0)} 条 · 播客 ${archive.podcasts.podcasts.length} 期 · 博客 ${archive.blogs.blogs.length} 篇 }，日报 ${Object.keys(state.digests).length} 份`);
}

main().catch(e => { console.error('管线失败：', e.message || e); process.exit(1); });
