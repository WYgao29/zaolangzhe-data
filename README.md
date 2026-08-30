# zaolangzhe-data · 造浪者中文数据集

[follow-builders](https://github.com/zarazhangrui/follow-builders) 公开聚合数据的中文加工版。自动管线抓取上游完整快照，使用智谱 GLM 翻译或摘要新增内容，并按北京时间批次日写入 v2 日分片。

## v2 数据契约

```text
data/
├── index.json
└── days/
    └── YYYY-MM-DD.json
```

`data/index.json` 的 `days` 从新到旧排列，每项包含固定路径和三类内容的实际计数：

```json
{
  "schemaVersion": 2,
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

每个日分片均为 `{ schemaVersion, day, generatedAt, x, podcasts, blogs }`。三个内容字段都是扁平数组；唯一键依次为推文 `id`、播客 `guid`、博客 `url`。条目不再重复保存 `batchDay`，日期由分片的 `day` 表达。

`state/processed.json` 只记录已处理的上游提交 SHA。去重、翻译完整性和索引计数均从实际日分片重新推导，不依赖不断增长的处理清单。

## 自动管线

Actions 在北京时间 15:00–20:00 每小时运行一次，并在 21:30 再做一次晚间兜底；也支持手动触发和 `backfill_days` 参数。执行顺序为：

1. 运行全部 Node 测试。
2. 拉取上游三份完整 feed；任一缺失即失败。
3. 跨日去重并为新增或最近三天缺失译文的条目生成中文字段。
4. 将有变化的日分片及 index 原子写入。
5. 运行数据契约校验；通过后才提交更新。

AI 返回空文本、URL 非 HTTP(S)、分片内或跨日重复、索引路径或计数漂移都会阻止发布。较旧条目缺少翻译会作为警告报告。

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

旧 v1 聚合文件只在一次性迁移前存在。迁移工具可先检查旧输入，再原子替换为 v2；已迁移仓库可用 `--check-v2` 复核：

```bash
node pipeline/migrate-v2.js --check
node pipeline/migrate-v2.js
node pipeline/migrate-v2.js --check-v2
```

## 消费方

[follow-builders-web](https://github.com/WYgao29/follow-builders-web) 读取 index 及用户选择的最近 7/14/30 个日分片。网页端和本仓分别实现契约校验，并在 CI 中对真实数据做跨仓验证。

## 许可与内容版权

管线代码与仓库自有文件采用 [MIT License](LICENSE)。聚合内容及其相关权利归原作者或相应权利人所有；MIT 许可证不授予对这些内容的额外权利。译文用于个人信息整理，请在再分发或商用前确认相应授权。
