# issue #42 回复草稿

> 用途：回复 <https://github.com/dingminhua/dsh-connect-trae/issues/42>
> （ahian-lee：「CN 区 32/32 模型没有 maxTokens：上游不发布 max_tokens？建议加覆盖入口或文档说明」）
>
> **状态：4.0.1 已发布**（GitHub Release [v4.0.1](https://github.com/dingminhua/dsh-connect-trae/releases/tag/v4.0.1)）。
> `pnpm run check` 全绿（typecheck + 901 测试 + build）。可直接复制横线以内的内容。

---

先谢谢这份报告——取证链贴得比我自己的排查还完整，尤其是「已经排除字段名」那一节省了我半天。
**你的方向对了一半：上游确实发布 `max_tokens`，但插件把它弄丢在了一个你从外面看不到的环节。**
走的正是你建议里的第 3 条（补字段），而且比补解析更简单：解析从来是对的，丢在**合并**。

## 结论先讲

我用本机 CN 凭据把整条链实测了一遍（只读，`scripts/probe-cn-maxtokens.mjs`，随仓库提交）：

1. **上游发布**。`get_detail_param` 返回的 80 个 config，**80/80** 都带 `model_detail_list[].max_tokens`
   （主流模型 32000，`Doubao-Seed-2.0-Code` 32768，旧代模型 16000，`custom_model_1M*` 64000，
   工具类 4096–20000）。
2. **`collectModels` 解析也对**。solo 层一直有单测断言读到的就是 32000，只是这个值走不到卡片。
3. **值丢在 `mergeTraeModelSources()`**。目录是「Remote 骨架 × wire 行」两张表合并出来的，
   合并时复制了 contextWindow / maxContextWindow / 倍率 / reasoning / multimodal / config_name，
   **唯独没有复制 `maxTokens`**。这个函数从 v1.1.0 诞生那天起就漏这一行，所以「32/32 全空」是历史常态，
   不是回归。

你从 `/models/refresh` 看到的「全空」和单测里「能读到」同时成立，分岔点就在这。

## 回答你「想确认的一点」

`model_detail_list` 不是只读 `[0]` 会漏——**读 `[0]` 是安全的**，实测给你看：CN 的 80 个 config 里 71 个有
两个 item（`__dev` / `__max` 双档），**两项的 `prompt_max_tokens` 与 `max_tokens` 恒等**，例如
`custom_model_gpt-6` 两项都是 `p=240000 / m=32000`。键空间里也没有 `max_completion_tokens` 之类的别名
（唯一沾边的 `tool_call_history_max_tokens` 与输出上限无关）。所以不需要动 `collectModels`。

## 修复之后还剩空白吗？还剩，而且是故意的

修复后 CN 目录 32 行里 **30 行带值**。不带的正是 `kimi-k2.8-preview`、`qwen3.8-flash` 这类
**TraeCode 通道行**：它们在 SOLO 的 wire 名单里根本没有 config，拿不到任何候选值——
和 README「模型覆盖范围」记录的 4001 join-miss 是同一批。给它们编一个上限才是 bug。

你观察到的「功能上没有坏」也是对的：`maxTokens` 是**元数据**，插件从不把它写进请求体
（`prepareSoloBody` 有意剥掉 OpenAI 的 `max_tokens`），上限由 Trae 服务端决定。这次修复只让卡片、
`/models/refresh` 与 DSH 模型注册不再谎称「未知」。

## 顺带的小请求（18 次点击）也做了

卡片模型管理区新增两个按钮（issue #42 附带需求，与 #36 同源）：

- **「整区切到 Max」**——给本区每个带 Max 档的模型一次性写入其 `maxContextWindow`（正是
  `applyContextBudgets` 认的那个精确值），没有 Max 档的行不动，已有手动预算保留；
- **「全部恢复默认上下文」**——清空本区预算。

仍是草稿→按「保存」生效，落盘形状与逐行单选、与你的手写字段完全一致，所以没有新增
`contextBudgetMode` 配置键——运行时零新分支，旧配置零迁移。5 个新卡片测试钉住了落盘内容与
两个按钮的禁用条件。

## 关于你的建议 1 和 2

- 建议 1（文档说明）：采纳了精神但换了内容——README 新增「最大输出与上下文预算」一节，因为现在
  事实变了：上游**发布**该值，空白行另有其因（join-miss），文档写的是这个。
- 建议 2（per-model 覆盖 dict）：不做。上游给得出值，护栏就不需要「用户随便填」的口子；
  等真出现「上游有值但想压小」的需求再谈，方向也应该是走既有的预算机制而不是新增平行 dict。

## 版本与测试

- **4.0.1**：`fix(catalog)` 合并带上 `max_tokens` + `feat(card)` 批量上下文按钮。
- 新增 1 例合并回归测试（修复前必红）+ 5 例卡片测试；全仓 **901** 例通过，typecheck + build 干净。
- 诊断全文见仓库 `docs/ISSUE42_DIAGNOSIS.md`，取证可复跑（需要本机 Trae CN 登录）。
