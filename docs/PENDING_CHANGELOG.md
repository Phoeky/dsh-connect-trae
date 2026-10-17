# 待写入 CHANGELOG 的条目（下一个版本）

> **这份文件是一块暂存区，不是文档。** 发版时把下面的内容整段追加到
> `CHANGELOG.md` 顶部（`# Changelog` 之后、最新已发布版本之前），然后删除本文件。
>
> **为什么不能直接写进 `CHANGELOG.md`：** 它是**随包文件**（在 `package.json` 的
> `files` 里）。已发布的 tag `v3.7.0` 之后若改动任何随包文件，
> `pnpm run verify:release` 会（正确地）报出「tag 之后改动了发布内容」——
> 因为那意味着线上包不再等于「tag 指向的源码」。而未发布版本的条目本来就
> 不属于已发布的那份 CHANGELOG。
>
> 放在 `docs/` 下是安全的：`docs/*.md` 不进发布包（只有
> `docs/assets/dsh-connect-trae-usage-card.png` 随包），所以改它不会污染发布内容。
>
> 这个文件本身就是这条规则的一次应用：**未发布的说明写在不进包的地方。**

---

---

## 未发布

> 新增 CN 企业版（租户）通路，并修好大小写敏感的 `config_name` 映射。

### 新增

- **卡片新增「企业版」面板**：供应商开关从「按区域」改为「按面板」，国内版、企业版、
  国际版三者并列，各有**独立开关、独立账号绑定、独立模型选择**。

  | 面板 | provider | 默认开关 |
  |---|---|---|
  | 国内版 | `trae` | 开 |
  | 企业版 | `trae-enterprise` | **关**（原来两个面板的用户不受影响） |
  | 国际版 | `trae-global` | 开 |

  关掉企业版不会影响国内版；两个 CN 池的模型选择也不再互相覆盖。企业版默认关闭，
  因为纯个人账号用不了企业池 —— 默认放开等于给所有人塞一条一用就失败的 provider。

- **`trae-enterprise`（显示名「Trae 企业版」）**：同一个 CN 凭据若属于 `tob_online` 租户，
  会同时被两个聊天网关服务 —— 消费池 `trae-api-cn.mchost.guru` 与租户池
  `console.enterprise.trae.cn`。同一模型走前者扣个人积分、走后者扣企业额度，所以「谁付费」
  必须是用户显式选择，而不是插件替你猜。现在 `cn` 区并列发布两个 provider：

  | provider | 计费池 | 说明 |
  |---|---|---|
  | `trae` | 消费 SOLO | 行为与此前完全一致，永不碰企业网关 |
  | `trae-enterprise` | 企业租户 | **不回落**，失败如实报错 |

  `TRAE_PROVIDER_IDS` 描述每个区发布哪些 id，`routeOfTraeProvider` 把 id 映射到计费池；
  **路由在构建 provider 的客户端时固定**，不存在「按调用猜一次」。shim 为每个 provider
  提供一条 bearer 路由并按 bearer 分派，未知 token 直接 401，不会退回第一条路由。

### 修复

- **`deepseek-v4.1-flash` 等模型报 `4001`（`param is invalid`）**：网关的 `config_name`
  **区分大小写**，而 Remote 目录给的是小写、网关只认 `DeepSeek-V4.1-Flash`。三处一起修：

  1. `modelConfig` 补上 `wireConfigName`。DSH 设置通道用它重建文档，未声明的字段会在
     **每次保存时被丢掉** —— 映射一丢，该模型就要等到下一次发现才能用。
  2. `fetchModels` 改为从**客户端所钉的那条网关**读名录。两个池的名录不同
     （`DeepSeek-V4.1-Flash` 只有企业池列），原本钉在企业池的客户端去读消费池名录，
     永远发现不了自己池的独占模型。
  3. `TraeSoloBridge` 查表改为大小写不敏感，映射都落空时退回目录行自己的 id。

- **企业网关的拒绝形态**：它是 **HTTP 200**，但首帧是 `event:error`（`code 4001`）。
  现在会被转成真正的客户端错误，正常流则逐字节重放给调用方 —— 否则拒绝会表现成
  「这一轮助手什么都没说」。

- **企业网关要求每次调用带 `session_id`**，而消费网关会拒绝带它的请求体，所以只在该路由上加。

### 自测

- 企业版相关新增 **38** 项（`enterprise-provider` 17、`card-enterprise-panel` 9、auth 租户
  作用域 4、web-status 过滤 3、catalog 费率 1、solo-bridge 错误码 1……详见 PR 描述第 3 节）。
  覆盖按 bearer 分派、`session_id` 只在该路由、200/`event:error` 识别、流原样透传、
  名录按路由读取、大小写映射与 schema 往返、租户账号作用域、4222 可读等。
- 用真实 `tob_online` 帐号实测：企业路由返回 PONG、带 `session_id`、个人 `consumed_amount` 不变。

---

> 发布流程工具化，不影响插件运行时行为。

### 新增

- **`pnpm run verify:release`**（`scripts/verify-release.mjs`）：把 RELEASING.md 第 8 步
  从手工核验变成一条命令，21 项检查一次做完 —— tag 版本、tag 之后的提交、工作树状态、registry 收录、
  `latest` 指向、**发布包每一个文件**与 tag 逐字节比对、`lib/` 由 tag 源码重建后比对。
  退出码即结论：`0` 一致 / `1` 不一致 / `2` 前置条件不满足。

  > 手工版本的三个已知盲点被闭合：核对清单只写了 8 个文件而发布包有 15 个
  > （`icons/`、`docs/assets/`、`scripts/verify-windows.mjs` 从未被核对）；
  > 拿本地 `lib/` 当基准会掩盖「构建自未提交工作树」；`git show` 默认按 UTF-8 解码，
  > 把 PNG 当文本会得到假的不一致 —— 本脚本第一版就踩了这个坑，三个图片文件全部误报。

### 文档

- RELEASING.md 第 8 步改为脚本优先，手工等价步骤保留在折叠区并注明其局限。

### 测试

- 新增 7 例（`tests/verify-release.spec.ts`），用 PATH 上的假 `npm`/`tar` 提供受控发布包，
  子进程跑**真脚本**：一致→0、篡改→1、多出文件→1、无 tag→2、未发布→2、二进制逐字节比对、
  tag 之后有提交仍→0。
- **变异验证**：把 `git show` 改回 UTF-8 解码 → 2 例变红；让比对恒返回「一致」→ 1 例变红。
- 全仓 **670** 例通过（原 663 + 7）。

> 本条目对应的改动本身不触碰任何随包文件，因此 `verify:release` 仍然通过——
> 这是脚本「tag 之后可以提交，但不得改动发布内容」这条判据的一次真实自检。

---

> 对齐宿主，不影响插件运行时行为。

### 变更

- **对齐宿主 DSH 0.2.1-rc.2**：13 个 `@deepseek-ai/dsh-*` devDependency 从 `0.2.1-rc.1`
  推进到 `0.2.1-rc.2`。`cordis` / `schemastery` / `pi-ai`（仍 `1.1.0`）均未变。
- **peer 范围无需改动**：`0.2.1-rc.2` 对 `>=0.1.7-rc.1 <0.3.0-0` 已判通过（实测）。

### 测试

- `tests/dsh-peer-range.spec.ts` 的 `MUST_ADMIT` 补入 `0.2.1-rc.1` / `0.2.1-rc.2` / `0.2.1`。
  此前这份「必须放行的版本」清单里**没有当前正在使用的版本**——范围若被误收窄到
  当前宿主之外，测试仍会全绿。变异验证：把上界改到 `<0.2.1-rc.2` → 对应用例立刻变红。
- 全仓 **670** 例通过。

### 已核对确认无变化

- 逐字节比对插件消费的宿主包（`.d.ts` 与 `lib/*.js`）——`dsh-llm`、`dsh-llm-pi-ai`、
  `dsh-settings`、`dsh-host-webserver`、`dsh-atomic-write`、`dsh-home-paths`、
  `dsh-attachment`、`dsh-client-ui-renderer`，以及 `dsh-app-boot` 的 peer 门禁：**全部相同**。
- pi-ai 仍为 `1.1.0`，`openai-completions.js` 与 `utils/transcript.js` 未变，
  上一轮的双向适配结论原样成立。
- 线上请求体探针在真实 rc.2 栈上复跑，结果与 rc.1 一致。

---

> 发布流程工具化，不影响插件运行时行为。

### 新增

- **`pnpm run verify:release`**（`scripts/verify-release.mjs`）：把 RELEASING.md 第 8 步
  从手工核验变成一条命令，21 项检查一次做完 —— tag 版本、tag 之后的提交、工作树状态、registry 收录、
  `latest` 指向、**发布包每一个文件**与 tag 逐字节比对、`lib/` 由 tag 源码重建后比对。
  退出码即结论：`0` 一致 / `1` 不一致 / `2` 前置条件不满足。

  > 手工版本的三个已知盲点被闭合：核对清单只写了 8 个文件而发布包有 15 个
  > （`icons/`、`docs/assets/`、`scripts/verify-windows.mjs` 从未被核对）；
  > 拿本地 `lib/` 当基准会掩盖「构建自未提交工作树」；`git show` 默认按 UTF-8 解码，
  > 把 PNG 当文本会得到假的不一致 —— 本脚本第一版就踩了这个坑，三个图片文件全部误报。

### 文档

- RELEASING.md 第 8 步改为脚本优先，手工等价步骤保留在折叠区并注明其局限。

### 测试

- 新增 7 例（`tests/verify-release.spec.ts`），用 PATH 上的假 `npm`/`tar` 提供受控发布包，
  子进程跑**真脚本**：一致→0、篡改→1、多出文件→1、无 tag→2、未发布→2、二进制逐字节比对、
  tag 之后有提交仍→0。
- **变异验证**：把 `git show` 改回 UTF-8 解码 → 2 例变红；让比对恒返回「一致」→ 1 例变红。
- 全仓 **670** 例通过（原 663 + 7）。

> 本条目对应的改动本身不触碰任何随包文件，因此 `verify:release` 仍然通过——
> 这是脚本「tag 之后可以提交，但不得改动发布内容」这条判据的一次真实自检。
