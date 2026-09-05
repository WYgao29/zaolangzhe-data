#!/bin/zsh
# 造浪者本地中文总结入口（launchd 调用或手动运行）。
# 端点、模型名等配置从 local/env 读取；该文件不入库。
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1
mkdir -p local/logs
LOG="$REPO/local/logs/summarize.log"

{
  echo ""
  echo "===== $(date '+%F %T %z') 本地中文总结开始 ====="
  if [ -f local/env ]; then set -a; source local/env; set +a; fi
  NODE_BIN="${NODE_BIN:-$(command -v node)}"
  code=127
  if [ -z "$NODE_BIN" ]; then
    echo "未找到 node；请在 local/env 里设置 NODE_BIN=/绝对路径/node"
  else
    "$NODE_BIN" pipeline/summarize-local.js "$@"
    code=$?
  fi
  echo "===== $(date '+%F %T %z') 结束，退出码 $code ====="
} >> "$LOG" 2>&1
exit $code
