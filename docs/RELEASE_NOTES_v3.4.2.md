## v3.4.2（2026-10-13）

> **插件现在与它自己解析到的那份 `@earendil-works/pi-ai` 代数对齐了。**
> 修的是 [issue #27](https://github.com/dingminhua/dsh-connect-trae/issues/27)：任意模型都报
> `PI_AI_ERROR / Cannot read properties of undefined (reading 'length')`。

这是一次 **patch** 升级，只做一件事——**让插件说它对面那个库听得懂的话**。

起因很迷惑人：报告人**换任何模型都崩**（`step-5-preview`、`mimo-v2.6-flash`、`glm-5.3-flashx`
全部必现），**105 毫秒内**就在本地失败，每次的 usage 都是 `0/0/0`。
「与模型无关 + 本地瞬间失败 + 没发出任何请求」这三个特征合起来说明：**问题不在模型，也不在 Trae**，
而在请求被构造出来之前的那一步。

---

### 修复

- **插件不再把宿主给的上下文原样交给自己的 api，而是按代数双向适配。**

  `dsh-connect-trae` 把 `@earendil-works/pi-ai` 声明为 peer —— 这是对的，但意味着**它解析到哪一份由安装
  环境决定，未必是宿主那一份**。而两代 pi-ai 对「上下文长什么样」的定义不同：

  | | 旧代（≤0.85） | 新代（0.86+） |
  |---|---|---|
  | 形状 | `{ systemPrompt, tools, messages }` | `{ messages: [ {role:'system', content:<字符串>, toolsAdded}, … ] }` |
  | 系统提示 | 顶层 `systemPrompt` | **只**挂在那条 system 消息上 |
  | 工具声明 | 顶层 `tools` | **只**挂在那条 system 消息的 `toolsAdded` 上 |

  崩溃的机理很具体：新代在入口调一次 `normalizeContext()`，于是 provider 收到的是归一化 transcript；
  而旧代的 `estimateMessageTokens` **没有 `role === 'system'` 分支**，它 `for (const block of message.content)`
  迭代一个**字符串**，逐字符拿到 `block`，再读 `block.name.length` → `TypeError`。
  这一步位于 `buildBaseOptions` 内、**早于任何 HTTP 构造** —— 所以是「105ms 本地崩溃 + usage 恒 0 +
  换模型无效」。

  **两个方向都修了**，因为 DSH 自己也横跨两代（`dsh-llm-pi-ai` ≤0.2.0-rc.1 声明 `^0.85.1`，
  0.2.0-rc.2 起声明 `^0.87.1`，0.2.1-alpha.2 已到 `^1.0.2`）：

  - **新宿主 + 旧库**（issue #27 本尊）：必崩 —— 现在折返成旧形状，不再崩。
  - **旧宿主 + 新库**：不崩，但现代 api 只读那条 system 消息，顶层字段被**静默忽略** →
    系统提示与**全部工具声明**丢失（模型永远不会产生 toolCall）。这类故障更隐蔽，
    只修前者等于把一个响亮的故障换成一个安静的故障 —— 现在同样折返，把它接上。

- **代际判据落在 `0.86`，不是 `0.87`。**

  报告和兄弟插件的既有实现都按 `>= 0.87 → 新代` 划分。实测**真实边界是 0.86.0** ——
  `dist/utils/transcript.js`、`normalizeContext`、估算器的 system 分支、以及「不再读顶层字段」
  这四件事**同时**出现在 0.86.0。

  这个偏差若照抄会有害：遇到 **0.86.x** 时 `>= 0.87` 的判据会把它当旧代而执行折返，
  而 0.86+ 的 api 根本不读顶层字段 → 系统提示与全部工具被静默丢弃。

- **工具声明必须一起搬，不能只搬提示文本。** `normalizeContext` 之后，`toolsAdded` 是工具声明的
  **唯一**载体；而旧代 api 只从顶层 `tools` 取工具。只搬文本 → 不崩了，但模型永远调不了工具。
  实现按 `toolsRemoved` → `toolsAdded` 的顺序回放，与 pi-ai 自己的 `getCurrentTools` 合并语义一致。

- **提示文本的两条载体都搬，`sections` 不能漏。** 新代 `SystemMessage` 的提示文本有 `content` 与
  `sections` 两条载体，库自己的 `getSystemMessageText` 是「`content` + 全部非 null section」按空行连接。
  只读 `content` 会让以 section 形态到达的提示整体折成 `undefined` —— 与要防的「静默丢失」同类。

- **探测不依赖版本号字符串。** 主判据是解析到的那份包 manifest 的版本，用**数值**比较
  （`major > 0` 或 `minor >= 86` 即新代），所以 `0.9.0` 不会被误判为高于 `0.86.0`，已发布的 `1.x`
  也无需改动即可正确归类；版本读不到时退化为包布局判据。

  一个反直觉的发现：**`import.meta.resolve()` 不能用来做这个探测**。bundler 风格的解析器
  （vite，以及在它之上的 vitest）会把 exports map 里的 `"./utils/*"` 通配符展开成路径**并直接返回，
  不检查文件是否存在**，于是对 0.85.1 也回答「有」。实测该假阳性会把 0.85.1 判成新代 ——
  **在声称「按能力判断」的同时原样放过 issue #27**。

### 诊断

- **启动时打印解析到的 pi-ai 版本与代数**。混代安装是「安静坏掉」的那一类，日志里一行
  `dsh-connect-trae: pi-ai 0.85.1 (legacy generation)` 让它在下次出现时立刻可见。

### 测试

- **549 → 594（+45）**，并做了**变异验证 8 次、8 次全被抓**：把修复从代码里删掉或改错后，
  ① 移除适配层 → 5 例失败；② 只搬提示不搬工具 → 6 例失败；③ 边界写成 `>= 87` → 1 例失败；
  ④ 折返时不移除顶层字段 → 2 例失败；⑤ 折返不做幂等短路 → 5 例失败；⑥ 漏读 `sections` → 2 例失败；
  ⑦ 折上跳过多 system 消息 → 1 例失败；⑧ 不可探测时默认旧代 → 1 例失败。

- 其中变异 ① 最初**没被捕获** —— 函数级用例全绿，而接线有缺陷的工厂照样通过。
  这正是 issue #27 本身的形状（函数没问题，只是没人调用），因此另设了
  `tests/pi-ai-adapter-wiring.spec.ts`：mock 掉 pi-ai 的 api 模块，经
  `adapter.current() → piProvider → streamSimple` 走**真实装配路径**断言交付的形状。

### 文档

- 发布前经**独立评审**对抗性复核（真实发布包 + 真实 api 模块）：双向四组合、0.86 边界、以及
  `import.meta.resolve` 假阳性均被独立复现确认；评审提出的 3 条缺陷（`sections` 载体、混合形状折上、
  不可探测分支默认值）已全部修复并补上用例。

- `docs/ISSUE27_DIAGNOSIS.md`：对外部报告的逐条核验 —— 调用链 6 跳的取证、双向错配四组合矩阵的实测
  结果、DSH 各版本与 pi-ai 代数对照，并明确指出该报告的 **3 处硬错误**（代际边界实为 0.86 而非 0.87；
  CASE B 实测为 `{"tokens":25}` 而非 `15`；`undefined maxTokens` 实为 `NaN` 而非「夹回正整数」）
  与 **2 处需修正的修复建议**。

---

### 升级

```bash
dsh plugin install dsh-connect-trae@3.4.2
```

升级后重启 DSH 即可。若你在日志里看到
`dsh-connect-trae: pi-ai <版本> (<代数>)`，那就是本次修复的探测结果 ——
`legacy` 表示你这份安装解析到了 ≤0.85 的旧代，适配层会为它折返。
