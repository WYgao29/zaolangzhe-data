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

test('daily rule is the default schedule and the hourly rule is retained', () => {
  const install = fs.readFileSync(new URL('../local/install.sh', import.meta.url), 'utf8');
  const daily = fs.readFileSync(new URL('../local/com.zaolangzhe.summarize-daily.plist.tmpl', import.meta.url), 'utf8');
  const hourly = fs.readFileSync(new URL('../local/com.zaolangzhe.summarize.plist.tmpl', import.meta.url), 'utf8');

  assert.match(install, /RULE="\$\{1:-daily\}"/);
  assert.match(install, /install_one summarize-daily/);
  assert.match(install, /unload_one summarize/);
  assert.match(install, /install_one summarize/);
  assert.match(daily, /<key>Hour<\/key>\s*<integer>0<\/integer>/);
  assert.match(daily, /<key>Minute<\/key>\s*<integer>0<\/integer>/);
  assert.doesNotMatch(daily, /<key>KeepAlive<\/key>/);
  assert.equal((daily.match(/<key>Hour<\/key>/g) || []).length, 1);
  for (const hour of [15, 16, 17, 18, 19, 20, 21]) {
    assert.match(hourly, new RegExp(`<key>Hour</key><integer>${hour}</integer>`));
  }
});

test('daily rule runs once per Beijing day even when the first run fails', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zaolangzhe-daily-'));
  const local = path.join(root, 'local');
  fs.mkdirSync(local, { recursive: true });
  fs.copyFileSync(new URL('../local/summarize-daily.sh', import.meta.url), path.join(local, 'summarize-daily.sh'));
  fs.chmodSync(path.join(local, 'summarize-daily.sh'), 0o755);
  const marker = path.join(root, 'ran');
  fs.writeFileSync(path.join(local, 'summarize.sh'), `#!/bin/zsh
echo ran >> "${marker}"
exit 1
`);
  fs.chmodSync(path.join(local, 'summarize.sh'), 0o755);

  const script = path.join(local, 'summarize-daily.sh');
  const first = spawnSync('/bin/zsh', [script], { cwd: root, encoding: 'utf8' });
  const second = spawnSync('/bin/zsh', [script], { cwd: root, encoding: 'utf8' });
  const day = spawnSync('/bin/zsh', ['-c', 'TZ=Asia/Shanghai date +%F'], { encoding: 'utf8' });

  try {
    assert.equal(first.status, 1, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'ran');
    assert.equal(fs.readFileSync(path.join(local, 'daily-rule-stamp'), 'utf8').trim(), day.stdout.trim());
    assert.match(fs.readFileSync(path.join(local, 'logs', 'summarize.log'), 'utf8'), /不再重复/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
