# zaolangzhe-data · 造浪者数据归档

[follow-builders](https://github.com/zarazhangrui/follow-builders) 公开聚合数据的分日归档。自动管线抓取上游完整快照，并按北京时间批次日写入 v3 日分片。云端 AI 总结目前已暂停，新数据只保存英文原文。

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

`state/processed.json` 只记录已处理的上游提交 SHA。去重、总结完整性和索引计数均从实际日分片重新推导，不依赖不断增长的处理清单。

## 自动管线

Actions 在北京时间 15:00–20:00 每小时运行一次，并在 21:30 再做一次晚间兜底；也支持手动触发和 `backfill_days` 参数。执行顺序为：

1. 运行全部 Node 测试。
2. 拉取上游三份完整 feed；任一缺失即失败。
3. 跨日去重，保留英文原文和已有的历史总结。
4. 将有变化的日分片及 index 原子写入。
5. 运行数据契约校验；通过后才提交更新。

URL 非 HTTP(S)、分片内或跨日重复、索引路径或计数漂移都会阻止发布。缺少 `summaryZh` 只会产生警告，不会阻止英文原文更新。AI 处理器和提示词仍保留在代码中，但工作队列默认关闭，Actions 不再注入智谱密钥。

## 本地命令

```bash
npm test
npm run validate:data
npm run dry-run
```

`dry-run` 会读取并合并上游快照，但不会写数据或状态。正常管线不需要任何 AI API Key。

## 恢复 AI 加工

AI 处理代码没有删除。未来换成可用的云端或本地 OpenAI 兼容接口后，先在本地执行全量补缺：

```bash
AI_PROCESSING_ENABLED=true ZHIPU_API_KEY=可用密钥 \
  node pipeline/process.js --include-all-missing
```

AI 模式会自动恢复“所有条目必须有 `summaryZh`”的严格校验；任何历史缺口未填完时都不会发布。全量补缺通过后，再把 `AI_PROCESSING_ENABLED=true` 和对应密钥注入 Actions；本次纯英文版本不注入这两项。

旧 v1 聚合格式已停止支持。当前 v2 到 v3 的转换由正式管线在内存中自动完成，无需单独运行迁移脚本或本地写数据。

```bash
gh workflow run pipeline.yml --repo WYgao29/zaolangzhe-data --ref main -f backfill_days=0
```

## 消费方

[follow-builders-web](https://github.com/WYgao29/follow-builders-web) 读取 index 及用户选择的最近 7/14/30 个日分片。网页端和本仓分别实现契约校验，并在 CI 中对真实数据做跨仓验证。

## 许可与内容版权

管线代码与仓库自有文件采用 [MIT License](LICENSE)。聚合内容及其相关权利归原作者或相应权利人所有；MIT 许可证不授予对这些内容的额外权利。中文总结用于个人信息整理，请在再分发或商用前确认相应授权。
