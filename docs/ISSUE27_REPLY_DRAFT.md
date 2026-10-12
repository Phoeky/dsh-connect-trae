# issue #27 回复草稿

> 用途：回复 <https://github.com/dingminhua/dsh-connect-trae/issues/27>
> （Gaudi-XIX：DSH 0.2.0-rc.2 + 插件 3.0.0，`Doubao-Seed-Evolving` 新会话 105ms 必现
> `Cannot read properties of undefined (reading 'length')`）
>
> **状态：3.4.2 已发布**（registry `dist-tags.latest` = `3.4.2`，
> GitHub Release [v3.4.2](https://github.com/dingminhua/dsh-connect-trae/releases/tag/v3.4.2)，
> npm `gitHead` = tag `v3.4.2` = `c3c37da`）。
> `pnpm run check` 全绿（typecheck + 594 测试 + build），
> 发布后逐文件核验与 tag 一致（线上 tarball shasum 与 publish 日志完全相等）。
>
> ⚠️ 该 issue 已由维护者在 2026-10-12T16:18Z 以 `completed` 关闭，**未留说明**。
> 下面这份回复同时承担两件事：把真正的原因讲清楚，
> 以及说明**为什么它不是模型元数据问题**（你原帖的推测方向）。
> 可直接复制横线以内的内容。
>
> **已于 2026-10-12 发布到 issue**：
> <https://github.com/dingminhua/dsh-connect-trae/issues/27#issuecomment-6129839899>

---

先说结论：**你报的这个崩溃是真的，根因和你推测的位置不一样，症状与模型无关。**

你的报告方向没错——「105ms 本地崩、请求没出去、探针 available」这三条把范围压得很准，
它也确实是 `@earendil-works/pi-ai` 调用管线上的一个未防空读取。
但**它不是 `Doubao-Seed-Evolving` 的元数据问题**：把模型换成任意一个，同样的崩法。

## 真正的原因：两代 pi-ai 对「上下文长什么样」的定义不同

插件把 `@earendil-works/pi-ai` 声明为 peer —— 这是对的，但意味着
**插件解析到哪一代由安装环境决定，未必是宿主那一代**。而两代对上下文的定义**相反**：

| | 旧代（≤0.85） | 新代（0.86+） |
| --- | --- | --- |
| 形状 | `{ systemPrompt, tools, messages }` | `{ messages: [ {role:'system', content, toolsAdded}, … ] }` |
| 系统提示 | 顶层 `systemPrompt` | **只**挂在那条 system 消息上 |
| 工具声明 | 顶层 `tools` | **只**挂在那条 system 消息的 `toolsAdded` 上 |

你的宿主是 **0.2.0-rc.2**，那一版的 `dsh-llm-pi-ai` 依赖 `^0.87.1`（新代），
入口处会做一次 `normalizeContext()`，于是插件收到的是**归一化 transcript**。
而插件当时解析到的是**旧代**（你贴的解析结果是 `0.82.1`，来自同 profile 里另一个插件的硬依赖），
它的 token 估算**没有 `role === 'system'` 分支**——
它 `for (const block of message.content)` 迭代一个**字符串**，逐字符拿到 `block`，
再读 `block.name.length` → `TypeError: Cannot read properties of undefined (reading 'length')`。

这条链路上有个细节正好解释了你观察到的全部现象：

- **为什么 105ms**：这一步在 `buildBaseOptions` 内，**早于任何 HTTP 构造**——请求根本没发出去，
  所以耗时不足一次 TLS 握手，`usage` 恒为 0。
- **为什么与模型无关**：崩溃发生在**消息装配阶段**，此时还没轮到模型元数据。
  你换 `Doubao-Seed-2.1-Pro`、`glm-5.3` 也一样崩。
- **为什么探针 available**：探针走的是另一条路径（不经过 provider 的上下文装配），
  所以凭据、Shim、网络全都是好的——这正是你那条对照信息的价值。

我用你报的版本组合**逐字复现**了一遍（`pi-ai@0.82.1` + transcript 形状）：

```
修复前：崩 → Cannot read properties of undefined (reading 'length')
修复后：{"tokens":30,"usageTokens":0,"trailingTokens":30,"lastUsageIndex":null}
        systemPrompt: "You are an AI agent powered by DeepSeek Harness."
        tools: ["pwsh"]
        messages 角色: ["user"]
```

我也核了你原帖的推测方向，逐条对不上（在 0.82.1 与 0.85.1 上分别实测，结论一致）：

| 你的推测 | 实测 |
| --- | --- |
| `toPiModel` 把 undefined 的 `contextWindow`/`maxTokens` 传进了 pi-ai | `toPiModel`（`adapter.ts:92-93`）在字段为 undefined 时是**整字段省略**，不会传 undefined |
| 崩在 `simple-options.js` 的 `clampMaxTokensToContext` | 该函数不会抛错；`undefined` 会算出 `NaN`，而 `NaN` 是**假值**，字段直接不下发，后果无害 |
| 崩在 `utils/text.js` | 实际抛出点是 **`dist/utils/estimate.js`** 的 `estimateMessageTokens` |

## 修法（3.4.2 已发布）

插件现在按**自己解析到的那一代**做双向适配，且判据是**本插件解析到的那份包**，不是宿主版本——
因为嵌套的旧副本会盖过宿主的新副本，反之亦然（你这次就是「新宿主 + 旧插件解析到旧代」）。

两个方向都修了，因为**只修一侧等于把响亮的故障换成安静的故障**：

- **新宿主 + 旧库**（你这次）：必崩 → 现在折返成旧形状，不再崩。
- **旧宿主 + 新库**：不崩，但新代 api 只读那条 system 消息，顶层字段被**静默忽略**——
  系统提示与**全部工具声明**丢失（模型永远不会产生 toolCall）。这类更隐蔽，同样已修。

另外有个**你还没遇到、但同样会中招**的点值得知道：**升级 DSH 解决不了这个问题**，方向甚至是反的。
0.2.0-rc.2 已经是你那时的最新宿主，而「新宿主」这一侧只会继续往前
（0.2.0-rc.2 起 `^0.87.1`，0.2.1-alpha.2 已到 `^1.0.2`），
所以**继续升级只会让你更牢地留在崩溃那一侧**。能让 `^0.82.1` 消失的是插件侧的适配层——
也就是这次这个修复。

还有一个容易踩的坑，顺便记在这里：**代际分界线是 `0.86`，不是 `0.87`**。
`dist/utils/transcript.js`、`normalizeContext`、估算器的 system 分支、
以及「不再读顶层字段」这四件事**同时**出现在 0.86.0。
按 `0.87` 划分会把 0.86.x 误判成旧代而错误折返，反而丢掉提示与工具。

## 期间怎么办

**升级到 `3.4.2`**：

```bash
dsh plugin --profile desktop add dsh-connect-trae@3.4.2
# 或
npm install dsh-connect-trae@3.4.2
```

装完**重启 DSH 进程**（bundle 在启动时加载）。升级后：
崩溃消失，且启动日志里会多一行本次探测的结果——

```
dsh-connect-trae: pi-ai 0.82.1 (legacy generation)
```

（如果你那份 `0.82.1` 还在，这一行就会照实显示 `0.82.1`。）

`legacy` 表示你这份安装解析到的是 ≤0.85 的旧代，适配层会为它折返；
这行日志是特意加的：混代安装属于「安静坏掉」的那一类，
以后同类问题在日志里就能直接看见，不必再从一次崩溃倒推。

**如果你手上还有旧版本的现象可复现**，麻烦留意一下那行日志——
它会直接告诉我们你机器上到底解析到了哪一代。这次你没有完整堆栈也能定性，
靠的正是你贴的那三条对照事实（探针 available、105ms、与模型无关），很关键。
