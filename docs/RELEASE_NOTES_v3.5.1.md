## v3.5.1（2026-10-16）

> **DeepSeek-V4 四个模型行不再必然报 4001。**

这是一次 **patch** 升级，只修一处缺陷，不改任何设置、不改任何交互。

---

### 修复

- **`DeepSeek-V4` 四行（`DeepSeek-V4-Flash` / `-Flash-Official` / `-Pro` / `-Pro-Official`）选中发送必报 4001**（[#38](https://github.com/dingminhua/dsh-connect-trae/issues/38)）

  **症状**：模型选择器里明明有这几行，选中发送却收到：

  ```
  Trae does not serve this model under the SOLO function the request used
  (config_name rejected) · Trae code 4001 · upstream: We're sorry, the param is invalid…
  ```

  **这不是「上游不提供该模型」** —— 报告人指出的关键在于：这些模型在上游名单里**本来可以调用**，
  是插件自己把请求里的调用名改写坏了。

  **根因**：CN 区的上游名单（`get_detail_param`）把同一族列了**三行**，且共享同一个展示名：

  | 展示名 | wire 里的三个 id |
  | --- | --- |
  | `DeepSeek-V4-Flash` | `DeepSeek-V4-Flash-Official` / `DeepSeek-V4-Flash` / `deepseek-v4-flash` |
  | `DeepSeek-V4-Pro` | `DeepSeek-V4-Pro-Official` / `DeepSeek-V4-Pro` / `deepseek-v4-pro` |

  尾行是元数据残缺的小写行，它的 `name` 恰好就是小写 id。而插件合并这份名单时用的是
  **无条件写入**（后到者覆盖先到者），于是尾行抢走了「展示名」这个键，桥接层据此把
  `config_name` 改写成 `deepseek-v4-flash`，上游拒收。

  **为什么 `-Official` 行也一起废**：桥接层在取不到映射时会退回按**展示名**查询，而
  `-Official` 行的展示名同样是 `DeepSeek-V4-Flash`，落点相同 —— **两行一起废**。

  **修法**：两张映射表都改为**先到先得**。展示名于是命中 id 完全相同的规范行，而该行的
  调用名本就是 `DeepSeek-V4-Flash`（与展示名一致），**不再发生任何改写**。

  **本机 CN 实测**（用插件真实的请求形状逐行探测）：

  | 发出的调用名 | 结果 |
  | --- | --- |
  | `glm-5.2`（基线，确认账号可用） | ✅ HTTP 200 + 完整正文 |
  | `DeepSeek-V4-Flash` | ✅ HTTP 200 + 完整正文 |
  | `deepseek-v4-flash` | ❌ 流内 4001 `the param is invalid` |
  | `DeepSeek-V4-Pro` | ✅ HTTP 200 + 完整正文 |
  | `deepseek-v4-pro` | ❌ 流内 4001 |
  | `DeepSeek-V4-Flash-Official` | ✅ HTTP 200 + 完整正文 |

  即：**号码牌本身是好的，是被插件改写坏的** —— 修复前四行发出小写、修复后发出大驼峰。

  > ⚠️ 这类失败的外层 HTTP 状态码仍是 **200**，`4001` 藏在 SSE 的 `event:error` 里。
  > 只看状态码会把它误判成成功 —— 这是排查时最容易踩的坑。

---

### 测试

- 新增 2 例回归：合并函数在「同名 + 尾行小写」的名单上必须让规范行取胜；以及
  「按展示名合并」在改为先到先得后仍然生效（防止过度修正）。两例在修复前均失败、修复后通过。
- 全仓 **619** 例测试通过，类型检查通过。

---

### 从旧版本升级

直接升级即可，**无需任何配置改动**。国内版与国际版都受影响，两个区域都建议升级。

**完整变更**：https://github.com/dingminhua/dsh-connect-trae/compare/v3.5.0...v3.5.1
