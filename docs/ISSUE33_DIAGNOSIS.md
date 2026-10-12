# issue #33 诊断：4011 是 SOLO 通道的限流，不是「该 function 不提供此模型」

> issue：<https://github.com/dingminhua/dsh-connect-trae/issues/33>
> （junbin-lai：「使用时报了 4011 错误，我的额度是还有很多的，在 trae 客户端的 solo 里面是可以正常使用」，
> 随附 DSH 失败截图：模型 `GLM-5.3 · x0.78 High`，`已重试模型请求 (5/5)`，`RATE_LIMIT` 徽标）
> 诊断时间：2026-10-12　方法：本机 CN 实时凭据逐条实测（`get_detail_param` + `llm_utils_chat`）+ 阅读内核分类代码
> 结论：**报告人的现象不是「模型/function 路由错了」，而是上游对 SOLO 通道的限流。**
> 插件有两处真实缺陷：**文案把 4011 断言成「该 function 不提供此模型」（与上游原文和用户证据都矛盾）**，
> 以及**该文案里那句 rate limit 让 DSH 把这个错误按 `RATE_LIMIT` 重试 5 次**。

---

## 0. 一句话结论

| 项 | 结论 | 证据强度 |
|---|---|---|
| 报告的 4011 是什么 | **上游限流**：Trae 自己的原文就是 `your requests have exceeded the rate limit` | 实测（原文）+ 2 次独立观察 |
| 是积分/额度不足吗 | **不是**。额度不足是**另一个码 `4008`**（原文 `Your requests have exceeded the quota.`） | 实测 |
| 是「function 选错了」吗 | **不是**。CN 上「function 不服务该模型」实测一律回 **`4001`**（`the param is invalid`），从不回 4011 | 实测（22 function × 6 模型矩阵） |
| 插件的 `function` 分派有错吗 | **没有**。`glm-5.3` 的归属就是 `solo_work_remote`，实测正常出字 | 实测 |
| 那用户为什么会看到那个解释 | 插件用自己的 `TRAE_ERROR_HINTS[4011]` **覆盖**了上游原文，并把它降级成 `· upstream:` 后缀 | 代码 |
| 为什么重试 5 次 | 插件把 4011 分类成 `400 client`（不可重试的语义），但**消息里带着 rate limit 字样**，内核按文本判定为 `RATE_LIMIT`，而 `RATE_LIMIT` 在默认可重试集里、`maxRetries = 5` | 内核代码 + 截图数值吻合 |

---

## 1. 报告人的原文

```
400: {"message":"Trae refused this model under the SOLO function the request used · Trae code 4011 ·
upstream: We're sorry, your requests have exceeded the rate limit. Please wait and try again later.",
"type":"client","code":"client"}
```

截图（issue 附件）里可读到三件事，全部与本次诊断吻合：

1. 选中的模型是 **`GLM-5.3 · x0.78`**（CN 区域模型），reasoning 档位 `High`；
2. `已重试模型请求 (5/5) · 8s`，`重试延迟：7328 毫秒`；
3. 失败横幅右侧是 **`RATE_LIMIT`** 徽标——**内核把它当限流处理了**，而横幅正文却说是「该 function 不提供此模型」。

一句话里出现两个互相矛盾的判断，这就是缺陷本身。

---

## 2. 实测：Trae 的错误码语义（本机 CN 实时凭据，2026-10-12）

用插件自己的请求构造器（`prepareSoloBody` + `buildTraeCnHeaders`）对 22 个 function × 6 个模型逐条发最小请求
（一句 `ping`，无 tools），并同时读每个 function 的 `get_detail_param` 名单。完整矩阵见 §2.3。

### 2.1 码 → 语义对照（本轮实测）

| 码 | 上游原文 | 语义 | 本插件当前认知 |
|---|---|---|---|
| `4001` | `We're sorry, the param is invalid. Please try with a valid param.` | **该 function 不服务这个 `config_name`**（名单里没有它） | ✅ 已知 |
| `4011` | `We're sorry, your requests have exceeded the rate limit. Please wait and try again later.` | **限流**（通道暂时拒绝） | ❌ 被断言成「该 function 不提供此模型」 |
| `4008` | `Your requests have exceeded the quota.` | **额度/配额耗尽**（与限流是两个不同的码） | ❌ 源码零命中，未登记 |
| `4023` | `We're sorry, the model is unknown.` | 模型名不存在 | ❌ 源码零命中，未登记 |
| `1001` | `we are not able to authenticate you` | 凭据被拒（HTTP 401） | ✅ 走 `authentication` |
| `1005` | （空）/ `extra.plan` | 档位不够 | ✅ 已知 |

`4008` 与 `4011` 的区别是本轮最关键的发现：**Trae 把「额度」和「限流」分成两个码，文案也不同。**
报告人拿到的是后者（rate limit），却说「额度还有很多的」——两边其实都没错：**他有的是额度，缺的是速率。**

### 2.2 `glm-5.3` 的归属与可调用性（本轮实测）

| function | `get_detail_param` 名单 | `llm_utils_chat` 结果 |
|---|---|---|
| `solo_work_remote` | **含 `glm-5.3`**（48 条） | **HTTP 200，正常出字** |
| `solo_work_lite` | 不含（42 条） | `4001 param is invalid` |
| `solo_agent_remote` / `solo_agent` / `chat_v3` / `solo_coder` / `builder_v3` / `ui_builder_v2` / `solo_builder` / `solo_agent_lite` / `solo_design_lite` | 不含 | 全部 `4001`（**没有一个回 4011**） |

**只有 `solo_work_remote` 同时满足「名单里有」和「调用成功」。** 这正是插件 `TRAE_DIRECTORY_FUNCTIONS.cn`
的第一顺位（`['solo_work_remote', 'solo_work_lite', 'solo_agent_remote', 'chat_v3', 'solo_coder']`），
所以 `glm-5.3` 会被打上 `wireFunction: solo_work_remote`——**分派是对的**。

### 2.3 关键反证：CN 上「function 选错」只会是 4001

在同一轮矩阵里，所有「模型不在该 function 名单里」的组合**无一例外返回 `4001`**，包括
`gpt-5.6-sol`、`gpt-6-astra`、`deepseek-v4.1-flash` 这类别的通道的模型。矩阵里没有出现过一次 `4011`。

于是可推出：**`4011` 不可能是「该 function 不提供此模型」这个条件在 CN 上的编码**——那个条件已经被 `4001` 占了。
把 4011 读成「function 归属错误」是 issue #19 那一轮的**过度推断**：当时的对照实验（同一模型在
`solo_agent` 回 4011、在 `solo_work_remote` 正常）与「**按 function 分别限流**」同样吻合，
而后者与「原文说 rate limit」这条更强的证据一致——原文是 Trae 自己写的，不该被当成「误导」而丢掉。

### 2.4 不是每条通道都容易被限流（说明 4011 是账号/时段相关）

本机 CN 账号：`DeepSeek-V4-Flash-Official` **30 次请求 / 10 并发**全部 `OK`；`glm-5.3` 4 并发全部 `OK`。
即本机账号在这条通道上没被限流，**4011 因此无法在本机复现**——这与报告人「用了好几天都正常，就今天报错」
（同一账号、同一模型，只有时间变了）完全一致：**它是账号×时段×通道的瞬时状态，不是模型的固有属性。**

---

## 3. 缺陷一：文案断言了一个与上游原文矛盾的原因

`src/solo-bridge.ts`：

```ts
const TRAE_ERROR_HINTS = {
  1005: 'Trae requires a paid plan for this model; ...',
  4001: 'Trae does not serve this model under the SOLO function the request used (config_name rejected)',
  4011: 'Trae refused this model under the SOLO function the request used',   // ← 断言
}

// Trae's own text is often a generic apology that contradicts the code, so it
// is appended as detail rather than used as the message.
return detail === '' ? parts.join(' · ') : `${parts.join(' · ')} · upstream: ${detail}`
```

上游明说「限流」，插件却把它降级为 detail、用自己的断言当主句。后果：

- 用户按主句去查「模型/function 哪里错了」——**方向被带偏**，于是他来开 issue 问「为什么」；
- 主句与同一行里的 `RATE_LIMIT` 徽标**自相矛盾**（§1）；
- 「Trae 的文案不可信」这个前提在本轮实测里**没有证据支持**：`4001`/`4008`/`4023`/`1001` 的原文都与其码相符，
  4011 的原文也与「限流」语义相符。真正与码矛盾的是插件的断言，不是原文。

---

## 4. 缺陷二：文案里的 rate limit 让 DSH 重试 5 次（而插件自己说不该重试）

内核 `@deepseek-ai/dsh-llm-pi-ai` 按**消息文本**分类：

```js
if (isQuotaExceededError(message)) return QUOTA_EXCEEDED_CODE;
if (/\b429\b|rate.?limit/i.test(message)) return "RATE_LIMIT";
```

而 `@deepseek-ai/dsh-llm` 的默认重试策略是：

```js
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_RETRYABLE_CODES = ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'];
// 退避：initialDelayMs 500 / maxDelayMs 10000 / jitterRatio 0.1
```

于是报告人截图里的三个数字全部对得上：`RATE_LIMIT` 徽标 ✓、`(5/5)` ✓、`重试延迟 7328 毫秒` ✓。

**矛盾点**：插件把 4011 分类成 `400 / client`——按本插件自己的 `fallback-upstream.ts` 语义，
`client` 属于「可换通道重放」的一类，绝不是「等一下再来」的一类；可内核却因为同一段文本把它当限流重试。
结果是被限流的通道在 8 秒内又挨了 5 发请求，**限流只会更难解除**。

---

## 5. 缺陷三：一键测试会把「被限流」的模型标成「上游不提供」

`src/model-probe.ts`：

```ts
const UNSUPPORTED_CODES = new Set([4001, 4011])   // ← 4011 被判成永久不可用
```

按 §2 的实测，4011 是限流，把它判成 `unsupported`（卡片文案「上游不提供」）是**永久性负面结论**。
这与该模块自己写在文件头的原则直接冲突：

> the verdict must never turn an inconclusive answer into "unavailable" … Only a refusal that
> came from upstream is allowed to be negative.

报告人用「一键测试」时，会看到 `GLM-5.3 上游不提供`——**这是一句错的结论**，会让人真的删掉能用的模型。
另外 `4008`（额度耗尽）也会落进「无名 4xx → `unsupported`」这条兜底，同样把账号级问题说成模型级问题。

---

## 6. 修法（本仓库已实现，见同批提交）

| # | 位置 | 改动 |
|---|---|---|
| 1 | `src/solo-bridge.ts` `TRAE_ERROR_HINTS` | `4011` 改为如实描述「被 SOLO 通道限流」；新增 `4008`（额度耗尽）、`4023`（模型名不存在）两条登记 |
| 2 | `src/solo-bridge.ts` `classifyTraeFailure` | `4011` → **`429 / soft_rate`**（与文案、与内核判定、与本插件 `fallback-upstream` 的语义三者对齐）；`1005` 仍 `402`；`4008`/`4023` 仍 `400 client`（保持现状，不冒险改语义） |
| 3 | `src/model-probe.ts` | `4011` 从 `UNSUPPORTED_CODES` 移出 → `rate_limited`（卡片「被限流」）；`4008` → `unknown`（账号级问题，不得判成模型级） |
| 4 | 测试 | 上述三处的行为契约各加断言；把固化了旧断言的用例改为新契约 |

**没有改**：`function` 分派、目录合并、`4001` 的语义（实测支持它）、任何发布动作。

---

## 7. 对报告人的答复要点

1. **不是你的额度问题**（额度耗尽会走另一个码 `4008`，文案是「超出 quota」），
   你遇到的是**上游对 SOLO 通道的限流**（`4011`），Trae 的原话就是「你的请求超出了速率限制，请稍后再试」。
2. **不是插件选错了模型/function**：`GLM-5.3` 的归属就是 `solo_work_remote`，本机实测同一账号下它在该通道正常出字；
   CN 上「function 选错」只会回 `4001`，不会回 4011。
3. **客户端那个 RATE_LIMIT 徽标才是对的**，横幅正文「该 function 不提供此模型」是插件的文案缺陷——已修。
4. **为什么今天才出现**：限流是账号×时段×通道的瞬时状态，与模型是否可用无关；本机 30 并发都没触发，
   说明你的账号/时段确实被盯上了（也可能与短时间内的密集请求有关）。
5. **期间怎么用**：等一会儿再发；插件修好后 4011 会如实显示成「被限流」并带 `429`，
   不会再被当成「模型不可用」，一键测试也不会再把它标成「上游不提供」。

---

## 8. 未证实 / 边界

- **4011 是「这条 function 被限流」还是「整个账号被限流」**：本机未能复现 4011，无法区分。两者的修法相同（如实报限流），
  但若要写进文档，只能说「限流」这个粒度。
- **`4008` 的边界未测**：只在**国际版**账号上观察到（该账号当前对多数模型都回 4008），
  CN 账号未触发，`4008` 是否也用于 CN、是否会在数分钟内自动恢复，均**未验证**。
- **`4023` 只见过一次**（CN `kimi-k2.7-code` 打 `builder`/`chat` 这类非 SOLO function 时），未系统采样。
- **本轮没有再测国际版限流行为**：国际版账号已回 `4008`（额度耗尽），任何限流实验都会被它掩盖。
- 本轮全部为**只读 / 最小对话**请求：`get_detail_param`（零消耗）、`llm_utils_chat` 的 `ping`（最小消耗）、
  未触碰任何会改变账号状态的端点，未做任何 token 刷新。
