# DMR — DeepSeek Model Route

分阶段模型路由，给 DeepSeek Harness 用。规划、实现、审查三个角色可以各有各的模型路由；每轮的**实际**模型和**实际**花费都从会话日志算出来，不按配置推断。

> 前身是 Claude Code 插件 [claude-model-router](https://github.com/Aack000/claude-model-router)。思路保留，代码不搬：CMR 有一半代码在干 Claude Code 专属的活儿（改 `settings.json`、读写 CC Switch 的 sqlite、拼 `ANTHROPIC_DEFAULT_*_MODEL` 别名、解析 `~/.claude/projects` 的 transcript），这些在 DSH 里没有对应物，也不需要。

## 当前状态：v1

| 部件 | 作用 |
|---|---|
| `index.mjs` | host 插件：注册 `plan_subagent` / `impl_subagent` / `review_subagent`，**每次调用读一遍 `dmr.json`** 决定子代理的 provider/model/effort |
| `cordis.patch.yml` | 一行 host 平面插件行（**没有 preset**，见下） |
| `dmr.example.json` | 路由表示例，复制成 `$DSH_HOME/dmr.json` 后编辑 |
| `route-check.js` | 角色归属 + 模型核对 + 每轮花费（`--cost`）。期望值取自**该次派活的声明路由**（工具把当时生效的路由写进返回文本），没有声明才回退到当前 `dmr.json`——改表不会误伤历史轮次，「声明 A 实际跑 B」照样抓得出 |
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
- **模型名写错** → 派活**在创建子代理之前**就拒绝，报出角色、写错的模型、该供应商实际可用的模型、以及文件路径。校验用的是供应商的实时目录（`llm.listModels`），不是 `resolveModelInfo`——后者对未列出的 id 会照常返回，直到请求发出去才失败。目录为空（比如还没配凭据）时跳过校验，不会误拒合法路由。
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

### v2：设置页（已完成）

Plugins 设置区里的 **DeepSeek Model Route** 页：

- host 侧两个接口（仅回环地址）：
  - `GET/PUT /plugins/dsh-deepseek-model-route/config` —— 返回文件路径与原文；PUT 校验后写回
  - `GET /plugins/dsh-deepseek-model-route/models` —— 从 `llm.listProviders()` / `llm.listModels()` / `resolveModelInfo()` **实时**读可用模型与 effort 档位，缓存 60 秒
- client 侧注册到 `settings.plugins.tab`：三个角色各一组 provider / model / effort 下拉，选完保存；也可以展开直接改 JSON
- 校验在写之前：角色名必须是 `plan`/`impl`/`review`，`provider`/`model` 非空字符串，`effort` 可选字符串；不合法返回 400 且**不落盘**

实测（2026-11-04）：

```
GET /models → deepseek-account: deepseek-flash, deepseek-v4-pro (efforts: off,low,high,max)
              deepseek-official: 0 个（未配 key —— 不凭空造模型）
PUT /config 合法 → 200；坏 JSON → 400；角色名 typo → 400；磁盘文件保持完好
```

> 首次安装后 client 半需要**重启 DSH**：client 模块表是启动时扫描 `dsh.client` 建的。host 侧（三个工具 + 两个接口）装完即生效。

还没做：locale 资源（页面文案目前是内联中文）。

### v3：子代理生命周期（已完成）

DSH 的子代理是 durable / continuable：跑完不关闭，条目写进父会话日志，一直可续。模型侧只有 `interrupt_agent`，**没有「关闭」**——这是设计（续跑能力就靠它）。parked 子代理不占 `maxActiveSubagents` 名额，所以不挡新派活。

DMR 不做「关闭按钮」（删不掉目录条目，做出来是假功能），而是给每个角色一个 `lifecycle`：

| 值 | 含义 |
|---|---|
| `continuable`（默认） | 保持原生行为，`send_message` 可以续跑同一个子代理 |
| `one-shot` | 交付后立刻 `activation.dispose()` 释放；`send_message` 仍可工作，但走**冷恢复** |

```json
{ "roles": { "impl": { "provider": "…", "model": "…", "lifecycle": "one-shot" } } }
```

建议：实现包用 `one-shot`（它本来就带 handoff，中断就新起一个）；规划、审查用 `continuable`（`/route` 会 `send_message` 回同一个 planner 改规划、回同一个 reviewer 复审）。

**释放是可观测的**：`GET /plugins/dsh-deepseek-model-route/stats` 返回最近释放的子代理（child / role / 时间）。实测把 `review` 设成 `one-shot` 后派一次，14 秒内就出现在 stats 里。

### v3 之后

- locale 资源（页面文案目前内联中文）
- 把「本轮子代理数」显示在页面上（`route-check` 已经在数）
- 可选：按角色配 `agentPreset`，让审查子代理拿到只读的工具集

## 已知限制

- **法定节假日**：DeepSeek 官方节假日全天算非高峰，这里只按周一至周五 UTC 01–04 / 06–10 为高峰算，节假日会多估。
- **缓存 TTL**：DSH 日志不区分 5 分钟 / 1 小时写缓存，`lib/pricing.js` 里没有 1h 那档。
- **`subagent_fork` 不参与**：fork 子代理继承父会话路由以复用 KV cache，钉模型没有意义。
- **`route-check` 的自动选父会话**只认三个角色工具；只有通用 `subagent` 的会话要用 `--parent` 指定。
- **工具不是线程安全的**：`isConcurrencySafe` 返回 false，同一时刻只跑一个派活，避免两个包同时改同一批文件。
