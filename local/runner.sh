#!/bin/zsh
# 消费面板投递的任务请求（launchd 每 60 秒拉起一次；无请求时立即退出）。
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 0

# launchd 的 PATH 很短，必须先加载本地配置再解析 NODE_BIN。
if [ -f "$REPO/local/env" ]; then set -a; source "$REPO/local/env"; set +a; fi
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
[ -n "$NODE_BIN" ] || exit 1

REQ="$REPO/local/trigger-request.json"
[ -f "$REQ" ] || exit 0

ACTION=$("$NODE_BIN" -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).action||"run")}catch(e){console.log("run")}' "$REQ" 2>/dev/null || echo run)
case "$ACTION" in run|retry) ;; *) ACTION="run" ;; esac
rm -f "$REQ"

mkdir -p local/logs

ARGS="--trigger dashboard"
[ "$ACTION" = "retry" ] && ARGS="$ARGS --include-all-missing"

{
  echo "===== $(date '+%F %T %z') runner 触发（$ACTION）====="
  "$NODE_BIN" pipeline/summarize-local.js $ARGS
  echo "===== $(date '+%F %T %z') runner 结束，退出码 $? ====="
} >> local/logs/runner.log 2>&1
exit 0
