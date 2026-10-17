# PR: 新增 CN 企业版（租户）provider

> 分支：`feat/enterprise-provider`（基于 `main` = v3.7.0）
> 提交：13 个（首个为 provider 拆分，其余为面板、租户作用域与运行时映射修复）
> 自测：`pnpm run check` 全绿（708 项，此前 670）

---

## 1. 为什么需要这个改动

一个 CN 凭据如果属于 `tob_online` 租户，会被**两个**聊天网关同时服务：

| 网关 | 计费对象 |
|---|---|
| `https://trae-api-cn.mchost.guru` | 个人积分（`consumed_amount`） |
| `https://console.enterprise.trae.cn` | 企业租户额度 |

两者**名录不同**、**协议略不同**，而且「谁付费」是用户必须明确做出决定的商业选择。
当前插件只有一个 `trae` provider，只能走第一个网关，企业账号的企业额度完全用不上。

## 2. 改动内容

### 2.0 界面：企业版是并列的第三个面板

卡片原来按 **区域** 分栏（国内版 / 国际版），企业版虽然已是独立 provider，界面上却
没有自己的开关、账号和模型列表 —— 关掉企业版会把国内版一起关掉，两个池也只能共用
一份模型选择。现在引入 **panel**（面板）概念：

| 面板 | provider | 凭据区域 | 默认开关 | 说明 |
|---|---|---|---|---|
| `cn` | `trae` | cn | **开** | 个人 SOLO 池，行为不变 |
| `enterprise` | `trae-enterprise` | cn | **关** | 企业租户池，独立开关/账号/模型 |
| `ai` | `trae-global` | ai | **开** | 国际版，行为不变 |

- `TRAE_PANELS` / `regionOfPanel` / `providerOfPanel` 定义映射；每个面板只是
  `regions` 设置映射里多一个槽位，**没有新增存储形状**。`accounts` 增加
  `enterprise` 键，使企业版能绑定自己的账号。
- Host 侧凡是按区域做键的地方（stacks、wire 映射、目录、注册、发现）全部改为按面板，
  两个 CN 池因此各自保留名录（它们确实不同：`DeepSeek-V4.1-Flash` 仅企业池有）。
- **企业版默认关闭，两侧（`regionEnabled` 与卡片的 `regionEnabledOf`）保持一致**：
  纯个人账号用不了这个池，默认放开等于给所有用户塞一条一用就失败的 provider。
  用户在它自己的标签页里打开。
- 状态路由接受 `?region=enterprise`（参数名保持不变以兼容既有链接），卡片按
  国内版 → 企业版 → 国际版 的顺序渲染三个标签。


### 2.1 两个并列 provider（不是模式开关）

```ts
export const TRAE_PROVIDER_IDS: Readonly<Record<TraeRegion, readonly string[]>> = {
  cn: [TRAE_PROVIDER, TRAE_ENTERPRISE_PROVIDER],   // 'trae' | 'trae-enterprise'
  ai: [TRAE_AI_PROVIDER],                          // 'trae-global'
}

export const TRAE_PROVIDER_ROUTES: Readonly<Record<string, TraeProviderRoute>> = {
  'trae': 'solo',
  'trae-enterprise': 'enterprise',
  'trae-global': 'solo',
}
```

- 显示名：`trae` → `Trae`，`trae-enterprise` → **`Trae 企业版`**。
- **路由在构建客户端时固定**（`route` 构造参数），不存在「按调用猜一次计费池」。
- `trae-enterprise` **不回落**到消费池：被拒就是错误，不会偷偷花掉个人积分。

### 2.2 shim 按 bearer 分派

`createTraeShim` 从「单 client」扩展为「多路由，每路由一个 secret」：

```ts
createTraeShim({ catalog, routes: [
  { label: 'solo',       client: delegatingSolo },
  { label: 'enterprise', client: delegatingEnterprise },
]})
```

- 每个 provider 的 adapter 用自己的 `secret` 调 shim（`createTraeAdapter({ secret })`）。
- **未知 bearer → 401**，绝不退回第一条路由。计费池不能靠「默认值」决定。
- 旧的单 client 形式（`client:`）保持可用，退化为一条 `solo` 路由 —— 既有调用点与测试零改动。

### 2.3 企业网关的两个线缆差异

**(a) 每次调用要带 `session_id`** —— 消费网关反而会拒绝带它的请求体，所以只在该路由上加：

```ts
if (this.options.route === 'enterprise') {
  parsed['session_id'] = randomUUID()   // 每次调用一个
}
```

**(b) 拒绝形态是 HTTP 200 + 首帧 `event:error`**（`code 4001`），不是 HTTP 错误码。
若不识别，拒绝会表现成「这一轮助手什么都没说」：

```ts
if (event === 'error') return { ok: false, status: 200, kind: 'client', message: data }
// 正常流：用 peek 到的字节重建 Response，逐字节透传给调用方
```

> 实现细节：重建 `Response` 而不是就地改写 `response.body` —— 原对象 body 已被部分读取，
> 它的 `text()` 会一直抛 `Body has already been read`。这个坑被测试 `passes a normal
> stream through byte-for-byte` 抓住过。

### 2.4 顺带修好大小写敏感的 `config_name`（这是 4001 的真正根因）

`deepseek-v4.1-flash` 这类模型一直报：

```
400: {"code":4001,"message":"We're sorry, the param is invalid. Please try with a valid param."}
```

三处一起修，缺一不可：

1. **`modelConfig` 补 `wireConfigName`**（`src/index.ts`）。
   DSH 设置通道用这个 schema 重建文档，**未声明的字段每次保存都会被丢掉**。
   丢了映射，该模型就要等下一次发现才恢复可用。仓库里已有 `wireFunction` 因同样理由
   被声明的先例注释，`wireConfigName` 是被漏掉的那一半。

2. **`fetchModels` 从客户端所钉的网关读名录**（`src/solo.ts`）。
   ```diff
   - const base = this.options.baseUrl ?? REGION_GATEWAYS[region].chat
   + const base = this.options.baseUrl ?? this.chatBaseOf(credential)
   ```
   这是本次最关键的一处：两个池名录不同（`DeepSeek-V4.1-Flash` **只有企业池列**），
   钉在企业池的客户端却去读消费池名录 → 永远发现不了自己池的独占模型 →
   `mergeTraeModelSources` 拿不到 wire 行 → 不生成 `wireConfigName` / `wireFunction`。
   实测企业路由修好后：wire 名录 49 行，含 `DeepSeek-V4.1-Flash`（`solo_work_remote`）。

3. **`TraeSoloBridge` 查表大小写不敏感 + 退回目录行 id**（`src/solo-bridge.ts`）。
   网关区分大小写，Remote 目录 id 与线缆 `config_name` 可能只差大小写。

> **一处刻意没做的事**：没有用目录行的 `name` 去改写线缆名。看起来 `DeepSeek-V4.1-Flash`
> 的 name 正是网关要的拼写，但实测 5 个模型里有 **4 个**（`glm-5.3`、`kimi-k3`、
> `mimo-v2.6-pro`、`step-5-preview`）**只认小写 id、改大写就 4001**，而影响的目录行有 20 行。
> 所以只保留「退回目录行自身 id」这条安全兜底，并在注释里写明了原因。

## 3. 测试

`tests/card-enterprise-panel.spec.tsx`（9 项）：第三个标签、默认关闭、开关只写自己
的槽位（兄弟槽位逐字节不变）、两个池的模型选择互不串味。

`tests/enterprise-provider.spec.ts`（17 项）：

| 组 | 覆盖 |
|---|---|
| provider id | cn 并列发布两个 id、ai 不变、id→路由映射、显示名、region 归属 |
| 路由线缆 | 企业路由打企业网关 + 每次独立 `session_id`；消费路由不带 `session_id`；**名录按路由读取** |
| 拒绝处理 | 200+`event:error` → 真错误；正常流逐字节透传；消费池的 200 不被误判 |
| 大小写映射 | 小写请求 → 目录规范 id；有 `wireConfigName` 时优先；已正确的不改写 |
| schema | `wireConfigName` 经设置往返后仍在 |
| shim 分派 | 两条路由 secret 不同、按 bearer 分派、未知 bearer 401、单 client 旧形式仍可用 |

`tests/settings-integration.spec.ts` 3 处断言从「cn 只发 1 个 provider」更新为 2 个。

后续修复各自带测试：

| 文件 | 覆盖 |
|---|---|
| `tests/auth.spec.ts` | 租户声明读取；**tenant store 只列企业账号**、consumer store 只列个人账号；只有企业号时仍能解析（不谎报未登录）；显式绑定到个人号则回落到企业号 |
| `tests/web-status.spec.ts` | 企业面板只列租户口（**signed-out 分支也覆盖** —— 只过滤 signed-in 正是上次漏掉的地方）；企业面板不读消费快照、显式报 `creditsUnavailable` |
| `tests/catalog.spec.ts` | `traeModelDisplayName(withRate=false)` 去掉费率，`true` 保留 |
| `tests/solo-bridge.spec.ts` | `4222` 在**上游 message 为空**时仍有可读原因，且不与 `4008` 混淆 |

合计 **708 项**（此前 670）。

## 4. 实机验证（真实 `tob_online` 帐号）

走完整生产链路：企业路由发现 → 目录 → bridge → 企业网关。

```
merged row: { id: "deepseek-v4.1-flash", name: "DeepSeek-V4.1-Flash",
              wireConfigName: "DeepSeek-V4.1-Flash", wireFunction: "solo_work_remote" }

小写 id（用户实际请求）: ok=true host=console.enterprise.trae.cn
                        wire=DeepSeek-V4.1-Flash fn=solo_work_remote session=true PONG=true Δ个人积分=0.00
PascalCase:              ok=true host=console.enterprise.trae.cn
                        wire=DeepSeek-V4.1-Flash fn=solo_work_remote session=true PONG=true Δ个人积分=0.00
```

## 5. 兼容性

- `trae` / `trae-global` 行为**完全不变**（同一网关、无 `session_id`、同样的名录来源语义）。
- 旧配置无需迁移：`regions.cn.enabled` 一个开关同时管该区的两个 provider。
- `Config` 只**新增**可选字段（`wireConfigName`），旧文档读为 `undefined` 并走兜底。
- 单 client 的 `createTraeShim` 形式保留，`TraeShim` 只新增 `tokenOf()`。

## 6. 审阅建议路径

1. `src/region.ts` — `TraePanel` 与面板/区域/provider 的三方映射（先看这个，
   其余都是它的下游：卡片标签、设置槽位、注册与发现全部由它派生）
2. `src/adapter.ts` — provider 常量与路由表
3. `src/index.ts` — 每面板一个 stack / adapter / registration，企业版默认关闭
4. `src/solo.ts` — `route` 选项、`session_id`、200/`event:error`、`fetchModels` 用 `chatBaseOf`
5. `src/shim.ts` — 多路由与 bearer 分派
6. `src/solo-bridge.ts` — 大小写查表与兜底
