# Issue #27 报告核验：pi-ai 代际错配导致 `Cannot read properties of undefined (reading 'length')`

> 对象：外部报告 `dsh-connect-trae-issue-27-report.md`（`~/Downloads/`，2026-10-13 收到）。
> 本机复现环境：macOS / DSH Desktop `0.2.0-rc.2` / 宿主内置 pi-ai `0.87.1` / 本仓库 devDependency pi-ai `0.85.1`。
> 结论先行：**报告的根因判断成立且本机独立复现成功；但报告有 3 处硬错误、1 处边界错位，照抄其修复方案会引入新的静默故障。**

---

## 一、总体判定

| 维度 | 判定 |
|---|---|
| 根因（代际错配 / 非模型元数据） | ✅ 成立，本机独立复现 |
| 崩溃栈、行号、列号 | ✅ 逐字吻合（真实 `0.82.1` 包） |
| 崩溃机理（system 分支缺失 → 字符串被逐字符迭代） | ✅ 成立 |
| 现有代码确实无适配层 | ✅ 成立（`src/adapter.ts:134`） |
| 兄弟插件确有修复可对照 | ✅ 成立（workbuddy `src/adapter.ts:347`、`src/pi-ai-runtime.ts`） |
| **代际边界 0.87** | ❌ **错位：真实边界是 0.86.0** |
| **CASE B 实测输出 `{"tokens":15}`** | ❌ 不可复现（真实值 `25`） |
| **`maxTokens` undefined「被夹回正整数」** | ❌ 实际返回 `NaN`，不被夹回 |
| **「收紧 peer 即可在安装期被 DSH 预检拒绝」** | ❌ DSH 核心预检**不看** pi-ai；且该场景已是 `belowMin` |
| 「插件无法控制被解析到哪一份」 | ⚠️ 过于悲观：dshmarket 会检出全部 peer 失配并归为 risk |

---

## 二、链路复核（逐跳已验）

真实调用顺序，每一跳都有本机证据：

1. **宿主建 context**：`packages/llm/llm-pi-ai/src/context.ts` 把 DSH 请求折成 pi-ai 的 `{ systemPrompt, tools, messages }`（`piContext()`，L167/L225/L338）。
2. **宿主 0.87.1 做归一化**：`snapshot.models.streamSimple(...)`（`src/adapter.ts:380`）→ 宿主自己那份 `@earendil-works/pi-ai@0.87.1` 的 `Models.streamSimple()` 调 `normalizeContext(context)`（`dist/models.js:393`）→ 产出 **transcript 形状** `{ messages: [ { role:'system', content:<字符串>, toolsAdded }, … ] }`。
3. **转交给插件的 api 对象**：宿主 `models.setProvider(profile.piProvider)`（`src/adapter.ts:237`）把插件手工构造的 provider 注册进 0.87 的 `Models`，随后 `provider.streamSimple(requestModel, transcript, …)`（`dist/models.js:397`）。
4. **插件侧用的却是旧代 pi-ai**：`src/adapter.ts:134` `api: openAICompletionsApi()`，该模块由插件自身裸导入解析 —— 本机解析到 **0.85.1**（`node_modules/@earendil-works/pi-ai`，devDependency `^0.85.1`）。
5. **旧代 api 崩在估算器**：`buildBaseOptions` → `clampMaxTokensToContext`（`dist/api/simple-options.js:7`）→ `estimateContextTokens` → `estimateMessages` → `estimateMessageTokens`：`role==='system'` 无 early-return，`for (const block of message.content)` 对**字符串**逐字符迭代，`block.name` 为 `undefined` → `block.name.length` 抛 `TypeError`（`dist/utils/estimate.js:42:33`）。
6. **宿主映射错误码**：`stream.ts` 的文本分类兜底 → `PI_AI_ERROR`，与报告引用的会话日志逐字一致。

### 本机独立复现（两种粒度都做了）

- **模块级**：对真实 `0.82.1`（npm pack）与 `0.85.1`（本仓 node_modules）跑报告脚本 → 同一行同一列抛同一错；`legacy` 形状正常返回。
- **端到端**：直接取本仓 `openAICompletionsApi()`（解析到 0.85.1）构造 api，喂入 0.87 transcript：
  ```
  errorMessage: "Cannot read properties of undefined (reading 'length')"
  usage: { input: 0, output: 0, totalTokens: 0 }
  ```
  与报告引用的 `{"code":"PI_AI_ERROR"}` + usage 恒 0 完全一致。**即：本仓库自己的 checkout 就是复现体，无需任何第三方插件参与。**

### 崩溃的精确触发条件（报告表述略宽）

必要条件不是「上下文非空」，而是**存在一条 `role==='system'` 且 `content` 为非空字符串的消息**。实测：

| 输入 | 结果 |
|---|---|
| `{messages: []}` | 正常 |
| transcript 无 system 头 | 正常 |
| `content: ''`（空字符串，带 toolsAdded） | 正常（逐字符迭代零次） |
| `content: 'x'` | **崩溃** |

DSH 侧只要给了 system prompt（`options.system` 或首条 system 消息）或 tools，`normalizeContext` 就会造出这条 system 消息 —— 所以「凡经此插件的请求必崩」在实际环境里成立，但机理是 system 消息，不是「非空」。

---

## 三、报告的三处硬错误

### 错误 1（最重要）：代际边界是 **0.86.0**，不是 0.87

用 `npm pack` 逐个下真包比对：

| pi-ai | `dist/utils/transcript.js` | `models.js` 里 `normalizeContext` | `estimate.js` 有 `role==='system'` 分支 | api 读 `context.systemPrompt`/`context.tools`（旧代字段） | 0.87 transcript 喂进去 |
|---|---|---|---|---|---|
| 0.82.1 | 无 | 0 | 无 | 有（2 处 / 4 处） | **崩** |
| 0.85.1 | 无 | 0 | 无 | 有 | **崩** |
| **0.86.0** | **有** | **3** | **有** | **0 / 0** | 正常（`{"tokens":25,...}`） |
| 0.86.1 | 有 | 3 | 有 | 0 / 0 | 正常 |
| 0.87.1（宿主） | 有 | 3 | 有 | 0 / 0 | 正常 |

**为什么这个错位很危险**：workbuddy 的判据是 `Number(minor) >= 87 ? 'modern' : 'legacy'`（`src/pi-ai-runtime.ts` 的 `generationOf`），peer 声明 `>=0.85.0 <0.88.0`。若插件解析到 **0.86.x**，workbuddy 会判成 `legacy` → 执行折返 → 把一个**现代 api 本可原生消费**的 transcript 折回 `{systemPrompt, tools, messages}` → 而 0.86+ 的 api **完全不读**这两个顶层字段。本机实测这一折返的后果：

```
resolveTranscript(folded)            -> {"messages":[{"role":"user","content":"hi"}]}   ← system 消息被丢
getDeclaredTools(transcript.messages) -> ["pwsh"]
getDeclaredTools(folded.messages)     -> []                                            ← tools 全丢
```

即：**报告的「照抄 workbuddy」建议会把一个必崩故障换成一个静默故障**（无 system prompt、零 tool 声明）。修复必须以 0.86 为界。

### 错误 2：CASE B 的实测输出不可复现

报告称 `estimateContextTokens(legacy shape)` → `{"tokens":15,...}`。我用**同一份脚本原文**、真实 `0.82.1` 与 `0.85.1` 各跑一遍，结果都是：

```
{"tokens":25,"usageTokens":0,"trailingTokens":25,"lastUsageIndex":null}
```

算式对得上 25：`user("hi")` 1 + `systemPrompt` 48 字符 /4 = 12 + `tools` JSON 48 字符 /4 = 12。`15` 不是这套输入的真实产物 —— 说明报告那段「本机输出」不是原样粘贴。不影响根因结论，但在公开回复前应指出，否则会被作者当成编造。

### 错误 3：`undefined maxTokens` 不会「被夹回正整数」

报告 §7 称 `clampMaxTokensToContext` 在 `maxTokens` 为 `undefined` 时「只会算出 NaN 再被夹回正整数」。实测两个分支都**返回 NaN**，没有任何夹回：

```
clampMaxTokensToContext({contextWindow:200000,...}, ctx, undefined) -> NaN
clampMaxTokensToContext({contextWindow:0,...},      ctx, undefined) -> NaN   // Math.max(1, undefined) === NaN
Math.min(undefined, 5)                                              -> NaN
```

好在后果无害：`openai-completions.js` 用 `if (options?.maxTokens)` 判空，`NaN` 为假值 → 该字段直接不下发。加上宿主 `catalog.ts:918-920` 对 `maxTokens` 有 `entry ?? base ?? request.defaultMaxTokens` 且强制正整数校验，这条路径在 DSH 内基本不可达。**结论（元数据不是崩溃原因）成立，但举证措辞不准**。

---

## 四、两处需要修正的修复建议

### 4.1 「收紧 peer → 安装期被 DSH 预检拒绝」不成立

- **DSH 核心预检根本不看 pi-ai**。`packages/boot/app-boot/src/plugin-compatibility.ts:75`：
  ```ts
  if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
  ```
  只校验 `@deepseek-ai/dsh*` 系列，`@earendil-works/pi-ai` 一行都不会被评估，因此**不可能**在安装期因 pi-ai 拒绝。
- 报告引用的那条告警文本确实存在，但来自 **dshmarket 社区插件**，不是 DSH 内核：
  - `dshmarket/lib/routes.js:6064` → `logEvent('warn', 'install-compat', …)`（事件名、文案都对得上）
  - 它评估的是**全部** peer（`check.js:1141-1205`，注释明写「Peer checks cover EVERY declared peer, not just host core packages」），把 `resolved < 下界` 归为 `risk`（`compatibility.js:160-190` 的 `belowAllMins`），属于 `soft-incompatible` —— **只告警并给出回滚，不阻止安装**。
- 更关键的是：报告人的场景 `0.82.1 < 0.85.1` **本来就已经在声明范围之外**。再加一个上界 `<0.88.0` 对他的处境毫无改变。真正把他救回来的只能**运行期适配**，不是 peer 声明。

（上界仍然值得加：它能让未来的 0.88 形状变更在 dshmarket 侧得到 `aboveMax` 的强判定，只是别把它说成「立刻止血」。）

### 4.2 「插件无法控制被解析到哪一份」过于悲观，但方向对

- 用户侧可缓解：问题来自 `@opencode2dsh/dsh-plugin@0.3.11` 的**硬依赖** `"@earendil-works/pi-ai": "^0.82.1"`（本机已用 `npm view` 核对）。profile 顶层把它 hoist 到 `node_modules/@earendil-works/pi-ai`，于是插件的裸导入解析到它。
- 因此在 profile 里显式钉一份与宿主同代的 pi-ai（0.2.0-rc.2 宿主 → `0.87.x`）是可行的用户侧缓解。**注意方向**：必须与**宿主**同代，而不是随便钉一个新的；宿主旧、插件新同样会静默丢 prompt/tools。此处仅给出机理，未在报告人机器上实测。
- 要注意 nodeLinker `hoisted` + `autoInstallPeers: false` 是 DSH 写进 profile 的固定配置（`packages/boot/app-boot/src/profile.ts:226-238`），profile 内多插件共用一份顶层副本是这套配置的常态，冲突会反复出现。

---

## 五、建议的修复方案（比报告更可落地）

### 5.0 先看四组合矩阵：这是「双向兼容」的实证基础

DSH 自身横跨两代 pi-ai，实测各版本声明（`npm view @deepseek-ai/dsh-llm-pi-ai@<v> dependencies`）：

| dsh-llm-pi-ai | 声明的 pi-ai | 代际 |
|---|---|---|
| 0.1.5-rc.2 / 0.1.7-rc.1 / 0.1.7-rc.2 / **0.2.0-rc.1** | `^0.85.1` | **旧代**（`^0.85.1` ≡ `>=0.85.1 <0.86.0`，数学上只可能落旧代） |
| **0.2.0-rc.2** / 0.2.1-alpha.1 | `^0.87.1` | 新代 |
| 0.2.1-alpha.2 | `^1.0.2` | 新代（已核 1.0.2 形状未再变） |

trae 插件声明 `@deepseek-ai/dsh-llm-pi-ai: ">=0.1.7-rc.1 <0.3.0-0"` —— **该区间内宿主两代皆有**。把两代 pi-ai 各装齐依赖（`openai`/`partial-json`/`typebox`/`ws`）后跑实测：

| 宿主 pi-ai | 插件解析到 | 传入形状 | 估算 | 系统提示 | 工具 | |
|---|---|---|---|---|---|---|
| 0.85.1 旧 | 0.85.1 旧 | legacy | ok | 有 | 有 | ✅ |
| 0.85.1 旧 | **0.86.0 新** | legacy | ok | **丢失** | **丢失** | ❌ |
| 0.87.1 新 | **0.85.1 旧** | transcript | **CRASH** | 丢失 | 丢失 | ❌ |
| 0.87.1 新 | 0.86.0 新 | transcript | ok | 有 | 有 | ✅ |

**结论：错配是双向的，修复也必须双向。** 报告只看到第 3 行（issue #27 的必崩），而第 2 行是同样真实、但更隐蔽的故障 —— 旧宿主 + 新库时不崩，却静默丢掉系统提示与全部工具。任何「旧代就折返」的单一判据都只修好一半：它在第 2 行什么都不会做，于是 legacy 形状照样喂给新代 api，照样静默丢光。

因此判据必须**两道闸门串联**：

```
收到 context
  ├─ 有顶层 systemPrompt？ ──有──→ 已是 legacy 形状：原样返回（引用相等，零开销）
  └─ 无 → 是 transcript 形状
        ├─ 插件解析到新代（0.86+）？ ──是──→ 新代 api 原生消费：不折，透传
        └─ 是旧代 → 折返：搬 systemPrompt + 按序回放 toolsAdded/toolsRemoved
```

四组合逐一走对：旧+旧 → 第一闸返回原对象（不折）；旧+新 → 第一闸返回原对象（**第 2 行不再丢**）；新+旧 → 折返（**第 3 行不再崩**）；新+新 → 透传。

> 要点：「**有没有 `systemPrompt`**」回答的是「宿主给我哪个形状」（决定*能不能*折），「**插件解析到哪一代**」回答的是「我这份 api 认不认 transcript」（决定*要不要*折）。两者不可互相替代 —— 这也是上一版方案只做后者因而漏掉第 2 行的原因。

### 5.1 判据用「能力探测」，不用版本号

`exports` map 各代都放开了 `./utils/*`，而 `dist/utils/transcript.js` **只在 0.86+ 存在**，于是可以同步、零副作用地问一句「这一份到底是不是现代代」：

```ts
/** 解析到的 pi-ai 是否属于 0.86+ 的 transcript 世代。 */
function resolvedPiAiSpeaksTranscript(): boolean {
  try {
    import.meta.resolve('@earendil-works/pi-ai/utils/transcript')
    return true
  } catch {
    return false   // 0.85 及更早：无该模块；或 pi-ai 尚未解析（市场安装，宿主注入）
  }
}
```

本机实测：0.85.1 → `FAIL(ERR_MODULE_NOT_FOUND)`；0.86.0 → 返回文件 URL。`import.meta.resolve` **不执行任何模块代码**，不会把 pi-ai 拖进独立 CLI。恰好落在真实边界上，且不依赖版本字符串解析。

若保留版本判据，**阈值必须是 `>= 0.86`**（不是 0.87）；解析失败时的默认分支应与 workbuddy 一致地取「现代 → 透传」（市场安装在宿主外本来就没有本地副本）。

### 5.2 折返逻辑必须搬运 tool 状态，并对空 prompt 用真值判断

务必保留 workbuddy 已验证的三点：
1. **`toolsAdded`/`toolsRemoved` 按序回放**成 `context.tools`。0.85 的 `buildParams` 只从 `context.tools` 取 tools；本机实测 transcript 经 0.85 `convertMessages` 后只剩 `[{role:'user',content:'hi'}]` —— 连 system prompt 一起丢。
2. **空字符串 `systemPrompt` 视为「未设置」**（用真值判断，别用 `!== undefined`）：0.86+ 的 `createInitialSystemMessage` 在 prompt 为空但带 tools 时仍会造出 `content:''` 的 system 消息，若不折上去，tools 会连带丢失。
3. **折返谓词用形状判断**（`if (context.systemPrompt) return context`），但**外层是否启用折返必须按代际门控** —— 报告 note 2 说「按形状判断对两个代际都安全」是不对的，形状判断只保证旧代输入幂等，挡不住对现代 api 误折。

### 5.3 必须补测试（这是本缺陷能漏过去的直接原因）

本仓 55 个测试文件中，**没有任何一个** import `src/adapter.ts` 或引用 `@earendil-works/pi-ai`／`createProvider`／`openAICompletionsApi`。建议至少四条：

1. **折返单测**：transcript + `toolsAdded` → 断言 `systemPrompt` 被提升、`tools` 就位、`messages` 中无 system 条目。
2. **幂等单测**：旧代形状输入 → 返回同一对象（引用相等）。
3. **现代透传单测**：判据为现代时返回**原 api 对象**，不做任何包裹。
4. **集成对拍**：取**实际解析到的那一份** pi-ai，对折返后的 context 跑 `estimateContextTokens` + `convertMessages`，断言不抛错、`params.messages[0].role === 'system'`、`params.tools` 非空。这条用例在 0.85.1 与 0.86+ 上都必须绿。
5. **双向矩阵用例**（§5.0 的四组合，防回归的关键）：用注入的 `piAiGeneration` 参数分别模拟旧代/新代 api，× legacy/transcript 两种输入，断言四种组合下 `estimateContextTokens` 不抛错、system 提示与 tools 均不丢。**第 2 行（旧宿主 + 新库）必须显式覆盖** —— 它是纯形状判据会漏掉的那一格。

### 5.4 已实现（3.4.2）

本仓已按上述方案落地，实现与验证状态：

| 项 | 位置 |
|---|---|
| 世代探测（版本号主判据 + 包布局兜底） | `src/pi-ai-runtime.ts`（全部导出：`piAiRuntimeInfo`、`generationOf`） |
| 折返（transcript → 旧形状，含工具回放） | `src/adapter.ts` 的 `adaptLegacyPiAiContext` |
| 折上（旧形状 → transcript） | `src/adapter.ts` 的 `adaptModernPiAiContext` |
| 代际门控 + 接入 `createProvider` | `src/adapter.ts` 的 `withContextAdaptation`，工厂 `api:` 处调用 |
| 可注入代际（供测试覆盖本机没有的组合） | `TraeAdapterOptions.piAiGeneration` |
| 启动期诊断日志 | `src/index.ts`，打印 `pi-ai <version> (<generation>)` |
| 函数级 + 集成对拍（30 例） | `tests/pi-ai-context.spec.ts` |
| **接线层**（工厂路径，7 例） | `tests/pi-ai-adapter-wiring.spec.ts` |

**一处与原计划的偏离，值得记录**：§5.1 建议用 `import.meta.resolve('@earendil-works/pi-ai/utils/transcript')` 做能力探测。实测**该探测在 vite/vitest 下是假阳性** —— bundler 风格解析器把 exports map 的 `"./utils/*"` 通配符展开成路径后**直接返回，不检查文件是否存在**，于是对 0.85.1 也报「有」，把旧代误判成 modern。若照此实现，**会在声称「按能力判断」的同时原样放过 issue #27**。最终判据改为读取包目录（版本号数值比较为主、`dist/utils/transcript.js` 是否存在为辅），两者都不经过解析器语义。

**测试有效性的变异验证（8/8 被抓）**：① 工厂移除适配层 → 5 例失败；② 折返只搬 prompt 不搬 tools → 6 例失败；③ 边界写成 `>= 87` → 1 例失败；④ 折上不移除顶层字段 → 2 例失败；⑤ 折返不做幂等短路 → 5 例失败。

其中变异 ① 最初**未被捕获** —— 函数级用例全绿而有缺陷的接线照样通过，这正是 issue #27 本身的形状（函数没问题，只是没人调用），因此专设了 `tests/pi-ai-adapter-wiring.spec.ts`。

另有 3 条由独立评审的变异测试暴露，均已修复并补用例：

| 变异 | 后果 | 修复 |
|---|---|---|
| ⑥ 折返漏读 `sections` | 以 section 形态到达的提示整体折成 `undefined`（**静默丢整个系统提示**） | `systemTextOf` 对齐库的 `getSystemMessageText`：`content` 在前，按声明顺序接全部非 null section |
| ⑦ 折上跳过多 system 消息的混合形状 | 顶层提示与其工具被**静默丢弃** | 改为与 `normalizeContext` 逐字对齐的**前插**；实测输出经真实 0.87.1 `resolveTranscript` 折叠后与其结果逐字相同 |
| ⑧ 不可探测时默认 `legacy` | 本机永不可达，但市场安装正建立在这个默认值上 | 显式用例钉住 `decidePiAiGeneration(undefined, undefined) === 'modern'`，并导出该决策函数 |

**评审直接确认的四点**：双向四组合均不丢提示/不丢工具/不重复 system 消息；0.86 边界在 0.85.1、0.86.0、0.86.1、0.87.1、1.0.2 五个真实 tarball 上逐项成立；`import.meta.resolve` 假阳性被独立复现；接线层用例确实覆盖工厂路径。

---

## 六、给报告人的回复要点（可直接引用）

1. 根因、栈、机理**全部接受**，本机已在 0.82.1 与 0.85.1 上独立复现，端到端复现产出的 `errorMessage` 与你日志逐字相同。感谢提供完整栈与最小脚本 —— 这两样是这次能定性的关键。
2. 但请更正三处：**代际边界是 0.86.0**（0.86.0 起有 `utils/transcript.js`、`estimateMessageTokens` 的 system 分支，且 api 不再读 `systemPrompt`/`tools`）；**CASE B 实测是 `{"tokens":25}`**，按脚本原文在 0.82.1/0.85.1 上均不可得 15；**`undefined maxTokens` 返回 `NaN` 而非夹回正整数**（后果无害，因 NaN 为假值不下发）。
3. 「照抄 workbuddy 的代际门控」**不能照抄**：它的 `>=87 → modern` 把 0.86.x 误判为 legacy，折返会静默丢掉 system prompt 与全部 tools。修复应以 **0.86** 为界。
4. 「收紧 peer」**不构成止血**：DSH 内核预检只覆盖 `@deepseek-ai/dsh*`（`plugin-compatibility.ts:75`），pi-ai 不在其中；你引用的 `install-compat` 告警来自 **dshmarket**，是 `soft-incompatible` 告警而非拒绝；且你的 `0.82.1` 本就在 `>=0.85.1` 之外，加不加上界都不改变该场景。
5. **升级 DSH 不是出路**：你报的 `0.2.0-rc.2` 就是当时的最新宿主，而「新宿主」那一侧不可逆（0.2.0-rc.1 之后全是 `^0.87.1`/`^1.0.2`），升级只会让你更牢地留在崩溃组合里。真正能让 `0.82.1` 消失的是 `@opencode2dsh/dsh-plugin` 的硬依赖改变（其最新 0.3.11 仍声明 `^0.82.1`），或本插件的适配层 —— 后者已在 **3.4.2** 落地。
6. 顺带修掉了一个**你没遇到但同样静默**的反向错配：旧宿主（`dsh-llm-pi-ai` ≤0.2.0-rc.1）配新库时不会崩，但现代 api 只读 system 消息，顶层 `systemPrompt`/`tools` 会被静默忽略 —— 系统提示与**全部工具声明**丢失。适配层现已双向覆盖，并有用例钉住。
