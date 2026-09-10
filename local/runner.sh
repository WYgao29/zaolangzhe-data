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

mkdir -p local/logs

# 先同步代码，再启动 Node。否则 Node 会先加载旧版 contract.js，
# 随后的进程内 git pull 又可能把新版 data 拉进来，造成版本错配。
if git rev-parse --is-inside-work-tree >/dev/null 2>&1 && ! git pull --rebase --autostash >> local/logs/runner.log 2>&1; then
  echo "===== $(date '+%F %T %z') runner 同步失败，本次不启动本地任务 =====" >> local/logs/runner.log
  exit 1
fi

ACTION=$("$NODE_BIN" -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).action||"run")}catch(e){console.log("run")}' "$REQ" 2>/dev/null || echo run)
case "$ACTION" in run|retry) ;; *) ACTION="run" ;; esac
rm -f "$REQ"

ARGS="--trigger dashboard"
[ "$ACTION" = "retry" ] && ARGS="$ARGS --include-all-missing"

{
  echo "===== $(date '+%F %T %z') runner 触发（$ACTION）====="
  "$NODE_BIN" pipeline/summarize-local.js $ARGS
  echo "===== $(date '+%F %T %z') runner 结束，退出码 $? ====="
} >> local/logs/runner.log 2>&1
exit 0
