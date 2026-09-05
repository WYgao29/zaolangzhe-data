#!/bin/zsh
# 安装/更新造浪者的三个 launchd 任务（重复执行安全）：
#   1. com.zaolangzhe.summarize —— 每天 15:40-21:40 归档 + 中文总结
#   2. com.zaolangzhe.runner    —— 每 60 秒消费面板投递的任务请求
#   3. com.zaolangzhe.dashboard —— 常驻可视化面板（127.0.0.1:8790）
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "未找到 node，请先安装或手动在 local/env 里设置 NODE_BIN" >&2
  exit 1
fi

# launchd 环境没有用户 PATH，把 node 绝对路径写进 local/env（不影响其他键）
touch "$REPO/local/env"
grep -q '^NODE_BIN=' "$REPO/local/env" || echo "NODE_BIN=$NODE_BIN" >> "$REPO/local/env"

mkdir -p "$REPO/local/logs" "$HOME/Library/LaunchAgents"
chmod +x "$REPO/local/summarize.sh" "$REPO/local/runner.sh" 2>/dev/null || true

install_one() {
  local name="$1"
  sed -e "s|__REPO__|$REPO|g" -e "s|__NODE__|$NODE_BIN|g" \
    "$REPO/local/com.zaolangzhe.$name.plist.tmpl" > "$HOME/Library/LaunchAgents/com.zaolangzhe.$name.plist"
  launchctl unload "$HOME/Library/LaunchAgents/com.zaolangzhe.$name.plist" 2>/dev/null || true
  launchctl load "$HOME/Library/LaunchAgents/com.zaolangzhe.$name.plist"
  echo "✓ 已安装并加载：com.zaolangzhe.$name"
}

install_one summarize
install_one runner
install_one dashboard

echo ""
echo "面板地址：http://127.0.0.1:8790"
echo "手动试跑总结：launchctl kickstart -k gui/$(id -u)/com.zaolangzhe.summarize"
echo "查看任务日志：tail -f $REPO/local/logs/summarize.log"
echo "卸载全部：launchctl unload ~/Library/LaunchAgents/com.zaolangzhe.*.plist"
