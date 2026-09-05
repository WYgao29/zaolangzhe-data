#!/bin/zsh
# 安装/更新本地总结的 launchd 定时任务（重复执行安全）。
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_SRC="$REPO/local/com.zaolangzhe.summarize.plist.tmpl"
PLIST_DST="$HOME/Library/LaunchAgents/com.zaolangzhe.summarize.plist"

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "未找到 node，请先安装或手动在 local/env 里设置 NODE_BIN" >&2
  exit 1
fi

# launchd 环境没有用户 PATH，把 node 绝对路径写进 local/env（不影响其他键）
touch "$REPO/local/env"
grep -q '^NODE_BIN=' "$REPO/local/env" || echo "NODE_BIN=$NODE_BIN" >> "$REPO/local/env"

mkdir -p "$REPO/local/logs" "$HOME/Library/LaunchAgents"
sed "s|__REPO__|$REPO|g" "$PLIST_SRC" > "$PLIST_DST"
chmod +x "$REPO/local/summarize.sh"

launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load "$PLIST_DST"

echo "已安装并加载：$PLIST_DST"
echo "手动试跑一次：launchctl kickstart -k gui/$(id -u)/com.zaolangzhe.summarize"
echo "查看日志：tail -f $REPO/local/logs/summarize.log"
echo "卸载：launchctl unload $PLIST_DST && rm $PLIST_DST"
