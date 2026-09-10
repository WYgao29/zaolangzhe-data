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
  code=1
  # 先同步代码，再启动 Node。否则 Node 会先加载旧版 contract.js，
  # 随后的进程内 git pull 又可能把新版 data 拉进来，造成版本错配。
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1 && ! git pull --rebase --autostash; then
    echo "同步远端失败；为避免旧代码校验新数据，本次不启动本地任务"
  else
    if [ -f local/env ]; then set -a; source local/env; set +a; fi
    NODE_BIN="${NODE_BIN:-$(command -v node)}"
    code=127
    if [ -z "$NODE_BIN" ]; then
      echo "未找到 node；请在 local/env 里设置 NODE_BIN=/绝对路径/node"
    else
      "$NODE_BIN" pipeline/summarize-local.js --trigger schedule "$@"
      code=$?
    fi
  fi
  echo "===== $(date '+%F %T %z') 结束，退出码 $code ====="
} >> "$LOG" 2>&1
exit $code
