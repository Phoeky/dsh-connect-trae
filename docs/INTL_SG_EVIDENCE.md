# Trae 国际版（SG）协议证据矩阵

> 本文只记录脱敏结构、字段名、host、路径与行为。不得复制 token、用户消息正文、账号信息或完整请求 body。
>
> 取证时间：2026-09-15。取证主机：macOS（同时安装 Trae CN / TRAE SOLO CN / TRAE SOLO 国际版；Trae 国际桌面版 App 已卸载但数据目录与历史日志保留）。
>
> 探测脚本：`scripts/probe-intl.mjs`（端点连通与形态）、`scripts/probe-intl-parse.mjs`（CN 正式解析器直通验证）。两者均只做只读目录/状态查询：**不发 chat（不消耗积分）、不做 refresh（不轮换 token）、不打印 token**。

## 证据等级（沿用 PROTOCOL_EVIDENCE.md）

- **A：历史真实请求日志**——官方 App 本机实际发出并成功返回。
- **A+：本次受控只读探测**——用国际版有效凭证实测返回 HTTP 200（零状态变更）。
- **B：当前安装包可执行文件/bundle**——可证明客户端具备某字段或分支，但未必是当前请求必填。
- **D：本项目草案**——纯离线结构，不能证明上游接受。

## 1. Region 判定（凭证层，等级 A）

四个 edition 的 `storage.json` 的 `iCubeAuthInfo://icube.cloudide` 值**全部可用现有 `decryptTraeStorageValue` 解密**（含 SG 两版），解密后顶层结构一致：

`token, refreshToken, expiredAt, refreshExpiredAt, tokenReleaseAt, userId, host, userRegion, account`

| edition | host（解密所得） | userRegion |
|---|---|---|
| Trae CN | `https://api.trae.cn` | `{"region":"CN","_aiRegion":"CN"}` |
| Trae（国际桌面） | `https://api-sg-central.trae.ai` | `{"region":"SG","_aiRegion":"SG"}` |
| TRAE SOLO CN | `https://api.trae.cn` | `{"region":"CN","_aiRegion":"CN"}` |
| TRAE SOLO（国际） | `https://growsg-normal.trae.ai` | `{"region":"SG","_aiRegion":"SG"}` |

- `userRegion.region`（`"CN" | "SG"`）是权威判定字段；host 后缀（`.trae.ai` vs `.trae.cn`）与之一致，可作为兜底判定。
- SG 侧 host 不统一（`api-sg-central` / `growsg-normal`），且 `account` 含 `migrateToSG` 字段（CN 账号可迁移）。路由必须按凭证自带 host，不可硬编码单一 SG host。
- `account.username`、`email` 等字段可用于账号展示；**不要**把 `nonPlainTextMobile` 等敏感字段带出 Host。

## 2. SG 端点地图

### 2.1 聊天网关：`coresg-normal.trae.ai`（等级 A）

Trae 国际桌面版 2026-05 历史日志（7 个会话目录）中的真实成功请求：

| 端点 | 次数 | 对应 CN 等价物 |
|---|---|---|
| `https://coresg-normal.trae.ai/api/agent/v3/create_agent_task` | 289 | `trae-api-cn.mchost.guru/api/agent/v3/create_agent_task`（主聊天） |
| `https://coresg-normal.trae.ai/api/ide/v2/llm_raw_chat` | 69 | `TRAE_RAW_CHAT_V2_PATH` |
| `https://coresg-normal.trae.ai/api/cue_agent/v3/create_agent_task` | 40 | CUE agent（插件不用） |
| `https://coresg-normal.trae.ai/api/agent/v3/llm_utils_chat` | 3 | `TRAE_SOLO_CHAT_PATH`（SOLO 主路径） |
| `https://coresg-normal.trae.ai/api/agent/v3/resume_agent_task` | 3 | — |
| `https://coresg-normal.trae.ai/api/remote/v1/skills` 等 remote v1 | 多次 | `solo.trae.cn/api/remote/v1` |

TRAE SOLO 国际版今日（2026-09-15）日志同样使用 `coresg-normal.trae.ai/api/remote/v1/*`——**国际版两个 App 共用该网关**，它是 `trae-api-cn.mchost.guru` + `solo.trae.cn` 的 SG 合并等价物。

mchost 在 SG 侧也存在分片（`api5/api16/api22-normal-alisg.mchost.guru`，承载 `get_detail_param`、`check_content`、`code_completion` 等 IDE 辅助端点），由 `icube16-normal-sg.trae.ai/icube/api/v1/native/config/query` 等配置服务下发。插件实现**统一走 `coresg-normal.trae.ai`** 即可（2.3 已验证其同样承载 `get_detail_param`）。

### 2.2 Refresh 契约（等级 A；**按 App 分叉，不按 region 统一**）

## 2.2 Refresh 契约（等级 A；**按 App 分叉，不按 region 统一**）

> **2026-10-11 更新（当前客户端已换契约，见 §2.2.1）。** 下面的 §2.2 描述的是**旧契约**，它今天对 `cn` / `sg` / `solo` **仍然返回 200**，因此插件把它保留为**回退**；但当前客户端（Trae CN 3.4.2 / Trae 国际 3.6.2）已经改走 `/trae/api/v3/oauth/ExchangeToken` 并**强制要求 `DeviceProof`**。以 §2.2.1 为准。

TRAE SOLO 国际版 2026-09-15 日志记录了官方 App 自己的刷新调用（`RefreshToken` 值在日志中已被 App 脱敏为 `******`）：

- 端点：`https://growsg-normal.trae.ai/trae/api/v3/oauth/ExchangeToken`
- body：`{"ClientID":"en1oxy7wnw8j9n","ClientSecret":"","RefreshToken":"...","DeviceInfo":{"DeviceID":"...","MachineID":"...","PlatformCode":"SOLO_PC","DeviceType":"PC","DeviceName":"..."}}`
- 另有 `exchangeTokenByAuthCode` 变体（授权码换 token，登录流程用，插件不需要）。

**Trae 国际桌面版（2026-05-18 日志）走的是另一套**：

- `updateLocalCredential` 记录的 `userJwt`（即 ExchangeToken 请求体）为 `{"ClientID":"ono9krqynydwx5","RefreshToken":"..."}` —— **与 CN 相同的 ClientID**。
- 登录 URL（`www.trae.ai/authorization?...client_id=ono9krqynydwx5`）与 `revokeToken`（`grow-normal.trae.ai/cloudide/api/v3/trae/oauth/ClearRefreshToken`）佐证同一 OAuth client，路径前缀 `/cloudide/api/v3/trae/oauth/` 与 CN 相同。
- 其 `PlatformCode` 为 `"TRAE"`（SOLO 为 `"SOLO_PC"`）。

四个 edition 的**旧** refresh 契约汇总：

| edition | 路径前缀（挂在凭证 host 上） | ClientID | body 特点 | 证据 |
|---|---|---|---|---|
| cn（Trae CN 桌面） | `/cloudide/api/v3/trae/oauth/ExchangeToken` | `ono9krqynydwx5` | 现有插件生产实测 | A |
| sg（Trae 国际桌面） | `/cloudide/api/v3/trae/oauth/ExchangeToken` | `ono9krqynydwx5` | `userJwt` 直证；`PlatformCode:"TRAE"` | A |
| solo（TRAE SOLO CN） | `/cloudide/api/v3/trae/oauth/ExchangeToken` | `ono9krqynydwx5` | 现有插件生产实测（`CLIENT_ID_BY_EDITION`） | A |
| solo-sg（TRAE SOLO 国际） | `/trae/api/v3/oauth/ExchangeToken` | `en1oxy7wnw8j9n` | 官方 App 今日直证；`DeviceInfo` 带 `PlatformCode:"SOLO_PC"` | A |

注意：

- **ClientSecret**：SOLO 国际版官方发空字符串（CN 版插件发 `"-"` 也能通过）。
- **DeviceInfo**：SOLO 国际版官方带（是否必填未实测）；桌面版 revoke body 也带 `DeviceID/MachineID/PlatformCode`。实现按官方形态带上最稳。
- 日志中 `updateLocalCredential` 的 `userRegion` 为**小写** `"sg"`，而 storage.json 解密后 `userRegion.region` 为大写 `"SG"` —— 判定函数必须大小写不敏感。

### 2.2.1 当前契约（2026-10-11 实测，等级 A+；**实现以此为准**）

四个 edition 全部改为 **`/trae/api/v3/oauth/ExchangeToken`**，并**强制要求 `DeviceProof`**。证据有两条独立来源：

1. **官方客户端自己的请求日志**（Trae CN 3.4.2 的 `logs/<ts>/main.log`、Trae 国际 3.6.2 同）
   ——`[exchangeTokenByRefreshToken] request …` 与随后的 `[exchangeToken] response success`。
2. **本机受控实测**：用每个安装**自己的** `storage.json` 凭证 + 该安装的 device keypair 签名，四个 edition **全部 HTTP 200**。

| edition | ClientID | PlatformCode | 实测 |
|---|---|---|---|
| cn | `ono9krqynydwx5` | `IDE_PC` | 200 |
| sg | `ono9krqynydwx5` | `IDE_PC` | 200 |
| solo | `en1oxy7wnw8j9n` | `SOLO_PC` | 200 |
| solo-sg | `en1oxy7wnw8j9n` | `SOLO_PC` | 200 |

**ClientID 按「是否 SOLO 包」分叉，不按 region**——官方客户端的分支是 `packageType ∈ {SOLO_CN, SOLO_I18N, SOLO_CN_ENTERPRISE}` → SOLO ClientID，其余 → 桌面 ClientID。所以 **`solo`（SOLO CN）必须用 `en1oxy7wnw8j9n`**，这正是 §2.2 旧表「SOLO CN 用桌面 ClientID」在新契约下失效的地方（用桌面的 id 会得到 `10101 无效参数`）。

**`DeviceProof` 的签名细节（全部实测确认，缺一不可）**：

- 算法：**ECDSA P-256 / SHA-256**，输出 base64。
- 签名消息：`["POST", 路径, ClientID, RefreshToken, String(时间戳秒), nonce].join("\n")`
  —— 分隔符是**换行符**。官方 bundle 写作 `.join("\n")`（模板字面量跨行），**不是空格**；同样的字段用空格连接会被拒为 `20403`，与「密钥不对」的表现**完全一致**，极易误诊。
- 私钥来源：`storage.json` 的 `iCubeAuthInfo://icube-dc:<deviceId>`，值与凭证同样加密，用**同一个** `decryptTraeStorageValue` 即可解出
  `{"privateKeyPEM":"-----BEGIN PRIVATE KEY-----…","publicKeyPEM":"-----BEGIN PUBLIC KEY-----…"}`（已实测四版通吃）。
  ⇒ **证明设备的密钥就存在它守护的那份登录旁边**，无需 keychain。
- `nonce` = 16 字节随机 hex；`Timestamp` = 整秒。

**`DeviceInfo` 字段的必填性（实测梯度）**：

| 字段 | 必填 | 证据 |
|---|---|---|
| `DeviceID` | ✅ | 见下 `DeviceType`/`PlatformCode` 同组 |
| `PlatformCode` + `DeviceType` | ✅ | 二者**同时**存在才通过；去掉任一 → `20403` |
| `MachineID` | ❌ | 去掉仍 200 |
| `ClientVersion`(=`IDEVersion`) | ❌ | 去掉仍 200 |
| `DevicePublicKey` | ❌ | 去掉仍 200（签名已证明身份）——但实现仍带上，与官方同形 |

**错误码语义**（决定回退策略）：

| 码 | 文案 | 含义 |
|---|---|---|
| `20405` | Device proof required. | 新路径**完全没带** proof（`DeviceProof` 缺失或 `Signature` 为空） |
| `20403` | Token device not match. | 带了 proof 但**签名/公钥/绑定**对不上（含空格分隔、随机密钥、无绑定 token） |
| `10101` | 无效参数：{__Message.field}. | **ClientID 用错**（如 solo CN 用了桌面 id） |
| `20101` | refresh token is invalid. | refresh token 本身失效（需重新登录） |

成功响应除 `Token` / `TokenExpireAt` / `RefreshToken` 外还有 **`RefreshExpireAt`**、`BoundDeviceID`、`DeviceBindStatus:"BOUND"`、`UserJwt`。

**ClientID 分叉同样适用于旧契约（2026-10-11 实测）**。旧 `/cloudide` 路径**今天对四个 edition 全部返回 200**，但**必须用各自对应的 ClientID**——用错会得到 `10101 refresh token is not matched to the client`：

| edition | 旧 `/cloudide` + 桌面 id | 旧 `/cloudide` + SOLO id |
|---|---|---|
| cn | **200** | 400 |
| sg | **200** | 400 |
| solo | 400 | **200** |
| solo-sg | 400 | **200** |

说明这个分叉**属于 OAuth client，不属于 endpoint**：两条路径上是同一个 client 在换 token。3.1.0 之前的插件在旧路径上写死桌面 id，因此 **solo-sg 从来没有可用的刷新路径**——这也解释了为什么国际 SOLO 账号一旦过期就再也刷不回来。

**回退策略**：实现**先试新契约（带 `DeviceProof`）、失败再试旧契约**，**两条路径都用各自 edition 的 ClientID**。新契约需要 device keypair，**没有 keypair 时（CLI-only / 旧安装）直接走旧契约**，不发送注定被 `20405` 拒绝的请求。实测四个 edition 在**两条路径上都能刷新成功**，所以回退是真正的兜底而非摆设。

> 复现脚本：旧 `scripts/probe-intl*.mjs` 仍是 §2.2/§2.3 的；本次 §2.2.1 的结论由「读客户端 bundle 的 `NPe()`/`$v()`/`m(t)` 三个函数 + 读 App 自写日志 + 四 edition 实测」三方交叉得到，未新增脚本。

### 2.3 受控只读探测（等级 A+，2026-09-15 实测）

用 TRAE SOLO 国际版有效凭证（token 至 2026-09-28 有效）+ CN 版 `buildTraeCnHeaders` 同款头实测：

| 探测 | 结果 |
|---|---|
| `coresg-normal.trae.ai/api/ide/v1/get_detail_param`（POST，CN 版 discovery 同 body） | **200**，`config_info_list` 14 条，字段与 CN 同构（`config_name` / `display_config.display_name` / `model_detail_list[].prompt_max_tokens` / `max_tokens`） |
| `api16-normal-alisg.mchost.guru/api/ide/v1/get_detail_param`（对照） | **200**，与 coresg 同内容（120545B 同大小）——两 host 等价可用 |
| `coresg-normal.trae.ai/api/remote/v1/models?functions=solo_agent_remote,solo_work_remote`（GET） | **200**，`solo_agent_remote` 组 7 模型，条目键 `name/multimodal/display_name/is_new/icon/features/config_source/is_preset/max_mode/context_window_tokens` 与 CN remote 目录同构 |
| `growsg-normal.trae.ai/trae/api/v1/pay/ide_user_pay_status`（POST `{}`，官方 App 今日自调 7 次） | **200**，返回订阅制状态（见 §4） |

**关键结论：CN 版请求头形态（`Authorization: Cloud-IDE-JWT`、`x-plugin-channel: icube-ai`、`x-app-id: 6eefa01c-1036-4c7e-9ca5-d891f63bfcd8`、identity 头、数字化 version code、`request-traffic-type: prod`）被 SG 网关原样接受。** `x-app-id` 两侧相同（国际桌面版日志 14996 次出现同值）。

### 2.4 解析器直通验证（等级 A+）

把 SG 响应喂给本项目 lib 打包产物中的 CN 正式解析器：

- `parseTraeRemoteModel`：7/7 条目解析成功（id/name/contextWindow/multimodal/reasoningSupported 全部产出）。
- `get_detail_param` 的 `config_info_list`：14/14 通过 solo.ts 的读取形态。
- `mergeTraeModelSources`：直接合并成功 3 个模型，且命中 `wireConfigName` 机制——`gemini-3.1-pro` 的 wire id 是 `custom_model_gemini`（display id ≠ wire id 的 SG 实例）。

## 3. SG 模型目录（与 CN 完全不同——「2 套存储」的直接依据）

`solo_agent_remote` 组（remote 目录，2026-09-15 实测）：

| id | display | ctx | multimodal |
|---|---|---|---|
| gemini-3.1-pro | Gemini-3.1-Pro-Preview | 200000 | yes |
| gemini-3-flash-solo | Gemini-3-Flash-Preview | 200000 | yes |
| minimax-m3 | MiniMax-M3 | 200000 | yes |
| minimax-m2.7 | MiniMax-M2.7 | 200000 | no |
| kimi-k2.5 | Kimi-K2.5 | 200000 | no |
| gpt-5.4 | GPT-5.4 | 272000 | yes |
| gpt-5.2 | GPT-5.2 | 272000 | yes |

`get_detail_param`（`solo_work_lite`）另含 `custom_model_*` 系列 BYOK 模板条目（`custom_model_placeholder/_1M/_1M_text/_kimi/_gemini/_claude/_gpt-5/_no-fc/_deepseek_chat/_deepseek_reasoner/_deepseek_v4`，display 名多为空，需在目录合并中甄别）与 `gpt-5.5`。

注意事项：

- remote 目录的 ctx（如 gpt-5.4=272000）与 `get_detail_param` 的 `prompt_max_tokens`（gpt-5.4=240000）数值不同——沿用 CN 版「remote 为骨架 + wire 补充」的合并策略即可，但 SG 侧两源差异比 CN 大，合并后以 wire 值为准的现行行为需要回归测试。
- SG 条目 `features.reasoning.enable=true` 但 `reasoning_effort_config.options` 未映射出 light/high/extra_high 档位（解析为 `reasoningSupported: true` 无 levels）——推理档位形态与 CN 存在差异，实现时按「无档位则不传 reasoning_effort」处理。
- 国际版 remote 目录的 `features`（JSON 字符串）中未见 `consumption_rate`（SG 无积分倍率概念，订阅制）。

### 2.5 目录 function 的区域差异（2026-09-15 实测，等级 A+）

`get_detail_param` 的 `function` 决定返回哪个 agent 的 config 集合，国际网关按 region 分派：

| function | 国际网关返回 | 覆盖 remote 阵容 |
|---|---|---|
| `solo_work_lite`（CN 版所用） | 14 条（gpt-5.4/5.2/5.5 + custom_model_*×10） | 仅 3/7（缺 gemini-3-flash-solo、minimax-m3/m2.7、kimi-k2.5 的 wire 映射） |
| `solo_agent` | 39 条（含全部 remote 阵容 + paygo 变体 + search_agent 等内部模型） | 7/7 |
| `solo_agent_lite` | 31 条 | 部分 |
| `solo_work` | 0 条 | — |

因此插件的**目录查询**在 ai region 改用 `solo_agent`（remote 目录仍是合并骨架，agent 内部模型与 paygo 变体不会浮出）；**聊天** function 两侧统一 `solo_work_lite`（国际网关端到端实测 200）。

## 4. SG Pay/Usage（订阅制，数据源与 CN 不同）

CN 版 `web_user_ent_usage`（积分包明细）在 SG 日志中**未出现**；SG 实测可用的是：

`POST https://growsg-normal.trae.ai/trae/api/v1/pay/ide_user_pay_status`（body `{}`）

返回结构（脱敏键名）：`detail{can_gen_solo_code, can_get_express_status, fast_request_per, in_wait, next_get_express_time_ms, permission, toast_read}`, `enable_fission/enable_solo_builder/enable_solo_coder/enable_solo_lite/enable_solo_web`, `has_package`, `is_dollar_usage_billing`, `is_pay_freshman(_v2)`, `last_pro_entitlement_expire_time`, `pay_identity_priority_list(6)`, `solo_fission_{expire_time,max_usage,start_time}`, `trial_status{is_eligible_for_trial, is_in_trial, trial_end_time}` 等。

实现含义：SG 的 usage 卡片不能复用 CN 的 Work 积分聚合，应基于 `ide_user_pay_status` 展示订阅/试用状态（具体字段取舍在实现阶段定）。

## 5. 遗留未知（实现前需确认）

| 项 | 风险 | 建议取证方式 |
|---|---|---|
| ~~`llm_utils_chat`（SOLO 主聊天路径）在 SG 的端到端可用性~~ | **已验证（2026-09-15，等级 A+）**：用 SOLO 国际版有效凭证 + 本项目正式代码路径（`prepareSoloBody` + `buildTraeCnHeaders` + `REGION_GATEWAYS.ai.chat`）发最小 `solo_work_lite` 请求，`gpt-5.4` 经 `coresg-normal.trae.ai` 返回 HTTP 200 + 完整 SSE（`metadata → timing_cost → output("OK") → extra_info → usage → done`，`provider_model_name: gpt-5.4-2026-03-05`）。`SseDecoder`/`decodeTraeEvent` 原样可用。脚本：`scripts/probe-intl-chat.mjs` | — |
| ~~SG refresh 的 `DeviceInfo` 是否必填~~ | **已结清（2026-10-11，§2.2.1）**：新契约下 `DeviceID`/`PlatformCode`/`DeviceType` 必填，`MachineID`/`ClientVersion`/`DevicePublicKey` 可省；且真正的门槛不是 `DeviceInfo` 而是 **`DeviceProof` 签名** | — |
| Trae 国际桌面版（App 已卸载）的 SG 网关是否同 SOLO | 其 5 月日志与 SOLO 今日日志 host 一致（coresg-normal） | 无需额外取证，按同网关实现 |
| `custom_model_*` BYOK 条目是否应进目录 | display 名为空、可能只是模板 | 实现阶段在 merge 时按「display 名非空才收」或用户勾选控制 |
| SG 分区 host 的稳定性（coresg-normal 之外还有无分区） | 分区由配置服务下发，理论上可能变化 | 凭证 host（`growsg-normal` 等）与 `coresg-normal` 均为 `-normal` 池，实现时可把网关 host 做成可配置的常量表，出问题只需改常量 |

## 6. 与 CN 的契约差异汇总（实现改造清单的输入）

| 维度 | CN | SG |
|---|---|---|
| 凭证 host | `api.trae.cn`（统一） | `api-sg-central` / `growsg-normal.trae.ai`（按 App 分，非统一） |
| region 判定 | `userRegion.region === 'CN'` | `'SG'`（host 后缀 `.trae.ai` 兜底；日志中亦见小写 `'sg'`，判定需大小写不敏感） |
| 聊天网关 base | `https://trae-api-cn.mchost.guru` | `https://coresg-normal.trae.ai` |
| remote 目录 base | `https://solo.trae.cn/api/remote/v1` | `https://coresg-normal.trae.ai/api/remote/v1` |
| refresh 路径 | ~~`/cloudide/…`（CN/SG 旧）~~ | **两者现均为 `/trae/api/v3/oauth/ExchangeToken`**（旧 `/cloudide` 仍 200，降级为回退） |
| refresh ClientID | ~~桌面统一 `ono9krqynydwx5`~~ | **按「是否 SOLO 包」分叉**：桌面 `ono9krqynydwx5`；SOLO（CN + 国际）`en1oxy7wnw8j9n` |
| refresh body | 无 DeviceInfo | **`DeviceProof`（ECDSA P-256 签名，必填）** + `DeviceInfo`（`IDE_PC`/`SOLO_PC`）；`ClientSecret:""`、无 `UserID` |
| usage 端点 | `/trae/api/v2/pay/web_user_ent_usage`（积分包） | `/trae/api/v1/pay/ide_user_pay_status`（订阅状态） |
| 模型目录 | GLM/Kimi/DeepSeek 等 | Gemini/GPT/MiniMax/Kimi 等（互不重叠为主） |
| 积分倍率 | `consumption_rate` 存在 | 未见（订阅制） |
| `x-app-id` 等请求头 | `6eefa01c-1036-4c7e-9ca5-d891f63bfcd8` 等 | 相同（实测接受） |
| 解密器 | `decryptTraeStorageValue` | 相同（实测四版通吃） |

**分桶结论：region 只有两个（CN / ai-国际），是「2 套存储」的分桶键**——模型目录、勾选、预算、fallback、聊天网关、usage 数据源全部按 region 二分。edition（cn / sg / solo / solo-sg 共 4 个）只是**凭证来源标签**（决定扫描哪个安装目录、product.json 路径、refresh 契约分支），edition → region 映射为 `cn|solo → CN`、`sg|solo-sg → ai`。
