# DMR — DeepSeek Model Route

分阶段模型路由，给 DeepSeek Harness 用。规划、实现、审查三个角色可以各有各的模型路由；每轮的**实际**模型和**实际**花费都从会话日志算出来，不按配置推断。

> 前身是 Claude Code 插件 [claude-model-router](https://github.com/Aack000/claude-model-router)。思路保留，代码不搬：CMR 有一半代码在干 Claude Code 专属的活儿（改 `settings.json`、读写 CC Switch 的 sqlite、拼 `ANTHROPIC_DEFAULT_*_MODEL` 别名、解析 `~/.claude/projects` 的 transcript），这些在 DSH 里没有对应物，也不需要。

## 当前状态：v1

| 部件 | 作用 |
|---|---|
| `index.mjs` | host 插件：注册 `plan_subagent` / `impl_subagent` / `review_subagent`，**每次调用读一遍 `dmr.json`** 决定子代理的 provider/model/effort |
| `cordis.patch.yml` | 一行 host 平面插件行（**没有 preset**，见下） |
| `dmr.example.json` | 路由表示例，复制成 `$DSH_HOME/dmr.json` 后编辑 |
| `route-check.js` | 角色归属 + 模型核对 + 每轮花费（`--cost`） |
| `usage-audit.js` | token 汇总 + 美元计价 |
| `lib/session-log.js` | 多帧 zstd 结构解析（RFC 8878 帧头 + 块头，精确帧边界与截断判定） |
| `lib/pricing.js` | 价表（$/百万 token）与分时计价 |

## 为什么不用 preset

一个 preset 的插件列表是**会话创建时**组合一次的，而已开始的会话不能换 preset（`AgentPresetSeatController.select()` 对已开始的会话返回 `unchanged`）。把工具放进 preset，就意味着"装完还得开新会话选一下才能用"。

这三个工具是普通的派活工具，不是主会话的组成，所以放在 **host 平面**：装完即用，任何会话都能调。要改成 per-preset 的话，把 `cordis.patch.yml` 里那一行搬进目标 preset 的 `plugins` 即可，不需要改代码。

## 为什么模型不写在插件里

`dmr.json` 在**每次派活时**读一次，所以改表就改路由，下一句话生效，不用重装 bundle。这是相对 CMR 的关键退化修复：CMR 换供应商是改 `settings.json`，而静态 preset 的 `agentOptions` 只能改 YAML + 重装。

```json
{
  "roles": {
    "plan":   { "provider": "deepseek-account", "model": "deepseek-v4-pro", "effort": "max" },
    "impl":   { "provider": "deepseek-account", "model": "deepseek-flash",  "effort": "high" },
    "review": { "provider": "deepseek-account", "model": "deepseek-v4-pro", "effort": "max" }
  }
}
```

- 文件不存在、或某个角色没有条目 → 该子代理**继承父会话的路由**（不会报错，等同于普通 `subagent`）
- 文件存在但**不是合法 JSON** → 派活直接报错并指出文件路径（静默退回会让整轮跑错模型而没人知道）
- 插件代码里**没有任何模型名**

## 用法

```powershell
# 首次：把示例复制到 DSH_HOME
copy dmr.example.json $env:USERPROFILE\.dsh\dmr.json
```

然后在任意会话里用三个工具派活；核对用：

```powershell
node route-check.js                      # 自动找最近派过角色工具的父会话
node route-check.js --parent <id8> --cost
node usage-audit.js --cost --since 2026-11-04
```

`route-check` 退出码：全部符合 → 0，有 ✗ → 1。`usage-audit`：正常 0 / 目录不存在 1 / 参数错误 2。

一次实测（同一会话、standard preset、未建 preset）：

```
角色  工具             子会话    模型             effort  req  in     out  判定  $
规划  plan_subagent    95de324b  deepseek-v4-pro  max     1    11638  388  ✓     $0.0084
实现  impl_subagent    d1fc7b84  deepseek-flash   high    1    8745   2    ✓     $0.0013
审查  review_subagent  cb825c54  deepseek-v4-pro  max     1    11944  149  ✓     $0.0084
```

模型列取自各子会话日志里**第一条** `request/header`，不是配置推断。

## 路线图

### v2：设置页

Plugins 页里一个 JSON 编辑器 + 模型下拉。模型不许手填：用 `ctx.llm.listProviders()` + `llm.listModels(provider)` 读真实目录。结构照 `dsh-balance-mini` 的双面插件（host + `lib/client.js`）。

### v3：子代理生命周期

DSH 的子代理是 durable / continuable：跑完不关闭，条目写进父会话日志，一直可续。模型侧只有 `interrupt_agent`，**没有「关闭」**——这是设计（续跑能力就靠它）。parked 子代理不占 `maxActiveSubagents` 名额，所以不挡新派活。

因此 DMR 不做「关闭按钮」（删不掉目录条目，做出来是假功能），而是让产生量有纪律：

1. 角色固定三个，不按任务数派；
2. `dmr.json` 给每个角色加 `lifecycle: "one-shot" | "continuable"`：one-shot 交付即 `drainChildren`，continuable 才保留续跑；
3. 一轮收尾统一 `interrupt_agent` 兜底；
4. 看板按「本轮」聚合；
5. 把「本轮子代理数」当指标（`route-check` 已经在数）。

## 已知限制

- **法定节假日**：DeepSeek 官方节假日全天算非高峰，这里只按周一至周五 UTC 01–04 / 06–10 为高峰算，节假日会多估。
- **缓存 TTL**：DSH 日志不区分 5 分钟 / 1 小时写缓存，`lib/pricing.js` 里没有 1h 那档。
- **`subagent_fork` 不参与**：fork 子代理继承父会话路由以复用 KV cache，钉模型没有意义。
- **`route-check` 的自动选父会话**只认三个角色工具；只有通用 `subagent` 的会话要用 `--parent` 指定。
- **工具不是线程安全的**：`isConcurrencySafe` 返回 false，同一时刻只跑一个派活，避免两个包同时改同一批文件。
