#!/usr/bin/env node
/* 本地中文总结：launchd 定时触发，在本地 OpenAI 兼容端点（MLX/LM Studio/Ollama）上
 * 为日分片中缺 summaryZh 的条目生成总结。分片即检查点——每完成一条原子写盘，
 * 崩溃重跑自动跳过已完成条目；全部成功且校验通过后才一次提交推送。 */
'use strict';

import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { buildIndex, validateIndex } from './contract.js';
import { createAIClient, processBlog, processPodcast, processTweet, purge, resolveAIConfig } from './process.js';
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

/* 核心循环：依赖全部注入，便于测试。任何一条失败都不推送；
 * 已成功条目的检查点留在本地分片里，下次运行自动续跑。 */
export async function runSummarizer({
  pull, loadRepo, buildQueue, summarize, checkpoint, validateAll, publish, log = () => {},
}) {
  await pull();
  const repository = await loadRepo();
  const queue = buildQueue(repository);
  log(`待总结 ${queue.work.length} 条（新增 ${queue.newCount} · 自愈 ${queue.selfHealCount}）`);
  if (!queue.work.length) {
    log('没有需要总结的条目，结束');
    return { processed: 0, failed: 0, published: false };
  }
  const changedDays = new Set();
  let processed = 0;
  let failed = 0;
  for (const entry of queue.work) {
    const startedAt = Date.now();
    try {
      await summarize(entry);
      changedDays.add(entry.day);
      processed++;
      await checkpoint(repository, entry.day);
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      log(`  ✓ ${entry.kind} ${entry.key} → ${entry.day} · ${seconds}s`);
    } catch (error) {
      failed++;
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      log(`  ✗ ${entry.kind} ${entry.key}（${seconds}s）：${error.message}`);
    }
  }
  if (failed) throw new Error(`${failed} 条总结失败，未提交推送（成功条目已存为本地检查点）`);
  const validation = validateAll(repository);
  if (validation.errors.length) throw new Error('数据校验失败，未提交推送:\n' + validation.errors.join('\n'));
  await publish({ changedDays });
  return { processed, failed: 0, published: true };
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
  const AI_CONFIG = resolveAIConfig(process.env);
  const dryRun = runtimeArgs.includes('--dry-run');
  console.log(`本地中文总结 · ${AI_CONFIG.provider}:${AI_CONFIG.model} · 最近 ${RECENT_DAYS} 天${INCLUDE_ALL ? ' · 全量补漏' : ''}${dryRun ? ' · DRY-RUN' : ''}`);

  const result = await runSummarizer({
    log: console.log,
    pull: async () => {
      if (dryRun) return console.log('DRY-RUN：跳过 git pull');
      const stdout = await git(ROOT, ['pull', '--rebase', '--autostash']);
      console.log('已同步远端：' + stdout.trim().split('\n')[0]);
    },
    loadRepo: async () => loadRepository(ROOT, { migrateV2: true, requireAllSummaries: false }),
    buildQueue: (repository) => buildWorkQueue(repository.dayFiles, {
      now: Date.now(), aiEnabled: true, includeAllMissing: INCLUDE_ALL, recentDays: RECENT_DAYS,
    }),
    summarize: async (entry) => {
      if (dryRun) return; // 预览队列即可，不调用模型、不改动数据
      await PROCESSORS[entry.kind](entry.item, createAIClient(AI_CONFIG));
    },
    checkpoint: async (repository, day) => {
      if (dryRun) return;
      writeRepository(ROOT, repository.dayFiles, new Date().toISOString(), new Set([day]), { requireAllSummaries: false });
    },
    validateAll: (repository) => validateIndex(
      buildIndex(repository.dayFiles, new Date().toISOString()),
      repository.dayFiles,
      { requireAllSummaries: INCLUDE_ALL },
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
  console.log(`完成：成功 ${result.processed}，失败 ${result.failed}${result.published ? '，已发布' : ''}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error('本地总结失败：', error.message || error); process.exit(1); });
}
