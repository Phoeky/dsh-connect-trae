# issue #42 诊断：CN 区「最大输出」全空的成因是**合并层丢字段**，不是上游不发布

> issue：<https://github.com/dingminhua/dsh-connect-trae/issues/42>
> （ahian-lee：「CN 区 32/32 模型没有 maxTokens：上游不发布 max_tokens？建议加覆盖入口或文档说明」，
> 环境 plugin 3.4.3 / DSH desktop Windows / CN 单账号）
> 诊断时间：2026-10-19　方法：本机 CN 实时凭据跑 `get_detail_param` × 5 function + Remote 目录 +
> `mergeTraeModelSources` 全链路探针（`scripts/probe-cn-maxtokens.mjs`，只读）+ 代码链阅读
> 结论：**上游确实发布 `max_tokens`，报告人的方向对了一半；真正的缺陷是目录合并把 wire 侧的
> `maxTokens` 丢掉了**——即报告人建议 (3)「如果上游其实有，那就是补字段的事」。附带需求（整区一键切 Max）已实现为卡片批量按钮。

---

## 0. 一句话结论

| 项 | 结论 | 证据强度 |
|---|---|---|
| 上游发布 `max_tokens` 吗 | **发布**。CN 实时 `get_detail_param` 的 80 个 config **80/80** 都带 `model_detail_list[].max_tokens`（主流模型 32000，`Doubao-Seed-2.0-Code` 32768，旧代 16000，`custom_model_1M*` 64000，工具类 4096–20000） | 实测（2026-10-19，本机账号） |
| `collectModels` 解析对吗 | **对**。`model_detail_list[0].max_tokens` 读得到，solo 层单测（`tests/solo.spec.ts:106`）一直断言 32000 | 代码 + 测试 |
| 只读 `[0]` 会漏吗 | **不会**。最多 2 项（`__dev`/`__max` 双档），71/80 个 config 有 2 项，且**两项的 `prompt_max_tokens` 与 `max_tokens` 恒等**；不存在 `max_completion_tokens` 之类的别处挂载 | 实测（逐项 dump） |
| 那值丢在哪 | `mergeTraeModelSources()`（`src/catalog.ts`）把 Remote 骨架与 wire 行合并成 `TraeModelInfo` 时**复制了 contextWindow / maxContextWindow / creditMultiplier / reasoning / multimodal / wireConfigName / wireFunction，唯独没复制 `maxTokens`** | 代码 + 修复前后探针对照 |
| 从什么时候开始 | **v1.1.0**（`d6b9dc5`，2026-08-30）——合并函数诞生那天就没带这个字段；接口上 `maxTokens?: number` 两个类型都声明了，纯漏写一行传递 | `git log -S wireModel.maxTokens` 全史为空 |
| 影响面 | 卡片「最大输出」空白；`POST /models/refresh` 返回 `maxTokens: null`；DSH 模型注册（llm discovery）拿不到上限；`toPiModel` 按「缺就不写」省略。请求体不受影响（`prepareSoloBody` 本就不下发 OpenAI `max_tokens`），所以**只伤显示与元数据，不伤调用** | 代码链 |
| 修复后还剩空白吗 | 还剩**且应当剩**：TraeCode 通道 3 行（`glm-5.3-flash`/`kimi-k2.8-preview`/`qwen3.8-flash`）在 SOLO 的 wire 名单里**没有 config**，无从取值——与 README「模型覆盖范围」记录的 join-miss 同一批，如实空白 | 实测（修复后探针：30/32 带值，缺的就是 join-miss 行） |

---

## 1. 报告人的假设为什么只对了一半

报告人从插件侧只能看到 `/models/refresh` 的返回值，全部 32 行 `maxTokens == null` 而其它字段正常。
据此推出「上游不发布」是自然的方向——但这条链上有一个**插件自己的环节**：

```text
get_detail_param (wire)          Remote 目录 (骨架)
  collectModels → TraeSoloModel    parseTraeRemoteModel → TraeDiscoveredModel
  maxTokens = detail["max_tokens"]   （目录接口本来就没有输出上限字段）
            └────────── mergeTraeModelSources ──────────┘
                        ← 缺陷在这里：result.push 没有 maxTokens
                                    ↓
                    latestDiscovery / /models/refresh / llm discovery / 卡片
```

Remote 目录确实**没有**输出上限字段（`context_window_tokens.{dev,max}` 只有输入窗口），报告人的取证恰好
把「wire 有、合并后没有」这两端都拍到了：wire 单测有值、refresh 无值。修复即在 `src/catalog.ts:313-319`
把 wire 侧的值带过去：

```ts
...wireModel?.maxTokens === undefined ? {} : { maxTokens: wireModel.maxTokens },
```

## 2. 「输出上限会不会挂在后面的 detail 项 / display_config」——实测否

对报告人「想确认的一点」逐项 dump：CN 80 个 config 里 71 个有两项（`__dev`/`__max`），
所有两项的 `prompt_max_tokens`、`max_tokens` **完全相同**（如 `custom_model_gpt-6`：两项都是 p=240000 / m=32000）。
键空间里也没有 `max_completion_tokens`；唯一沾边的 `tool_call_history_max_tokens` 与输出上限无关。
所以 `collectModels` 读 `[0]` 的写法维持原样，不需要改。

## 3. 附带需求：整区一键切 Max（与 #36 同源）

`applyContextBudgets`（`src/catalog.ts`）要求预算**恰好等于** `maxContextWindow` 才放宽窗口，
CN 有 18 行带 Max 档（200k→1M、`mimo-v2.6-*`→981504、`Doubao-Seed-2.1-Pro/Evolving` 256k→1M），
逐个勾选确实是 18 次点击。实现为卡片模型区的两个批量按钮（`feat(card)`）：

- **「整区切到 Max」**：对当前目录每个带 `maxContextWindow` 的行写 `draft.contextBudgets[id] = maxContextWindow`，
  不带 Max 的行**不写入**（写了运行时也不认，反而谎报状态）；已有手动预算保留。
- **「全部恢复默认上下文」**：清空预算 dict（与逐行「恢复默认」落盘形状完全一致）。

刻意**没有**新增 `contextBudgetMode: default | max` 配置键：按钮走既有的草稿→保存流，落盘的仍是
`contextBudgets` dict，与手写 `cordis.patch.yml` 的结果同构，运行时零新分支。5 例卡片测试
（`tests/card-context-bulk.spec.tsx`）钉住落盘内容、既有手动预算的保留、以及两个按钮的禁用条件
（无 Max 行 / 无预算可撤时按钮是死的）。

## 4. 测试与验证

- 新增 `tests/catalog.spec.ts` 用例「carries the wire max_tokens onto the merged row (issue #42)」——
  修复前 RED（1 failed | 27 passed），修复后 28/28 GREEN。
- `pnpm run check` 全绿：typecheck ×2 + **901** 测试（修复前 895，+6）+ build。
- 修复后实时探针：合并 32 行 → **30 行带 maxTokens**。缺的 2 行是 `kimi-k2.8-preview`、`qwen3.8-flash`——
  它们在 SOLO 的 wire 名单里**没有 config**（README「模型覆盖范围」记录的 TraeCode 通道行），无从取值，
  如实空白。顺带一条与本 issue 无关的观察：`glm-5.3-flash` 本次已出现在 wire 名单（`out=32000`），
  README 那张三行表可能已过时——可调用性是 #19/#38 那条线的话题，这里只记录、不改动。
