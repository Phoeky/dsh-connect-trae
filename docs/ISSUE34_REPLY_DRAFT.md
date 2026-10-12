# issue #34 回复草稿

> 用途：回复 <https://github.com/dingminhua/dsh-connect-trae/issues/34>
> （xiean676：任一模型都报 `Cannot read properties of undefined (reading 'length')`，
> 并附上了一份完整报告 `dsh-connect-trae-issue-27-report.md`）
>
> **状态：3.4.2 已发布**（registry `dist-tags.latest` = `3.4.2`，
> GitHub Release [v3.4.2](https://github.com/dingminhua/dsh-connect-trae/releases/tag/v3.4.2)，
> npm `gitHead` = tag `v3.4.2` = `c3c37da`）。
> `pnpm run check` 全绿（typecheck + 594 测试 + build），
> 发布后逐文件核验与 tag 一致（线上 tarball shasum 与 publish 日志完全相等）。
>
> **可直接复制横线以内的内容。**
>
> **已于 2026-10-12 发布到 issue**：
> <https://github.com/dingminhua/dsh-connect-trae/issues/34#issuecomment-6129965859>

---

先谢谢这份报告——**它一次补上了前两位报告者都没能给出的两样东西：完整调用栈和无需网络的最小复现脚本。**
这两样正是我此前两次索要、又两次没等到的，所以这次能直接定性。
结论：**根因你说对了**，而且比 #27 里的推测准确得多。

（另外，这份报告是作为 #34 提交的，文件名里却写着 issue-27——我一开始也照文件名去回复了 #27，
是我的疏忽。真正的讨论在这里。）

## 一、你的结论我逐条复核，全部成立

我在本机装了真实的 `@earendil-works/pi-ai@0.82.1`，用你脚本里的原始输入跑了一遍，
输出与你贴的**逐字一致**：

```
resolved: 0.82.1
estimateContextTokens(0.87 shape)  -> THROWS TypeError: Cannot read properties of undefined (reading 'length')
buildBaseOptions(0.87 shape)        -> THROWS TypeError: Cannot read properties of undefined (reading 'length')
estimateContextTokens(legacy shape) -> {"tokens":25,"usageTokens":0,"trailingTokens":25,"lastUsageIndex":null}
```

并且修复后用**你报告的环境组合**（`pi-ai@0.82.1` + transcript 形状）复跑：

```
修复前：崩 → Cannot read properties of undefined (reading 'length')
修复后：{"tokens":30,"usageTokens":0,"trailingTokens":30,"lastUsageIndex":null}
        systemPrompt: "You are an AI agent powered by DeepSeek Harness."
        tools: ["pwsh"]
        messages 角色: ["user"]
```

你那段「唯一变量是 context 的形状」的推理是准的：崩溃发生在**消息装配阶段**，
`buildBaseOptions` 内部、**早于任何 HTTP 构造**——所以是「105ms 本地崩 + usage 恒 0 + 换模型无效」，
三个现象一次解释清楚。

## 二、但报告里有三处需要更正（不影响结论）

我按报告原文逐条实测，有三处数字/结论对不上。都不影响根因判断，但既然是公开发布的报告，
最好别把这三处一起传出去：

| # | 报告原文 | 实测 |
| --- | --- | --- |
| 1 | 「`pi-ai@0.87` 在顶层入口做归一化」，并把代际边界按 **0.87** 划分 | **真实边界是 `0.86.0`**。`dist/utils/transcript.js`、`normalizeContext`、估算器的 `role === 'system'` 分支、以及「api 不再读顶层 `systemPrompt`/`tools`」这**四件事同时**出现在 0.86.0。在 0.85.1 / 0.86.0 / 0.86.1 / 0.87.1 / 1.0.2 五个真实 tarball 上逐项验过 |
| 2 | CASE B 实测 `{"tokens":15,...}` | 在 0.82.1 与 0.85.1 上都得到 **`{"tokens":25,...}`**（`1 + 48/4 + 48/4`）。15 复现不出来 |
| 3 | `clampMaxTokensToContext` 在 `maxTokens` 为 `undefined` 时「算出 `NaN` 再被夹回正整数」 | 前半句对：`Math.min(undefined, 5)` 确实是 `NaN`。但**不会**「夹回正整数」——`NaN` 是**假值**，该字段直接不下发（`if (options?.maxTokens)`），后果无害 |

第 1 条尤其重要，因为它会影响修法，见下。

## 三、你建议的修法方向对，但不能照抄 workbuddy

「在插件侧做代际适配」——方向完全正确，这次就是这个思路。**但它不能照抄 `dsh-connect-workbuddy` 的实现**：

那个插件的判据是 `generationOf(version)` → `>=0.87 ? modern : legacy`，
**把 `0.86.x` 误判成 legacy**。而 0.86 起 api 已经不再读顶层字段了——照着它写，遇到 0.86.x 时会
**错误折返**，结果是系统提示与**全部工具声明**被静默丢弃（模型永远不会产生 toolCall）。
我那版实现按 **0.86** 划界，正是为了避免这个。

还有一件事值得知道：**「收紧 peer 声明」不能止血**（报告里提到的那个想法）。
DSH 内核的 peer 预检只覆盖 `@deepseek-ai/dsh*` 这一类，pi-ai 不在其中；
报告里引用的 `install-compat` 告警来自 **dshmarket 社区插件**，是 `soft-incompatible`——
**只告警、不阻止安装**。而且 `0.82.1` 本就在插件声明的 `>=0.85.1` 之外，
加不加上界都不改变这个场景。（上界没加，是因为 0.86.0 / 0.87.1 / 1.0.2 实测都能正常工作，
加了反而误伤。）

## 四、修法（3.4.2 已发布）

插件现在按**自己解析到的那一代**做**双向**适配。判据是**本插件解析到的那份包**，不是宿主版本——
因为嵌套的旧副本会盖过宿主的新副本，反之亦然（你这次就是「新宿主 + 插件解析到旧副本」）。

**两个方向都修了**，因为只修一侧等于把一个响亮的故障换成一个安静的故障：

- **新宿主 + 旧库**（你这次）：必崩 → 现在折返成旧形状，不再崩。
- **旧宿主 + 新库**：不崩，但新代 api 只读那条 system 消息，顶层字段被**静默忽略**——
  系统提示与**全部工具声明**丢失。这类更隐蔽，同样已修。

顺带一个反直觉的点：**升级 DSH 解决不了这个问题**，方向甚至是反的。
`0.2.0-rc.2` 已是你那时的最新宿主，而「新宿主」这一侧只会继续往前
（0.2.0-rc.2 起 `^0.87.1`，0.2.1-alpha.2 已到 `^1.0.2`），
所以**继续升级只会让你更牢地留在崩溃那一侧**。能让 `^0.82.1` 消失的是插件侧的适配层，也就是这次这个修复。

## 五、期间怎么办

**升级到 `3.4.2`**：

```bash
dsh plugin --profile desktop add dsh-connect-trae@3.4.2
# 或
npm install dsh-connect-trae@3.4.2
```

装完**重启 DSH 进程**（bundle 在启动时加载）。升级后崩溃消失，
且启动日志里会多一行本次探测的结果——

```
dsh-connect-trae: pi-ai 0.82.1 (legacy generation)
```

`legacy` 表示你这份安装解析到的是 ≤0.85 的旧代，适配层会为它折返。
这行日志是特意加的：**混代安装属于「安静坏掉」的那一类**，
以后同类问题在日志里就能直接看见，不必再从一次崩溃倒推。

---

**再次感谢**：你那份「CASE A 崩 / CASE B 不崩」的对照，是把变量锁定到
**context 形状**而非模型元数据的关键一步；完整堆栈则直接定位到
`dist/utils/estimate.js:42`。这两样让这次定性没有走弯路。
