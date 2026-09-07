import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('runner loads local/env before resolving NODE_BIN and does not block on stale state', () => {
  const source = fs.readFileSync(new URL('../local/runner.sh', import.meta.url), 'utf8');
  assert.ok(source.indexOf('source "$REPO/local/env"') < source.indexOf('ACTION='), 'local/env 必须在首次使用 NODE_BIN 前加载');
  assert.doesNotMatch(source, /grep -q '\"running\": true'/, 'runner 不应再用脆弱的字符串匹配阻塞僵尸任务');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zaolangzhe-runner-'));
  const local = path.join(root, 'local');
  fs.mkdirSync(path.join(local, 'logs'), { recursive: true });
  fs.copyFileSync(new URL('../local/runner.sh', import.meta.url), path.join(local, 'runner.sh'));
  fs.chmodSync(path.join(local, 'runner.sh'), 0o755);
  const marker = path.join(root, 'mock-node.log');
  const mockNode = path.join(root, 'mock-node.sh');
  fs.writeFileSync(mockNode, `#!/bin/zsh
if [ "$1" = "-e" ]; then
  echo run
else
  print -r -- "$*" >> "${marker}"
fi
`);
  fs.chmodSync(mockNode, 0o755);
  fs.writeFileSync(path.join(local, 'env'), `NODE_BIN=${mockNode}\n`);
  fs.writeFileSync(path.join(local, 'trigger-request.json'), JSON.stringify({ action: 'run' }));
  fs.writeFileSync(path.join(local, 'run-state.json'), JSON.stringify({ running: true, updatedAt: '2026-09-06T00:00:00.000Z' }));

  const { NODE_BIN: _ignored, ...envWithoutNodeBin } = process.env;
  const result = spawnSync('/bin/zsh', [path.join(local, 'runner.sh')], {
    cwd: root,
    env: envWithoutNodeBin,
    encoding: 'utf8',
  });

  try {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(local, 'trigger-request.json')), false, '请求应被消费');
    assert.match(fs.readFileSync(marker, 'utf8'), /pipeline\/summarize-local\.js/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('install script locks local/env to owner-only permissions', () => {
  const script = fs.readFileSync(new URL('../local/install.sh', import.meta.url), 'utf8');
  assert.match(script, /chmod 600 "\$REPO\/local\/env"/);
});
