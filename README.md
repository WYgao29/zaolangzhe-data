# zaolangzhe-data · 造浪者中文数据集

[follow-builders](https://github.com/zarazhangrui/follow-builders) 数据集的中文加工版：GitHub Actions 每天 15:30（北京时间）自动抓取上游最新数据，用智谱 GLM 逐条翻译/摘要后提交到本仓库。

## 数据文件

| 文件 | 内容 |
|---|---|
| `data/feed-x.json` | X 推文归档（每条含 `textZh` 中文译文） |
| `data/feed-podcasts.json` | 播客单集归档（含 `titleZh` 中文标题、`summaryZh` 中文要点摘要） |
| `data/feed-blogs.json` | 博客文章归档（含 `titleZh`/`contentZh` 全文翻译、`summaryZh` 摘要） |
| `digest/YYYY-MM-DD.json` | 每日 AI 中文日报（`{ day, markdown }`） |
| `state/processed.json` | 管线断点状态（已处理内容清单，防重复） |

所有条目含 `batchDay` 字段（采集批次日，北京日历日）。英文原文始终保留在同一条目中。

## 更新机制

- 每天 15:30（北京）由 GitHub Actions 自动运行 `pipeline/process.js`
- 手动触发：Actions 页面 → pipeline → Run workflow（可填 `backfill_days` 补加工近 N 天）
- 本地运行：`ZHIPU_API_KEY=你的key node pipeline/process.js`

## 消费方

「造浪者」网页（follow-builders-web）直接读取本仓库 `data/` 与 `digest/` 文件。

## 版权

聚合内容（推文/播客/博客）版权归原作者所有，译文为个人阅读用途的衍生处理，请勿商用。
