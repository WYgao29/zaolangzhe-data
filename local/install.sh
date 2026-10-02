#!/bin/zsh
# 安装/更新造浪者的 launchd 任务（重复执行安全）。
# 定时规则二选一，默认接入新规则 daily：
#   daily  —— com.zaolangzhe.summarize-daily，北京时间每天 24:00 一次，当天不重跑
#   hourly —— com.zaolangzhe.summarize，北京时间 15:40-21:40 每小时（旧规则，保留）
# runner（每 60 秒消费面板请求）和 dashboard（127.0.0.1:8790）始终安装。
set -euo pipefail

RULE="${1:-daily}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "未找到 node，请先安装或手动在 local/env 里设置 NODE_BIN" >&2
  exit 1
fi

# launchd 环境没有用户 PATH，把 node 绝对路径写进 local/env（不影响其他键）
touch "$REPO/local/env"
grep -q '^NODE_BIN=' "$REPO/local/env" || echo "NODE_BIN=$NODE_BIN" >> "$REPO/local/env"
chmod 600 "$REPO/local/env"

mkdir -p "$REPO/local/logs" "$HOME/Library/LaunchAgents"
chmod +x "$REPO/local/summarize.sh" "$REPO/local/summarize-daily.sh" "$REPO/local/runner.sh" 2>/dev/null || true

install_one() {
  local name="$1"
  sed -e "s|__REPO__|$REPO|g" -e "s|__NODE__|$NODE_BIN|g" \
    "$REPO/local/com.zaolangzhe.$name.plist.tmpl" > "$HOME/Library/LaunchAgents/com.zaolangzhe.$name.plist"
  launchctl unload "$HOME/Library/LaunchAgents/com.zaolangzhe.$name.plist" 2>/dev/null || true
  launchctl load "$HOME/Library/LaunchAgents/com.zaolangzhe.$name.plist"
  echo "✓ 已安装并加载：com.zaolangzhe.$name"
}

unload_one() {
  local name="$1"
  local plist="$HOME/Library/LaunchAgents/com.zaolangzhe.$name.plist"
  if [ -f "$plist" ]; then
    launchctl unload "$plist" 2>/dev/null || true
    rm -f "$plist"
    echo "✓ 已卸下：com.zaolangzhe.$name"
  fi
}

case "$RULE" in
  daily|midnight)
    install_one summarize-daily
    unload_one summarize
    ACTIVE="com.zaolangzhe.summarize-daily（每天 24:00 一次，当天不重跑）"
    ;;
  hourly)
    install_one summarize
    unload_one summarize-daily
    ACTIVE="com.zaolangzhe.summarize（15:40–21:40 每小时，旧规则）"
    ;;
  *)
    echo "未知规则：$RULE（可用 daily 或 hourly）" >&2
    exit 1
    ;;
esac

install_one runner
install_one dashboard

echo ""
echo "当前定时规则：$ACTIVE"
echo "面板地址：http://127.0.0.1:8790"
echo "切回旧规则：zsh local/install.sh hourly"
echo "查看任务日志：tail -f $REPO/local/logs/summarize.log"
