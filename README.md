# zaolangzhe-data · 造浪者数据归档

[follow-builders](https://github.com/zarazhangrui/follow-builders) 公开聚合数据的分日归档。Actions 每小时抓取上游完整快照并按北京时间批次日写入英文 v3 日分片（公开仓库免费、不消耗 token）；中文总结由本机 launchd 定时任务调用本地模型生成后推送，云端 AI 不再消耗 token。

## v3 数据契约

```text
data/
├── index.json
└── days/
    └── YYYY-MM-DD.json
```

`data/index.json` 的 `days` 从新到旧排列，每项包含固定路径和三类内容的实际计数：

```json
{
  "schemaVersion": 3,
  "generatedAt": "2026-08-30T06:55:52.607Z",
  "days": [
    {
      "day": "2026-08-30",
      "path": "data/days/2026-08-30.json",
      "counts": { "x": 18, "podcasts": 1, "blogs": 0 }
    }
  ]
}
```

每个日分片均为 `{ schemaVersion, day, generatedAt, x, podcasts, blogs }`。三个内容字段都是扁平数组；唯一键依次为推文 `id`、播客 `guid`、博客 `url`。英文原文保存在 `text`、`transcript` 或 `content`。`summaryZh` 是可选的历史中文总结字段；v3 不保存中文标题或全文翻译。

仓库不维护任何状态文件：去重、总结完整性和索引计数均从实际日分片重新推导，不依赖不断增长的处理清单。

## 自动管线

Actions 在北京时间 15:00–20:00 每小时运行一次，并在 21:30 再做一次晚间兜底；也支持手动触发和 `backfill_days` 参数。执行顺序为：

1. **单写者守卫**：定时触发时，若最近 26 小时内有"本地中文总结"推送，则整体跳过（本地 launchd 任务是数据的日常写入者，避免两写者对单行 JSON 分片 rebase 撞车；Mac 掉线超 26 小时后 Actions 自动接管。手动触发不受限）。
2. 运行全部 Node 测试。
3. 拉取上游三份完整 feed；任一缺失即失败。
4. 跨日去重，保留英文原文和已有的历史总结。
5. 将有变化的日分片及 index 原子写入。
6. 运行数据契约校验；通过后才提交更新。

URL 非 HTTP(S)、分片内或跨日重复、索引路径或计数漂移都会阻止发布。缺少 `summaryZh` 只会产生警告，不会阻止英文原文更新。AI 处理器和提示词仍保留在代码中，但工作队列默认关闭，Actions 不再注入智谱密钥。

## 本地命令

```bash
npm test
npm run validate:data
npm run dry-run
```

`dry-run` 会读取并合并上游快照，但不会写数据或状态。正常管线不需要任何 AI API Key。

## 本地中文总结（MLX）

本地任务只做"总结"这一步：`git pull --rebase` 拿到 Actions 归档的最新英文数据 → 找出缺 `summaryZh` 的条目（默认最近 2 天）→ 逐条调用本地 OpenAI 兼容端点总结 → 每完成一条原子写盘（**分片即检查点**，崩溃重跑自动跳过已完成条目）→ 全量校验 → 一次提交推送 → jsDelivr 刷新。触发时间在 Actions 整点归档之后 40 分钟（15:40–21:40），配合推送失败自动 rebase 重试，两条管线幂等共存。

```bash
# 1. 配置端点：复制 local/env.example 为 local/env，填 AI_BASE_URL 和 AI_MODEL
# 2. 预览待总结队列（不调模型、不写文件）
node pipeline/summarize-local.js --dry-run
# 3. 手动跑一次（需本地模型服务已启动）
zsh local/summarize.sh
# 4. 安装 launchd 定时任务（每天 15:40–21:40，Mac 唤醒后自动补跑错过的时段）
zsh local/install.sh
```

可选参数：`--recent-days N` 扩大补漏窗口（默认 2 天）；`--include-all-missing` 全量补齐历史缺口（此模式要求所有条目都有总结才允许发布）。端点只支持 http/https，凭据一律走环境变量、不写入仓库。

注意仓库位置：**不要把本仓库克隆放进 `~/Documents`、`~/Desktop` 等受 TCC 保护的目录**——launchd 直接派生的进程会被 macOS 隐私保护拒绝访问（Operation not permitted）。家目录下的普通路径（如 `~/zaolangzhe-data`）即可。

## 恢复云端 AI 加工（可选）

提供者由 `AI_PROVIDER` 决定：默认 `zhipu`（智谱云端，保留专有 thinking 字段，需要密钥）；`openai` 为任意 OpenAI 兼容端点（本地 MLX/LM Studio/Ollama 等，无需密钥），超时与并发可用 `AI_TIMEOUT_MS`、`AI_CONCURRENCY` 覆盖。云端全量补缺（消耗 token，谨慎使用）：

```bash
AI_PROCESSING_ENABLED=true ZHIPU_API_KEY=可用密钥 \
  node pipeline/process.js --include-all-missing
```

旧 v1 聚合格式已停止支持。当前 v2 到 v3 的转换由正式管线在内存中自动完成，无需单独运行迁移脚本或本地写数据。

```bash
gh workflow run pipeline.yml --repo WYgao29/zaolangzhe-data --ref main -f backfill_days=0
```

## 消费方

[follow-builders-web](https://github.com/WYgao29/follow-builders-web) 读取 index 及用户选择的最近 7/14/30 个日分片。网页端和本仓分别实现契约校验，并在 CI 中对真实数据做跨仓验证。

## 许可与内容版权

管线代码与仓库自有文件采用 [MIT License](LICENSE)。聚合内容及其相关权利归原作者或相应权利人所有；MIT 许可证不授予对这些内容的额外权利。中文总结用于个人信息整理，请在再分发或商用前确认相应授权。
