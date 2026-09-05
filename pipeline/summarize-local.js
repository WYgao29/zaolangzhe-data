#!/usr/bin/env node
/* 本地全量任务（launchd 定时触发）：
 * 1. 归档：抓上游英文快照并合并进日分片（断档时自动按缺口天数回放历史提交）
 * 2. 总结：为缺 summaryZh 的条目调用本地 OpenAI 兼容端点（MLX/LM Studio/Ollama）
 * 3. 发布：校验通过后一次提交推送 + jsDelivr 刷新
 * 分片即检查点——每完成一步原子写盘，崩溃重跑自动续；AI 失败不阻塞归档发布。 */
'use strict';

import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { beijingDay, buildIndex, validateIndex } from './contract.js';
import {
  archiveUpstreamSnapshots,
  createAIClient,
  processBlog,
  processPodcast,
  processTweet,
  purge,
  resolveAIConfig,
} from './process.js';
import { buildWorkQueue, loadRepository, writeRepository } from './storage.js';

const PROCESSORS = { x: processTweet, podcasts: processPodcast, blogs: processBlog };

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const DAY = 86400000;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const INCLUDE_ALL = args.includes('--include-all-missing');
const getArg = (name) => {
  const index = args.indexOf('--' + name);
  if (index === -1) return undefined;
  const raw = args[index + 1];
  return raw && !raw.startsWith('--') ? Number(raw) : undefined;
};
const recentArg = getArg('recent-days');
const RECENT_DAYS = Number.isFinite(recentArg) ? Math.max(0, recentArg) : 2;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/* 断档天数：最新数据日距北京日历日今天差几天（当天=0，昨天=1）。
 * 本地任务据此自动回放上游历史快照，Mac 关机漏掉的天数开机后一次补齐。 */
export function computeBackfillDays(newestDay, now = Date.now()) {
  if (!newestDay) return 0;
  const today = beijingDay(now);
  if (String(newestDay) >= today) return 0;
  const from = Date.parse(`${newestDay}T00:00:00Z`);
  const to = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(0, Math.round((to - from) / DAY));
}

/* 核心循环：依赖全部注入，便于测试。
 * 编排顺序：pull → 归档（含检查点）→ 建队列 → 逐条总结（含检查点）→ 校验 → 发布。
 * AI 失败只计数、不抛出——已成功内容与归档照常发布，失败条目下个时段自动重试。 */
export async function runSummarizer({
  pull, loadRepo, archive, buildQueue, summarize, checkpoint, validateAll, publish, log = () => {},
}) {
  await pull();
  const repository = await loadRepo();

  const archiveResult = await archive(repository);
  const changedDays = new Set(archiveResult.changedDays);
  if (changedDays.size) {
    await checkpoint(repository, changedDays);
    log(`归档上游：新增 ${archiveResult.addedKeys.size} · 重复 ${archiveResult.duplicates} · 更新 ${changedDays.size} 天`);
  }

  const queue = buildQueue(repository);
  log(`待总结 ${queue.work.length} 条（新增 ${queue.newCount} · 自愈 ${queue.selfHealCount}）`);
  if (!queue.work.length) log('没有需要总结的条目');

  let processed = 0;
  let failed = 0;
  for (const entry of queue.work) {
    const startedAt = Date.now();
    try {
      await summarize(entry);
      changedDays.add(entry.day);
      processed++;
      await checkpoint(repository, new Set([entry.day]));
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      log(`  ✓ ${entry.kind} ${entry.key} → ${entry.day} · ${seconds}s`);
    } catch (error) {
      failed++;
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      log(`  ✗ ${entry.kind} ${entry.key}（${seconds}s）：${error.message}`);
    }
  }

  const validation = validateAll(repository);
  if (validation.errors.length) throw new Error('数据校验失败，未提交推送:\n' + validation.errors.join('\n'));

  let published = false;
  if (changedDays.size) {
    await publish({ changedDays });
    published = true;
  } else {
    log('没有需要发布的变化，结束');
  }
  return { processed, failed, published };
}

async function git(root, gitArgs, { timeout = 120000 } = {}) {
  const { stdout } = await execFileAsync('git', gitArgs, { cwd: root, timeout, maxBuffer: 1024 * 1024 });
  return stdout;
}

export async function pushWithRetry(root, { attempts = 3, log = console.log } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await git(root, ['push']);
      return;
    } catch (error) {
      if (attempt === attempts) throw error;
      log(`  ↻ push 失败（${String(error.stderr || error.message).trim().slice(0, 120)}），rebase 后重试 ${attempt + 1}/${attempts}`);
      await git(root, ['pull', '--rebase', '--autostash']);
      await sleep(2000);
    }
  }
}

export async function main(runtimeArgs = args) {
  // fail-fast：本工具面向本地端点。未显式设置 AI_PROVIDER 时会默认落到 zhipu
  // 云端（通常没有密钥），整批 401 白跑——必须在动任何数据前拒绝。
  if (!process.env.AI_PROVIDER) {
    throw new Error('summarize-local 需要本地端点配置：请通过 local/env（AI_PROVIDER=openai）或环境变量提供；云端应急请用 workflow_dispatch 或 pipeline/process.js');
  }
  const AI_CONFIG = resolveAIConfig(process.env);
  if (AI_CONFIG.needsKey && !AI_CONFIG.apiKey) throw new Error('缺少 AI_API_KEY');
  const dryRun = runtimeArgs.includes('--dry-run');
  console.log(`造浪者本地任务 · ${AI_CONFIG.provider}:${AI_CONFIG.model} · 最近 ${RECENT_DAYS} 天${INCLUDE_ALL ? ' · 全量补漏' : ''}${dryRun ? ' · DRY-RUN' : ''}`);

  const result = await runSummarizer({
    log: console.log,
    pull: async () => {
      if (dryRun) return console.log('DRY-RUN：跳过 git pull');
      const stdout = await git(ROOT, ['pull', '--rebase', '--autostash']);
      console.log('已同步远端：' + stdout.trim().split('\n')[0]);
    },
    loadRepo: async () => loadRepository(ROOT, { migrateV2: true, requireAllSummaries: false }),
    archive: async (repository) => {
      if (dryRun) return { addedKeys: new Set(), changedDays: new Set(), duplicates: 0, fetched: 0 };
      const newestDay = repository.index?.days?.[0]?.day || '';
      const backfillDays = computeBackfillDays(newestDay, Date.now());
      if (backfillDays > 0) console.log(`检测到数据缺口 ${backfillDays} 天，自动回放上游历史快照`);
      return archiveUpstreamSnapshots(repository, { backfillDays });
    },
    buildQueue: (repository) => buildWorkQueue(repository.dayFiles, {
      now: Date.now(), aiEnabled: true, includeAllMissing: INCLUDE_ALL, recentDays: RECENT_DAYS,
    }),
    summarize: async (entry) => {
      if (dryRun) return; // 预览队列即可，不调用模型、不改动数据
      await PROCESSORS[entry.kind](entry.item, createAIClient(AI_CONFIG));
    },
    checkpoint: async (repository, days) => {
      if (dryRun) return;
      writeRepository(ROOT, repository.dayFiles, new Date().toISOString(), days, { requireAllSummaries: false });
    },
    validateAll: (repository) => validateIndex(
      buildIndex(repository.dayFiles, new Date().toISOString()),
      repository.dayFiles,
      { requireAllSummaries: false }, // 解耦：缺总结只是警告，不得阻塞归档发布
    ),
    publish: async ({ changedDays }) => {
      if (dryRun) return console.log(`DRY-RUN：将更新 ${changedDays.size} 天，不提交推送`);
      const status = await git(ROOT, ['status', '--porcelain', '--', 'data']);
      if (!status.trim()) return console.log('无新增内容，跳过提交');
      await git(ROOT, ['add', 'data']);
      await git(ROOT, ['commit', '-m', `本地中文总结 ${new Date().toISOString().slice(0, 10)}`]);
      await pushWithRetry(ROOT);
      console.log('已推送 GitHub');
      await purge(['data/index.json', ...[...changedDays].map(day => `data/days/${day}.json`)]);
    },
  });
  console.log(`完成：成功 ${result.processed}，失败 ${result.failed}${result.published ? '，已发布' : ''}${result.failed ? '（失败条目下个时段自动重试）' : ''}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error('本地任务失败：', error.message || error); process.exit(1); });
}
