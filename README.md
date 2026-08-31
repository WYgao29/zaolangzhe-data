# zaolangzhe-data · 造浪者中文数据集

[follow-builders](https://github.com/zarazhangrui/follow-builders) 公开聚合数据的中文总结版。自动管线抓取上游完整快照，使用智谱 GLM 总结新增内容，并按北京时间批次日写入 v3 日分片。

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

每个日分片均为 `{ schemaVersion, day, generatedAt, x, podcasts, blogs }`。三个内容字段都是扁平数组；唯一键依次为推文 `id`、播客 `guid`、博客 `url`。英文原文保存在 `text`、`transcript` 或 `content`，唯一中文内容字段为 `summaryZh`；v3 不保存中文标题或全文翻译。

`state/processed.json` 只记录已处理的上游提交 SHA。去重、总结完整性和索引计数均从实际日分片重新推导，不依赖不断增长的处理清单。

## 自动管线

Actions 在北京时间 15:00–20:00 每小时运行一次，并在 21:30 再做一次晚间兜底；也支持手动触发和 `backfill_days` 参数。执行顺序为：

1. 运行全部 Node 测试。
2. 拉取上游三份完整 feed；任一缺失即失败。
3. 跨日去重并为新增或最近三天缺失总结的条目生成 `summaryZh`。
4. 将有变化的日分片及 index 原子写入。
5. 运行数据契约校验；通过后才提交更新。

AI 返回空文本、URL 非 HTTP(S)、分片内或跨日重复、索引路径或计数漂移都会阻止发布。v2 首次升级会删除历史翻译字段，复用播客和博客已有总结，并为所有缺少总结的历史推文执行一次性回填；只有完整 v3 仓库校验通过才会提交。

## 本地命令

```bash
npm test
npm run validate:data
npm run dry-run
```

`dry-run` 会读取并合并上游快照、构建待处理队列，但不会调用 AI，也不会写数据或状态。实际加工需要环境变量：

```bash
ZHIPU_API_KEY=你的密钥 node pipeline/process.js
```

旧 v1 聚合文件只在一次性 v2 迁移前存在；`pipeline/migrate-v2.js` 仅保留作历史维护工具。当前 v2 到 v3 的转换由正式管线在内存中自动完成，无需本地写数据。

```bash
gh workflow run pipeline.yml --repo WYgao29/zaolangzhe-data --ref main -f backfill_days=0
```

## 消费方

[follow-builders-web](https://github.com/WYgao29/follow-builders-web) 读取 index 及用户选择的最近 7/14/30 个日分片。网页端和本仓分别实现契约校验，并在 CI 中对真实数据做跨仓验证。

## 许可与内容版权

管线代码与仓库自有文件采用 [MIT License](LICENSE)。聚合内容及其相关权利归原作者或相应权利人所有；MIT 许可证不授予对这些内容的额外权利。中文总结用于个人信息整理，请在再分发或商用前确认相应授权。
