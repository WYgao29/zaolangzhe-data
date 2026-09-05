import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRunStateRecorder } from '../pipeline/run-state.js';

function tmpStatePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zaolangzhe-state-')), 'run-state.json');
}

test('recorder merges patches and writes atomically with an updatedAt stamp', () => {
  const statePath = tmpStatePath();
  const recorder = createRunStateRecorder(statePath, { now: () => new Date(Date.parse('2026-09-05T15:40:00Z')) });

  recorder.record({ running: true, phase: 'archive', trigger: 'dashboard' });
  recorder.record({ phase: 'summarize', work: { total: 11, done: 1, failed: 0 } });

  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(state.running, true);
  assert.equal(state.phase, 'summarize', '第二次补丁合并而非覆盖');
  assert.equal(state.trigger, 'dashboard', '首次字段保留');
  assert.deepEqual(state.work, { total: 11, done: 1, failed: 0 });
  assert.equal(state.updatedAt, '2026-09-05T15:40:00.000Z');
  assert.equal(fs.readdirSync(path.dirname(statePath)).length, 1, '无临时文件残留');
});

test('recorder finish marks the run as not running with a result', () => {
  const statePath = tmpStatePath();
  const recorder = createRunStateRecorder(statePath, { now: () => new Date(Date.parse('2026-09-05T16:00:00Z')) });
  recorder.record({ running: true, phase: 'publish' });
  recorder.finish({ processed: 3, failed: 1, published: true });

  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(state.running, false);
  assert.deepEqual(state.result, { processed: 3, failed: 1, published: true });
  assert.equal(state.phase, 'done');
});
