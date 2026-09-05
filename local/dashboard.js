#!/usr/bin/env node
/* 造浪者控制台：本机常驻的零依赖面板服务。
 * GET  /            → 单页面板
 * GET  /api/status  → 聚合：任务状态 / 数据总览 / git 同步 / omlx 存活 / 运行历史
 * POST /api/trigger → 投递任务请求（action: run | retry），由 runner 代理在
 *                     1 分钟内消费执行。本服务自身不执行任何命令：
 *                     安全边界 = 只读数据文件 + 原子写一个请求 JSON。
 * 只绑定 127.0.0.1，凭据从 local/env 读取，不落入任何响应。 */
'use strict';

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

function readEnvFile(envPath) {
  const env = {};
  try {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (match) env[match[1]] = match[2].trim();
    }
  } catch { /* 无 env 文件时忽略 */ }
  return env;
}

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

function scanData(root) {
  const index = readJSON(path.join(root, 'data', 'index.json'));
  if (!index || !Array.isArray(index.days)) return { days: 0, items: 0, missingSummaries: 0, newestDay: null };
  let items = 0;
  let missingSummaries = 0;
  for (const entry of index.days) {
    const file = readJSON(path.join(root, entry.path));
    if (!file) continue;
    for (const kind of ['x', 'podcasts', 'blogs']) {
      for (const item of file[kind] || []) {
        items++;
        if (!String(item.summaryZh || '').trim()) missingSummaries++;
      }
    }
  }
  return { days: index.days.length, items, missingSummaries, newestDay: index.days[0]?.day || null };
}

function readHistory(root, limit = 20) {
  try {
    return fs.readFileSync(path.join(root, 'local', 'history.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean).slice(-limit)
      .map(line => { try { return JSON.parse(line); } catch { return { line }; } })
      .reverse();
  } catch { return []; }
}

/* 只读 git 查询（参数全为常量）与 omlx 存活探测 */
async function gitStatus(root, gitImpl) {
  const safe = (promise) => promise.then(v => String(v).trim()).catch(() => '');
  const [ahead, behind, lastCommit] = await Promise.all([
    safe(gitImpl(['rev-list', '--count', 'origin/main..main'])),
    safe(gitImpl(['rev-list', '--count', 'main..origin/main'])),
    safe(gitImpl(['log', '-1', '--format=%h %s'])),
  ]);
  return { ahead: Number(ahead) || 0, behind: Number(behind) || 0, lastCommit };
}

export async function omlxStatus(baseUrl, apiKey, fetchImpl = fetch) {
  // AI_BASE_URL 可能带或不带 /v1 前缀，探测时两个候选都试，避免拼出 /v1/v1
  const root = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  const candidates = [`${root}/v1/models`, `${root}/models`];
  for (const url of candidates) {
    try {
      const response = await fetchImpl(url, {
        headers: apiKey ? { Authorization: 'Bearer ' + apiKey } : {},
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) continue;
      const data = await response.json();
      return { alive: true, reachable: true, models: (data.data || []).map(m => m.id) };
    } catch { /* 试下一个候选 */ }
  }
  return { alive: true, reachable: false, models: [] };
}

export function createDashboardServer(deps = {}) {
  const root = deps.root || ROOT;
  const envPath = path.join(root, 'local', 'env');
  const gitImpl = deps.gitImpl || (async (args) => (await execFileAsync('git', args, { cwd: root, timeout: 10000 })).stdout);
  const omlxProbe = deps.omlxProbe || null;
  const now = deps.now || (() => new Date().toISOString());

  async function buildStatus() {
    const env = readEnvFile(envPath);
    const baseUrl = env.AI_BASE_URL || '';
    const apiKey = env.AI_API_KEY || '';
    const [git, omlx] = await Promise.all([
      gitStatus(root, gitImpl),
      deps.omlxProbe
        ? Promise.resolve(deps.omlxProbe())
        : baseUrl ? omlxStatus(baseUrl, apiKey) : Promise.resolve({ alive: false, models: [] }),
    ]);
    return {
      now: now(),
      run: readJSON(path.join(root, 'local', 'run-state.json')) || { running: false, phase: 'idle' },
      data: scanData(root),
      git,
      omlx,
      history: readHistory(root),
      pendingTrigger: readJSON(path.join(root, 'local', 'trigger-request.json')) || null,
    };
  }

  function handleTrigger(body) {
    const action = body?.action;
    if (action !== 'run' && action !== 'retry') return { status: 400, body: { error: 'action 必须是 run 或 retry' } };
    const runState = readJSON(path.join(root, 'local', 'run-state.json'));
    if (runState?.running) return { status: 409, body: { error: '任务正在运行，请稍后再试' } };
    const requestPath = path.join(root, 'local', 'trigger-request.json');
    fs.writeFileSync(requestPath, JSON.stringify({ action, requestedAt: now() }, null, 2) + '\n');
    return { status: 200, body: { queued: true, action, message: '任务请求已投递，runner 将在 1 分钟内启动' } };
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const html = fs.readFileSync(path.join(HERE, 'dashboard.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(await buildStatus()));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/trigger') {
        let body = '';
        for await (const chunk of req) body += chunk;
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch { /* 保持空对象 */ }
        const result = handleTrigger(parsed);
        res.writeHead(result.status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result.body));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'not found' }));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: error.message || 'internal error' }));
    }
  });
}

export function startDashboard({ port = Number(process.env.DASHBOARD_PORT) || 8790, ...deps } = {}) {
  const server = createDashboardServer(deps);
  server.listen(port, '127.0.0.1', () => console.log(`造浪者控制台：http://127.0.0.1:${port}`));
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startDashboard();
}
