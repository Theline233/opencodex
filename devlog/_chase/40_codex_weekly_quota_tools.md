# Codex 七天周期额度：同类开源项目实现调研

- 调研日期：2026-08-18
- 范围：只看 OpenAI 官方 Codex 仓库，以及相关开源项目自己的 README、源码和接口实现。
- 问题：当账户当前只返回七天窗口时，能否从官网接口得到一个周期的固定总 Token；同类项目如何展示或估算额度。

## 结论

**没有找到任何项目能从 OpenAI 接口直接读取“七天周期总 Token”这一绝对值。**

OpenAI 官方 `account/rateLimits/read` 公开的窗口字段是 `usedPercent`、
`windowDurationMins` 和 `resetsAt`；官方文档只把它们定义为当前窗口使用百分比、窗口长度和
下次重置时间。另一个 `account/usage/read` 返回账户 Token 活动摘要和每日桶，但官方没有给出
“这些 Token 占七天额度多少”的换算系数，也没有 `quotaTokens` / `totalTokensLimit` 一类字段：
[OpenAI app-server rate-limit contract](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#7-rate-limits-chatgpt)，
[OpenAI app-server API overview](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#api-overview)。

因此同类项目分成三类：

1. **权威百分比展示**：直接显示已用/剩余百分比、窗口长度、重置时间；不声称知道总 Token。
2. **Token 活动统计**：统计过去七天实际 Token 或 API 等价值，但明确与 ChatGPT 订阅额度不同。
3. **经验外推**：把观察到的 Token 除以已用百分比，得到一个“100% 等效 Token”估计；这是估值，
   不是服务端公布的固定额度。

## 项目对照

| 项目 | 数据源与关键字段 | 实际展示/计算 | 是否得到真实七天总 Token |
|---|---|---|---|
| OpenAI Codex app-server | `account/rateLimits/read`: `usedPercent`, `windowDurationMins`, `resetsAt`; `account/usage/read`: Token 活动摘要与每日桶 | 百分比、窗口、重置；另有 Token 活动 | **否**，协议中没有绝对总量字段 |
| CodexBar | `GET /backend-api/wham/usage` 或 `codex app-server`；将 `primary_window` / `secondary_window` 转成窗口 | `usedPercent`、`remainingPercent = 100 - usedPercent`、重置倒计时；本地日志成本扫描是独立功能 | **否** |
| Danielw412/Codex-Dashboard | `account/rateLimits/read`、`account/usage/read` 和本地 rollout | 识别 10,080 分钟窗口；对百分比快照拟合消耗速度/到重置时百分比；把相邻百分比增量估算分配到线程 | **否**；项目明确说 Token 不能直接换算额度百分比 |
| CodexScope | 本地 rollout Token；`account/usage/read`；`account/rateLimits/read` | 日/周/月 Token 活动、API 等价值、独立的额度卡片 | **否**；项目明确区分 API 价值与 ChatGPT 订阅额度 |
| Codex Rate Widget | `account/rateLimits/read`；`account/usage/read`；本地 `state_5.sqlite` | 窗口剩余百分比；过去七天官方累计/每日 Token；用本地会话比例分摊七天 Token 到项目 | **否**；“七天 Token 总数”是活动总数，不是 100% 容量 |
| codex-cli-usage | 优先 `account/rateLimits/read`，兼容回退到 `/backend-api/codex/usage` | 保存/显示 `pct`、`resets_at`、`window_secs`；按窗口秒数识别 weekly | **否** |
| codex-usage-tracker | 本地 rollout Token、CLI `/status` 百分比 | 用上一个完整周期的 Token 与最大已用百分比外推 `quota_tokens` | **仅估算**，不是官网总量 |

## 逐项证据

### 1. OpenAI 官方接口

官方示例的一个 rate-limit window 只有：

```json
{
  "usedPercent": 25,
  "windowDurationMins": 10080,
  "resetsAt": 1730947200
}
```

官方字段说明没有绝对额度：[Codex app-server README：Rate limits](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#7-rate-limits-chatgpt)。
官方同时说明 `account/usage/read` 提供账户 Token 活动摘要和每日桶，但没有把这些 Token 绑定到
rate-limit 百分比的服务端换算关系：[Codex app-server README：API Overview](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#api-overview)。

“当前只返回七天窗口”也必须按时长识别，而不能假定 `primary` 永远是五小时：官方仓库已有一个
Pro 账户实例，`primary.windowDurationMins = 10080` 且 `secondary = null`：
[openai/codex issue #32707](https://github.com/openai/codex/issues/32707)。这是用户报告而非协议保证，
但它与当前观察到的 weekly-only 形态一致。

### 2. CodexBar：百分比展示与 Token 成本彼此独立

CodexBar 的 Codex 数据路径优先读取 OAuth `auth.json`，调用
`GET https://chatgpt.com/backend-api/wham/usage`，也可通过 `codex app-server` 的
`account/rateLimits/read` 获取窗口；文档明确把窗口映射到 session/weekly lane：
[CodexBar Codex provider docs](https://github.com/steipete/CodexBar/blob/main/docs/codex.md#oauth-api-preferred-for-the-app)，
[CodexBar CLI RPC docs](https://github.com/steipete/CodexBar/blob/main/docs/codex.md#codex-cli-rpc-automatic-cli-source)。

其核心 `RateWindow` 只保存 `usedPercent`、`windowMinutes`、`resetsAt`，剩余量就是
`max(0, 100 - usedPercent)`：
[CodexBar UsageFetcher.swift](https://github.com/steipete/CodexBar/blob/main/Sources/CodexBarCore/UsageFetcher.swift#L1-L67)。
CodexBar 的本地 Token/成本扫描读取 rollout JSONL，但文档把它作为独立的 local cost usage，
没有将其除以周百分比来宣称周期总容量：
[CodexBar local cost usage](https://github.com/steipete/CodexBar/blob/main/docs/codex.md#cost-usage-local-log-scan)。

### 3. Codex-Dashboard：做趋势预测，不计算固定总容量

Codex-Dashboard 使用官方 App Server 的 `account/rateLimits/read`、`account/usage/read`，并按
`windowDurationMins ≈ 10080` 识别七天窗口；缺少五小时窗口时不会虚构：
[Codex-Dashboard README：Quota windows](https://github.com/Danielw412/Codex-Dashboard/blob/main/README.md#quota-windows)。

它对本地百分比快照拟合线性趋势，计算每小时百分比、重置时预计百分比、预计到 100% 时间和
可信度。这是“用量速度预测”，不是“总 Token 容量计算”：
[Codex-Dashboard README：Projections](https://github.com/Danielw412/Codex-Dashboard/blob/main/README.md#projections)。

项目还明确写明：线程级额度占比是相邻百分比快照的估算分配；Token 总量不能直接转换成
ChatGPT quota 百分比，因为模型、缓存、推理、工具、图片和服务端记账都会影响额度：
[Codex-Dashboard README：Accuracy limits](https://github.com/Danielw412/Codex-Dashboard/blob/main/README.md#accuracy-limits)。

### 4. CodexScope：过去七天 Token 不是七天额度容量

CodexScope 从本地 rollout 统计 Token，从 `account/usage/read` 读取账户 usage summary，
从 `account/rateLimits/read` 读取窗口；三者在数据源表里是独立项：
[CodexScope README：Data Sources](https://github.com/poer2023/CodexScope#data-sources)。

它显示日/周/月 Token 和 API 等价值，但明确指出 API 价值只是公开 API 价格估算，
ChatGPT/Codex 订阅记账与额度可能不同：
[CodexScope README：Key Processing / Token Types](https://github.com/poer2023/CodexScope#key-processing)。
所以其中“Week Token”表示选定日历周内已经发生的 Token 活动，不表示从 0% 到 100% 的容量。

### 5. Codex Rate Widget：官方七天 Token 活动 + 本地比例归因

该项目把 `account/rateLimits/read` 用于“剩余容量”，把 `account/usage/read` 用于累计 Token 和
每日 Token；本地 `state_5.sqlite` 只用于计算各项目占比，再把官方七天活动 Token 分摊到项目：
[codex-rate-widget README：Data Sources](https://github.com/dueyama/codex-rate-widget#data-sources)。

README 明确说本地 `tokens_used` 是累积值，只用于比例，显示总数来自官方 aggregate；云端或其他
机器活动无法精确归因。这里的 official seven-day token total 仍是“过去七天发生了多少 Token”，
并非接口公布的“100% 七天额度是多少”。

### 6. codex-cli-usage：只缓存百分比、重置和窗口秒数

该工具优先通过 `codex app-server --stdio` 调用 `account/rateLimits/read`，兼容回退到
`/backend-api/codex/usage`；它根据 `limit_window_seconds` 分类窗口，而不是绑定
primary/secondary：
[codex-cli-usage README](https://github.com/wakamex/codex-cli-usage#how-codex-cli-rate-limiting-works)。

转换后的 weekly 数据只有 `pct`、`resets_at`、`window_secs`：
[codex-cli-usage source](https://github.com/wakamex/codex-cli-usage/blob/main/src/codex_cli_usage/__init__.py#L426-L479)。
因此它能准确展示 seven-day 百分比与重置时间，但不计算总 Token。

### 7. codex-usage-tracker：找到的唯一直接“总容量外推”实现

该项目确实生成 `quota_tokens`，算法位于 `_estimate_weekly_quota`：
[codex-usage-tracker cli.py](https://github.com/CasperKristiansson/codex-usage-tracker/blob/main/src/codex_usage_tracker/cli.py#L998-L1089)。

其步骤是：

1. 按一个本地配置的固定“每周重置星期 + 时间”取上一个完整周。
2. 汇总该周 rollout 的 `total_tokens`。
3. 从采集事件取周额度最大已用百分比：`used = 100 - percent_left`。
4. `scale = 100 / max_used_percent`。
5. `quota_tokens = round(observed_tokens * scale)`，成本估值也乘同一倍数。

等价公式：

```text
七天总容量估算 = 周期内观测到的 Token × 100 ÷ 周期最大已用百分比
```

这是值得借鉴的“外推骨架”，但不能直接照搬为权威值：

- 固定星期/时间可能与每个账户实际 `resetsAt` 不一致。
- 只统计本机 rollout，会漏掉网页、云任务、其他设备或未经过该采集器的请求。
- 把不同模型、推理强度、缓存和工具使用的原始 Token 直接相加，隐含“每 Token 等价”的错误假设。
- 官网百分比通常是量化后的读数；在 1% 或 2% 时外推，误差会被放大 50～100 倍。
- 如果周期没有接近 100%，结果只是按当前工作负载线性外推；下一周期换模型后会变。
- 源码在 `used_percent` 缺失或不大于零时令 `scale = 1`，此时 `quota_tokens` 实际只是观察量，
  不应在产品界面标为完整容量。

## 对 OpenCodex 的建议

如果要做用户当前所说的“七天周期总额度预估”，建议采用组合方案，而不是把任意一个 Token 数
标成官网额度：

1. 以 `windowDurationMins ≈ 10080` 和服务端 `resetsAt` 确认真实七天周期；支持 weekly-only
   `primary`，不要依赖 primary/secondary 位置。
2. 保存每个账户的连续 `(timestamp, usedPercent, resetsAt)` 快照，并关联 OpenCodex 实际转发请求的
   输入、缓存输入、输出、模型、推理强度。
3. 用多个“百分比增量区间”估计单位额度，而不是只用周期末一个点。出现百分比回退、`resetsAt`
   改变或账户切换时切断样本。
4. 原始 Token 仅作为一种视图；主指标应命名为“七天等效容量估算”，按模型/推理工作负载分别给出，
   不承诺不同模型之间可直接换算。
5. 低于 5%（更稳妥是 10%）不输出总量；同时显示覆盖率、样本跨度、是否包含外部设备和置信区间。
6. 若周期确实跑到接近 100%，把该周期实际观测量保存为“完整周期实测”，仍注明它只对该周期的
   模型组合和采集覆盖成立。

可先实现一个保守版本：**官网百分比/重置时间为权威，周期总量只作为有置信度标签的估算值。**
这与同类项目中最可靠的边界一致，也不会把“过去七天用了多少 Token”误写成“账户总共能用多少
Token”。
