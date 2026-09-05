#!/bin/zsh
# 消费面板投递的任务请求（launchd 每 60 秒拉起一次；无请求时立即退出）。
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 0
REQ="$REPO/local/trigger-request.json"
[ -f "$REQ" ] || exit 0

# 有任务在跑就先不启动（状态文件由任务自身维护）
STATE="$REPO/local/run-state.json"
if [ -f "$STATE" ] && grep -q '"running": true' "$STATE"; then exit 0; fi

ACTION=$("$NODE_BIN" -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).action||"run")}catch(e){console.log("run")}' "$REQ" 2>/dev/null || echo run)
case "$ACTION" in run|retry) ;; *) ACTION="run" ;; esac
rm -f "$REQ"

mkdir -p local/logs
if [ -f local/env ]; then set -a; source local/env; set +a; fi
NODE_BIN="${NODE_BIN:-$(command -v node)}"
[ -z "$NODE_BIN" ] && exit 1

ARGS="--trigger dashboard"
[ "$ACTION" = "retry" ] && ARGS="$ARGS --include-all-missing"

{
  echo "===== $(date '+%F %T %z') runner 触发（$ACTION）====="
  "$NODE_BIN" pipeline/summarize-local.js $ARGS
  echo "===== $(date '+%F %T %z') runner 结束，退出码 $? ====="
} >> local/logs/runner.log 2>&1
exit 0
