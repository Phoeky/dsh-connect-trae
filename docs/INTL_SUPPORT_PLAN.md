# Trae 国际版（ai）支持实施方案

> 整理自 2026-09-15 的调研与取证：workbuddy 国际版机制对照、本机四版凭证实测、
> 网关/目录/refresh/pay 的只读探测。原始证据见 `docs/INTL_SG_EVIDENCE.md`（证据等级 A/A+/B/D），
> 探测脚本 `scripts/probe-intl.mjs`、`scripts/probe-intl-parse.mjs` 可复跑。
> 参考样板：`dsh-connect-workbuddy` 的 regions 分桶改造（其 CHANGELOG「按区域隔离」一节）。

## 目标

Trae 国内版与国际版账号在本插件中获得完全对等的支持：**零配置、零开关、全自动**——
用户在账号列表里选国际账号即切到 ai 桶，选回国内账号即回 cn 桶。选国际账号首次拉取即得
完整国际模型目录（Gemini / GPT / MiniMax / Kimi 阵容），且两个区域的目录与勾选互不干扰。

## 核心决策（两层模型）

1. **region 只有两个：`'cn' | 'ai'`，是「2 套存储」的分桶键。** 模型目录、勾选、图片开关、
   上下文预算、fallback、聊天网关、remote 目录、usage 数据源全部按 region 二分。
   对应 workbuddy 的 `'cn' | 'global'`。
2. **edition 保持 4 个（cn / sg / solo / solo-sg），只是凭证来源标签。** 决定扫描哪个安装目录、
   product.json 路径、CLI home 与 refresh 契约分支；不做桶键——同 region 内桌面版与 SOLO 版
   凭证共用同一套网关与目录（实测：CN 两版同用 `api.trae.cn`，国际两版同用 `coresg-normal.trae.ai`）。
   映射：`cn|solo → cn`，`sg|solo-sg → ai`。
3. **region 判定用凭证字段，不用用户配置。** 权威来源 `userRegion.region`（`'CN'|'SG'`，
   大小写不敏感——日志中亦见小写 `'sg'`），host 后缀 `.trae.ai` 兜底，edition 兜底。
4. **refresh 契约按 edition 分叉（4 套），是唯一不按 region 二分的点**：
   ⚠️ **已被 2026-10-11 的新契约取代**，见 INTL_SG_EVIDENCE.md §2.2.1：四版现均走
   `/trae/api/v3/oauth/ExchangeToken`，ClientID 按「是否 SOLO 包」分叉（桌面 `ono9krqynydwx5` /
   SOLO（CN + 国际）`en1oxy7wnw8j9n`），且**强制 `DeviceProof` 签名**（密钥取自 storage.json 的
   `iCubeAuthInfo://icube-dc:`）。旧 `/cloudide` 契约今日对 cn/sg/solo 仍 200，降级为**回退**。
   下段为原设计记录：`cn` / `sg` / `solo` 走 `/cloudide/api/v3/trae/oauth/ExchangeToken` +
   ClientID `ono9krqynydwx5`；`solo-sg` 走 `/trae/api/v3/oauth/ExchangeToken` + ClientID
   `en1oxy7wnw8j9n` + DeviceInfo（`PlatformCode: "SOLO_PC"`）。
   证据见 INTL_SG_EVIDENCE.md §2.2（桌面版 `userJwt` 直证同 CN；SOLO 国际版官方日志直证新契约）。
5. **请求头与解密器两侧通用（实测）**：`buildTraeCnHeaders` 的整套头（`x-app-id` `6eefa01c-…`、
   identity 头、`Cloud-IDE-JWT`）被 SG 网关原样接受；`decryptTraeStorageValue` 四版通吃。
   因此 protocol.ts 只需放开 edition 校验，不需要双套头。
6. **模型目录解析链路零改动（实测）**：`parseTraeRemoteModel` 7/7、`get_detail_param` 形态 14/14、
   `mergeTraeModelSources` 直通并命中 `wireConfigName`（`gemini-3.1-pro` → `custom_model_gemini`）。
   国际版只需换 base URL。
7. **usage 换数据源**：ai 侧无 Work 积分包（`web_user_ent_usage` 未出现于 SG 日志），改用
   `ide_user_pay_status`（订阅/试用状态，官方 App 自调端点，实测 200）。
8. 旧扁平配置字段**只读作 cn 桶的迁移来源**，ai 桶绝不继承——这是 workbuddy 验证过的
   「旧数据一律来自国内端点」迁移语义，防止国内勾选与国际目录求交集后静默丢选。

## 网关常量（实测汇总）

| 用途 | cn | ai |
|---|---|---|
| 聊天（solo client / raw gateway base） | `https://trae-api-cn.mchost.guru` | `https://coresg-normal.trae.ai` |
| remote 目录（TraeSoloRemoteCatalogClient） | `https://solo.trae.cn/api/remote/v1` | `https://coresg-normal.trae.ai/api/remote/v1` |
| usage pay base | `https://api.trae.cn`（`/trae/api/v2/pay/web_user_ent_usage`） | 凭证 host（`/trae/api/v1/pay/ide_user_pay_status`，growsg / api-sg-central 均可） |
| refresh | 凭证 host + 按 edition 的路径（见决策 4） | 同左 |

实现时把网关 host 收敛为一张 `REGION_GATEWAYS` 常量表（`src/paths.ts` 或新 `src/region.ts`），
出问题只改常量。

## 模块改造清单

### A. region 基础设施（新增，建议 `src/region.ts`）

- `export type TraeRegion = 'cn' | 'ai'`
- `regionOfEdition(edition: TraeEdition): TraeRegion`（`cn|solo → cn`，`sg|solo-sg → ai`）
- `regionOfUserRegion(value: unknown): TraeRegion | undefined`（读 `userRegion.region`，大小写不敏感）
- `regionOfHost(host: string): TraeRegion | undefined`（`.trae.ai` 后缀 → ai，`.trae.cn` → cn）
- `regionOfCredential(credential): TraeRegion`（userRegion → host → edition 三级兜底）
- `REGION_GATEWAYS`：上表的 base 常量
- `TraeCredential` 与 `TraeWebAccount` 暴露 region（派生字段，不落盘）

注意：`auth.ts` 现把 CLI token 的 host 统一补 `CLI_DEFAULT_HOST = 'https://api.trae.cn'`——
国际 CLI（`~/.trae`）的默认 host **未验证**，第一阶段国际 CLI 保持禁用（`.trae` 候选继续被
edition 过滤），列入待验证。

### B. 凭证层（`auth.ts` / `refresh.ts` / `identity.ts`）

- `candidates()`：过滤条件从 `edition === 'cn' || edition === 'solo'` 改为按 `edition !== undefined` 全收
  （保留现有 `edition` 配置项作为用户显式收窄；`auto` 默认收全部四个）。
  相应删除「This connector targets the CN service only」注释语义。
- `readAll()`：own 副本从 `own?.edition === 'cn' || own?.edition === 'solo'` 放开为全部 edition。
- `refresh.ts`：`CLIENT_ID_BY_EDITION` 扩为四 edition 的契约表（路径 + ClientID + 是否带
  DeviceInfo）。`solo-sg` 的 DeviceInfo 按官方形态构造（`DeviceID` / `MachineID` /
  `PlatformCode: "SOLO_PC"` / `DeviceType: "PC"` / `DeviceName`），需要 identity 注入或从
  credential 派生——DeviceInfo 必填性未实测，按官方形态带上最稳。
- `identity.ts`：product.json 的 appName 映射补 `'Trae'` / `'TRAE SOLO'`（现在只有
  `'Trae CN'` / `'TRAE SOLO CN'`，国际版 appVersion 会静默缺失）。
- `index.ts` 的 `identity()`：候选过滤同步放开（现在同样只挑 cn/solo 桌面候选）。

### C. 配置分桶（`index.ts` / `catalog.ts`）

```ts
export interface TraeRegionState {
  lastCatalog?: TraeModelInfo[]      // 该区域上次刷新的原始目录
  enabledModelIds?: string[]        // 该区域的勾选
  imageModelIds?: string[]          // 该区域的图片 opt-in
  contextBudgets?: Record<string, number>  // 该区域的上下文预算
}
export interface Config {
  // …authFile / edition / accountId 不变…
  regions?: Partial<Record<TraeRegion, TraeRegionState>>
  /** @deprecated 区域拆分前的单槽字段，读取时归入 cn 桶（仅当 regions.cn 缺失时） */
  lastCatalog?: TraeModelInfo[]
  /** @deprecated */ enabledModelIds?: string[]
  /** @deprecated */ imageModelIds?: string[]
  /** @deprecated */ contextBudgets?: Record<string, number>
  /** @deprecated 旧的生成目录 */ models?: TraeModelInfo[]
}
```

- `regionStateOf(config, region): TraeRegionState`——显式槽优先；旧扁平字段只对 `cn` 生效，
  `ai` 永不继承（平移 workbuddy 的同名函数与其回归测试）。
- settings schema：`regionStateConfig` 子对象 + `regions: z.dict(regionStateConfig).default({})`，
  旧扁平字段保留声明（迁移读取）。
- `fallbackModelsFor(region)`：`FALLBACK_TRAE_MODELS`（cn，现状）+ 新增 `FALLBACK_TRAE_MODELS_AI`
  （从 2026-09-15 实测目录捕获：gemini-3.1-pro / gemini-3-flash-solo / minimax-m3 / minimax-m2.7 /
  kimi-k2.5 / gpt-5.4 / gpt-5.2，ctx 与 multimodal 按实测值）。
- `configuredModels(value, region)` / `displayModels(value, region)` / `derive` 全部带 region；
  `currentRegion` 由每次凭证读取路径收敛（startup seed / discovery / card route / onChange，
  平移 workbuddy 的 `regionOfCredential()` 模式：onChange 先同步后异步收敛）。
- `dropDeadModels` / `wireResolved` / `callableKeys` 机制不动（解析器实测兼容 ai 响应）。

### D. 上游路由（`index.ts` / `solo.ts` / `solo-remote.ts` / `usage.ts` / `protocol.ts`）

- `index.ts` 两处硬编码 `'https://trae-api-cn.mchost.guru'`（solo client 构造、raw client 构造）
  改为 `REGION_GATEWAYS[region].chat`；raw gateway 的 `endpoint` 同理。
- `solo.ts` / `solo-remote.ts`：构造参数已支持 `baseUrl`，只需调用方按 region 传入；
  `solo-remote.ts` 的 `TRAE_SOLO_REMOTE_BASE` 常量拆为两 region 值
  （实测 en / Asia/Singapore 头 200，timezone/language 头保持现状即可）。
- `usage.ts`：`TraeUsageClient` 增加 ai 分支——端点 `ide_user_pay_status`（POST `{}`）、
  响应解析订阅/试用状态（`is_dollar_usage_billing` / `trial_status` / `solo_fission_*` /
  `enable_solo_*` 等，字段取舍实现时定）；cn 分支维持 `web_user_ent_usage`。
  **ai 的 `TraeWebCredits` 与 cn 不同构**，卡片需要按 region 渲染不同区块。
- `protocol.ts buildTraeCnHeaders`：删除 `edition !== 'cn' && edition !== 'solo` 的抛错（头实测通用），
  函数改名 `buildTraeHeaders` 并保留导出别名一个版本。

### E. 卡片（`status-paths.ts` / `web-status.ts` / `client/TraeUsageCard.tsx`）

- `TraeWebUsage` 的 signed-in 分支加 `region: TraeRegion`；`TraeWebAccount` 加 `region`。
- `web-status.ts`：`displayModels(region)` / `enabledModelIds(region)` / `imageModelIds(region)` /
  `contextBudgets(region)` 四个访问器区域化（对齐 workbuddy 的 `WorkBuddyStatusRouteOptions`）；
  `traeWebUsage` 在 resolve 凭证后按 `regionOfCredential` 定 region，models/refresh 路由同理
  （refresh 后 contextBudgets 从该 region 桽读取）。
- `TraeUsageCard.tsx`：保存写 `settingsScope.set('regions', { ...既有regions, [status.region]: {…} })`
  （平移 workbuddy `saveModels`：只写当前账号所属桶，另一桶不碰；未保存前 contextBudgets
  显示回退旧扁平字段仅当 region === 'cn'）。账号列表行显示 region 徽标（「国内 / 国际」）。
  ai 区域的 credits 区块按订阅制渲染。

### F. 测试（平移 workbuddy 四组样板 + 本项目既有断言风格）

- `region.spec.ts`（新）：`regionOfUserRegion`（`'SG'`/`'sg'`/缺失）、`regionOfHost`（`.trae.ai`
  / `.trae.cn` / 空）、`regionOfEdition` 四映射、`regionOfCredential` 三级兜底。
- `auth.spec.ts`：四 edition 的 `candidates()` 全收；own 副本收 sg/solo-sg；account 列表带 region。
- `refresh.spec.ts`（已重写）：四 edition 断言走当前契约 `/trae/api/v3/oauth/` 且 ClientID 按
  「是否 SOLO 包」分叉（solo、solo-sg → `en1oxy7wnw8j9n` + `SOLO_PC`；cn、sg → `ono9krqynydwx5`
  + `IDE_PC`）；proof 用真实 P-256 密钥签发并按**换行**连接的消息验证（空格连接必须验签失败）；
  无 keypair 时降级旧 `/cloudide` 契约；当前契约被拒时回退；两条路径的失败都写进错误信息。
- `catalog.spec.ts`：`regionStateOf` 迁移语义（旧扁平读作 cn、ai 绝不继承、显式槽优先）；
  `fallbackModelsFor` 隔离（ai 清单无 GLM/DeepSeek，cn 清单无 Gemini/GPT）。
- `solo-remote.spec.ts` / `solo.spec.ts`：stub 凭据断言 cn → `solo.trae.cn`、ai → `coresg-normal.trae.ai`。
- `usage.spec.ts`：ai 凭据走 `ide_user_pay_status` 且解析订阅状态；cn 维持积分包。
- `web-status.spec.ts`：signed-in 文档带 region 且与凭证域一致；四个访问器收到的都是该 region；
  models/refresh 用该 region 的 contextBudgets 投影。
- `settings-integration.spec.ts`：regions 桽写入/读取往返；旧扁平 → cn 迁移一次后不再读旧字段。

### G. 文档与 CHANGELOG

- README（中英）：国际版支持说明（选国际账号即切换，零配置）。
- CHANGELOG：对齐 workbuddy「正式支持国际版」条目结构（怎么用 / 可用功能 / 区域隔离 / 测试）。

## 已验证事实 vs 待验证事项

已验证（详见 INTL_SG_EVIDENCE.md，等级 A/A+）：

- 四 edition 凭证解密、region 字段、host 分布
- `coresg-normal.trae.ai` 的 `get_detail_param` / `remote v1 models` 只读 200（且与
  `api16-normal-alisg.mchost.guru` 同内容，两 host 等价）
- CN 请求头被 SG 网关接受；`x-app-id` 相同
- CN 解析器直通 ai 响应（含 wireConfigName 命中）
- 四 edition refresh 契约（日志级：桌面版 userJwt、SOLO 国际版官方调用）
- `ide_user_pay_status` 订阅状态 200

待验证（实现阶段处理）：

| 项 | 计划 |
|---|---|
| `llm_utils_chat` 在 ai 的端到端可用性 | 落地时用 ai 账号发一次最小 `solo_work_lite` 受控请求（消耗少量额度，与 CN 版上线时同型） |
| `solo-sg` refresh 的 DeviceInfo 必填性 | token 2026-09-28 过期后自然触发；先按官方形态带上 |
| 国际 CLI（`~/.trae`）的默认 host | 第一阶段国际 CLI 禁用，取证后放开 |
| `custom_model_*` BYOK 条目甄别 | merge 时 display 名非空才收，或交用户勾选 |
| SG remote 目录 ctx 与 `get_detail_param` 数值差异（272k vs 240k） | 回归测试锁定「wire 值优先」行为 |

## 实施阶段

**阶段 1：region 基础设施 + 凭证层放开**（无行为变化，纯枚举）
`region.ts`、`candidates()`/`readAll()` 放开、`identity.ts` 国际 product.json、`refresh.ts` 契约表。
验收：`auth.spec.ts`/`region.spec.ts`/`refresh.spec.ts` 全绿；CN 用户无感知。

**阶段 2：配置分桶 + 目录双轨**
`Config.regions` + `regionStateOf` 迁移 + `fallbackModelsFor` 双份 + `currentRegion` 收敛。
验收：`catalog.spec.ts`/`settings-integration.spec.ts` 全绿；旧配置读取等价于 regions.cn。

**阶段 3：上游路由 + usage**
网关常量表接入 solo / solo-remote / raw / usage；`buildTraeHeaders` 放开。
验收：`solo*.spec.ts`/`usage.spec.ts` 的按 region URL 断言全绿。

**阶段 4：卡片与 web-status 区域化**
`status-paths`/`web-status`/`TraeUsageCard` 的 region 读写与订阅制区块。
验收：`web-status.spec.ts` 全绿；手工验证 CN↔ai 切换不丢勾选。

**阶段 5：端到端受控验证 + 发布**
ai 账号最小 chat 探测 → README/CHANGELOG → 版本发布（对齐 RELEASING.md 流程）。
