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
