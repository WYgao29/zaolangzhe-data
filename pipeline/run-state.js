import fs from 'node:fs';
import path from 'node:path';

/* 任务运行状态记录器：每次 record(patch) 把补丁合并进本地状态文件并原子写盘。
 * 面板服务只读这个文件，与管线完全解耦。 */
export function createRunStateRecorder(statePath, { now = () => new Date() } = {}) {
  const write = (state) => {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const temp = path.join(path.dirname(statePath), `.${path.basename(statePath)}.tmp-${process.pid}-${Date.now()}`);
    try {
      fs.writeFileSync(temp, JSON.stringify(state, null, 2) + '\n');
      fs.renameSync(temp, statePath);
    } finally {
      fs.rmSync(temp, { force: true });
    }
  };

  let state = {};
  return {
    record(patch = {}) {
      state = { ...state, ...patch, updatedAt: now().toISOString() };
      write(state);
      return state;
    },
    finish(result = {}) {
      state = { ...state, running: false, phase: 'done', result, updatedAt: now().toISOString() };
      write(state);
      return state;
    },
  };
}

/* 防重入判断：running 且状态文件在 maxAgeMs 内更新过 → 视为有任务活跃。
 * 长时间无更新（进程被杀等）视为僵尸状态，放行新任务避免永久锁死。 */
export function isRunActive(state, now = Date.now(), maxAgeMs = 6 * 60 * 60 * 1000) {
  if (!state?.running) return false;
  const updated = Date.parse(state.updatedAt || '');
  if (!Number.isFinite(updated)) return false;
  return now - updated < maxAgeMs;
}
