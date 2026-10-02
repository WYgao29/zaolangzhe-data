#!/bin/zsh
# 新定时规则：北京时间每天 24:00（00:00）运行一次。
# 只改启动时刻，不改归档 / 总结 / 发布。任务内容仍完全走 local/summarize.sh。
# 当天无论成功或失败都不再启动第二次。印记在启动前写入，中途崩溃也算已跑过。
# Mac 睡觉错过 24:00 时，唤醒后的那一次补跑仍会执行；补跑之后当天不再重复。
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1
mkdir -p local/logs
LOG="$REPO/local/logs/summarize.log"
STAMP="$REPO/local/daily-rule-stamp"
DAY="$(TZ=Asia/Shanghai date +%F)"

if [ -f "$STAMP" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$DAY" ]; then
  echo "===== $(date '+%F %T %z') 今日（$DAY）已运行过，无论成败都不再重复 =====" >> "$LOG"
  exit 0
fi

tmp="$(mktemp "$REPO/local/daily-rule-stamp.XXXXXX")"
print -r -- "$DAY" > "$tmp"
mv -f "$tmp" "$STAMP"

echo "===== $(date '+%F %T %z') 每日 24:00 规则启动（$DAY），本次后今日不再重复 =====" >> "$LOG"
"$REPO/local/summarize.sh" "$@"
code=$?
echo "===== $(date '+%F %T %z') 每日规则结束，退出码 $code；今日不再重复 =====" >> "$LOG"
exit $code
