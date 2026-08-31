import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { beijingDay } from '../pipeline/contract.js';

const SCRIPT = path.resolve('scripts/validate-data.js');

function repository({ badCount = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zaolangzhe-validate-'));
  const day = beijingDay(Date.now());
  const dayFile = {
    schemaVersion: 3, day, generatedAt: new Date().toISOString(),
    x: [{ id: 'one', handle: 'a', builder: 'A', bio: '', text: 'Hello', summaryZh: '中文总结', createdAt: new Date().toISOString(), url: 'https://x.com/a/status/one' }],
    podcasts: [], blogs: [],
  };
  fs.mkdirSync(path.join(root, 'data', 'days'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'days', `${day}.json`), JSON.stringify(dayFile));
  fs.writeFileSync(path.join(root, 'data', 'index.json'), JSON.stringify({
    schemaVersion: 3, generatedAt: dayFile.generatedAt,
    days: [{ day, path: `data/days/${day}.json`, counts: { x: badCount ? 2 : 1, podcasts: 0, blogs: 0 } }],
  }));
  return root;
}

test('validate-data CLI exits zero and reports counts for a valid repository', () => {
  const root = repository();
  const result = spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 天 · 推文 1 · 播客 0 · 博客 0/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('validate-data CLI exits nonzero when index counts drift', () => {
  const root = repository({ badCount: true });
  const result = spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /计数不一致/);
  fs.rmSync(root, { recursive: true, force: true });
});
