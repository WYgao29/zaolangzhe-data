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

## 全本地架构

数据的归档与中文总结全部由**本机 launchd 任务**（`com.zaolangzhe.summarize`，北京时间 15:40–21:40 每小时，Mac 唤醒后自动补跑错过的时段）完成，单一写入者，无两写冲突：

1. **归档**：抓取上游最新快照并合并进英文日分片；启动时检测数据缺口（最新数据日早于今天），按缺口天数自动回放上游历史提交——Mac 关机漏掉的天数开机后一次补齐。
2. **总结**：为缺 `summaryZh` 的条目调用本地模型生成中文总结，逐条原子写盘（分片即检查点，崩溃重跑自动续）。超长内容不做截断：自动识别长度，超出单请求预算（6 万字符）的转录/文章按段落边界分段、逐段提取要点后整合成最终总结（map→reduce）。
3. **发布**：契约校验通过后一次提交推送 + jsDelivr 刷新。AI 失败不阻塞归档发布——英文数据照常上线，失败条目下个时段自动重试。

云端 Actions 仅保留 `workflow_dispatch` 手动触发作为应急通道（Mac 长期不可用时回填英文），并受单写者守卫约束：最近 26 小时内有"本地中文总结"推送时，云端运行（含手动）自动跳过。

## 造浪者控制台（本地面板）

常驻本机的可视化面板（`http://127.0.0.1:8790`，launchd KeepAlive 常驻）：

- **当前任务**：阶段（同步/归档/总结/发布）、进度条、正在处理的条目、失败数、错误信息
- **数据总览**：覆盖天数、内容总数、缺总结数、最新数据日、与 GitHub 的同步状态
- **omlx 状态**：服务存活探测、可用模型列表
- **运行历史**：最近 20 次运行的时间、触发方式（定时/面板/手动）与结果
- **任务按钮**：「立即跑一轮」「重试失败条目」——投递请求文件，由 `com.zaolangzhe.runner`（60 秒间隔）消费执行；面板自身不执行任何命令

安装：`zsh local/install.sh` 一次装齐三个 launchd 任务（summarize / runner / dashboard）。

## 本地命令

```bash
# 手动跑一轮完整任务（归档 + 总结 + 推送；需 oMLX 与 local/env 就绪）
zsh local/summarize.sh
# 预览待总结队列与归档缺口（不调模型、不写文件）
node pipeline/summarize-local.js --dry-run
# 全量补齐历史缺口（含中文总结）
node pipeline/summarize-local.js --include-all-missing
npm test
npm run validate:data
```

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
