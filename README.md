# DMR — DeepSeek Model Route

分阶段模型路由，给 DeepSeek Harness 用。规划/审查跑强模型，实现跑便宜模型；每轮的**实际**模型和**实际**花费都从会话日志算出来，不按配置推断。

> 前身是 Claude Code 插件 [claude-model-router](../claude-model-router/)（CMR）。那份实现的思路保留，但**不能原样搬**：CMR 有一半代码在干 Claude Code 专属的活儿（改 `settings.json`、读写 CC Switch 的 sqlite、拼 `ANTHROPIC_DEFAULT_*_MODEL` 别名、解析 `~/.claude/projects` 的 transcript），这些在 DSH 里没有对应物，也不需要。

## 当前阶段性目标

**把功能跑通，不绑定具体模型。** 三个角色工具能挂上、每条路由可配置、跑完能核对实际模型、每轮能算钱——这四件事成立，选哪个模型、哪家供应商是使用者自己配的事。

具体模型只出现在 `cordis.patch.yml` 的配置值和下面的实测输出里，**不是本项目的默认主张**。

## 当前状态：v0 骨架

| 部件 | 状态 |
|---|---|
| `cordis.patch.yml` | preset `dmr`：standard 组合 + 三个钉死模型的派活工具（`plan_subagent` / `impl_subagent` / `review_subagent`） |
| `route-check.js` | 角色归属 + 模型核对 + 每轮花费（`--cost`），907 行 |
| `usage-audit.js` | token 汇总 + `--cost` 美元计价，559 行 |
| `lib/session-log.js` | 多帧 zstd 结构解析（按 RFC 8878 走帧头/块头，精确帧边界与截断判定） |
| `lib/pricing.js` | 价表（$/百万 token）与分时计价 |

`route-check.js` / `usage-audit.js` 是从 CMR 的 `dsh/` 目录**原样搬来且已验证**的：不带 `--cost` 时输出与搬之前逐字节相同，同一子会话的美元与 `usage-audit` 逐个相等。

## 用法

```powershell
node route-check.js                      # 自动找最近派过角色工具的父会话
node route-check.js --parent <id8> --cost
node usage-audit.js --cost --since 2026-11-04
```

`route-check` 退出码：全部符合 → 0，有 ✗ → 1。`usage-audit`：正常 0 / 目录不存在 1 / 参数错误 2。

下面是一次实测输出。**模型列取自当时 preset 的配置值**，不是本项目的默认主张：

```
角色  工具             子会话    模型             effort  req  in     out  判定  $
规划  plan_subagent    d35e7d71  deepseek-v4-pro  max     1    10410  123  ✓     $0.0071
实现  impl_subagent    275e9af4  deepseek-flash   high    1    1245   399  ✓     $0.0005
审查  review_subagent  696c31d2  deepseek-v4-pro  max     1    10530  162  ✓     $0.0075
主会话 $0.0024 · 规划 $0.0071 · 实现 $0.0005 · 审查 $0.0075 · 合计 $0.0175
```

## 路线图

### v1：映射可改而不重装（核心）

现在模型钉在 `cordis.patch.yml` 的 `agentOptions` 里，改一次要改 YAML + 重装 bundle。CMR 那边换供应商只是改 `settings.json`，所以这一点上 DSH 版反而退化了。

做法：**不自己实现派活工具**（`dsh-tool-subagent` 已经处理了深度、路由预检、完成通知、续跑、preset 选择），而是写一个宿主插件：读 `dmr.json`，按表里每个角色 `ctx.plugin(toolSubagent, {...})` 挂一个实例；文件变更就 dispose 旧实例、按新配置重挂。

```json
{
  "roles": {
    "plan":   { "tool": "plan_subagent",   "provider": "deepseek-account", "model": "deepseek-v4-pro", "effort": "max" },
    "impl":   { "tool": "impl_subagent",   "provider": "deepseek-account", "model": "deepseek-flash",  "effort": "high" },
    "review": { "tool": "review_subagent", "provider": "deepseek-account", "model": "deepseek-v4-pro", "effort": "max" }
  }
}
```

模型不许手填：用 `ctx.llm.listProviders()` + `llm.listModels(provider)` 读真实目录，页面里是下拉选。CMR 踩过「别名漏映射 → 静默跑错」，这里从根上消掉。

### v2：设置页（照 `dsh-balance-mini` / 大肥鱼的双面插件结构）

Plugins 页里一个 JSON 编辑器 + 模型下拉。改完即时生效（靠 v1 的 remount）。

### v3：子代理生命周期

DSH 的子代理是 **durable / continuable**：跑完不关闭，条目作为 `subagent/catalog` 写进父会话日志，一直可续、可打开。模型侧只有 `interrupt_agent`，**没有「关闭」**——这是设计，不是缺陷（续跑能力就靠它）。能做的只有：

| 手段 | 对还在跑的 | 对已结束的（parked） |
|---|---|---|
| `interrupt_agent` | 停 | 无效 |
| `drainChildren`（service 层） | 释放激活 | 只是释放，条目还在 |
| 归档父会话 | 级联取消活的 | 无效 |

parked 子代理不占 `maxActiveSubagents` 名额（实测 9 个里 8 个 parked 仍能派），所以它不挡新派活，难受的是目录和账。

因此 DMR 不做「关闭按钮」（删不掉目录条目，做出来是假功能），而是**让产生量有纪律**：

1. 角色固定三个，不按任务数派；
2. `dmr.json` 里给每个角色加 `lifecycle: "one-shot" | "continuable"`：one-shot 交付即 `drainChildren`，continuable（planner 修订、reviewer 复审）才保留续跑；
3. 一轮收尾统一 `interrupt_agent` 兜底；
4. 看板按「本轮」聚合，历史折叠；
5. 把「本轮子代理数」当指标（`route-check` 已经在数）。

## 已知限制

- **法定节假日**：DeepSeek 官方节假日全天算非高峰，这里只按周一至周五 UTC 01–04 / 06–10 为高峰算，节假日会多估。
- **缓存 TTL**：DSH 日志不区分 5 分钟 / 1 小时写缓存，`lib/pricing.js` 里没有 1h 那档。
- **`subagent_fork` 不能钉模型**：设计上继承父会话以复用 KV cache，所以 preset 里没有它。
- **`route-check` 的自动选父会话**只认三个角色工具；只有通用 `subagent` 的会话要用 `--parent` 指定。
