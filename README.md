# DMR — DeepSeek Model Route

分阶段模型路由，给 DeepSeek Harness 用。规划、实现、审查三个角色可以各有各的模型路由；每轮的**实际**模型和**实际**花费都从会话日志算出来，不按配置推断。

> 前身是 Claude Code 插件 [claude-model-router](https://github.com/Aack000/claude-model-router)。思路保留，代码不搬：CMR 有一半代码在干 Claude Code 专属的活儿（改 `settings.json`、读写 CC Switch 的 sqlite、拼 `ANTHROPIC_DEFAULT_*_MODEL` 别名、解析 `~/.claude/projects` 的 transcript），这些在 DSH 里没有对应物，也不需要。

## 当前状态

| 部件 | 作用 |
|---|---|
| `index.mjs` | host 插件：注册 `plan_subagent` / `impl_subagent` / `review_subagent`，**每次调用读一遍 `dmr.json`** 决定子代理的 provider/model/effort；另提供插件详情页用的四个接口 |
| `client.js` | client 插件：注册到 `plugins.detail.section`，在**插件自己的详情页**里画路由表和「最近委派」；文案跟随 DSH 的界面语言（zh / en） |
| `locale/` | 插件列表里的标题与说明（`meta`），以及插件详情页正文的指向（`meta.detail` → `docs/page.md` / `docs/page.zh.md`）；包内面板的文案在 `client.js` 的字典里 |
| `docs/page*.md` | 插件详情页的正文，中英各一份，**留空**：一句介绍在标题下面（`meta.description`），其余说明在面板最底下，别把设置挤下去 |
| `cordis.patch.yml` | 一行 host 平面插件行（**没有 preset**，见下） |
| `dmr.example.json` | 路由表示例，复制成 `$DSH_HOME/dmr.json` 后编辑 |
| `route-check.js` | 角色归属 + 模型核对 + 每轮花费（`--cost`）。期望值取自**该次派活的声明路由**（工具把当时生效的路由写进返回文本），没有声明才回退到当前 `dmr.json`——改表不会误伤历史轮次，「声明 A 实际跑 B」照样抓得出 |
| `doctor.js` | 一次回答「现在哪一环坏了」：安装链（包目录 / 两个入口 / 插件行 / 依赖 / bundle / node_modules 链接 / 是否被禁用）、`dmr.json` 与实时目录、会话日志、四个接口、以及运行中的进程是否比磁盘上的代码旧 |
| `usage-audit.js` | token 汇总 + 美元计价 |
| `lib/session-log.js` | 多帧 zstd 结构解析（RFC 8878 帧头 + 块头，精确帧边界与截断判定） |
| `lib/pricing.js` | 价表（$/百万 token）与分时计价 |
| `lib/cost.js` | 单个会话的计价累计器 + 按会话 id 找日志；`route-check --cost` 和详情页共用这一份 |

## 为什么不用 preset

一个 preset 的插件列表是**会话创建时**组合一次的，而已开始的会话不能换 preset（`AgentPresetSeatController.select()` 对已开始的会话返回 `unchanged`）。把工具放进 preset，就意味着"装完还得开新会话选一下才能用"。

这三个工具是普通的派活工具，不是主会话的组成，所以放在 **host 平面**：装完即用，任何会话都能调。要改成 per-preset 的话，把 `cordis.patch.yml` 里那一行搬进目标 preset 的 `plugins` 即可，不需要改代码。

## 为什么模型不写在插件里

`dmr.json` 在**每次派活时**读一次，所以改表就改路由，下一句话生效，不用重装 bundle。这是相对 CMR 的关键退化修复：CMR 换供应商是改 `settings.json`，而静态 preset 的 `agentOptions` 只能改 YAML + 重装。

```json
{
  "roles": {
    "plan":   { "provider": "deepseek-account", "model": "deepseek-flash", "effort": "max" },
    "impl":   { "provider": "deepseek-account", "model": "deepseek-flash", "effort": "high", "lifecycle": "one-shot" },
    "review": { "provider": "deepseek-account", "model": "deepseek-flash", "effort": "max" }
  }
}
```

想让审查只能读不能写，就在那一行加 `"preset": "<你在 DSH 里定义的只读预设>"`——预设决定工具集，`preset` 写错会在派活时带着角色和文件路径报出来。

（`deepseek-v4-pro` 是 flash 的 4.4 倍价。真要更强的规划/审查，把这行的 model 换过去即可；同一轮可以混用。）

- 文件不存在、或某个角色没有条目 → 该子代理**继承父会话的路由**（不会报错，等同于普通 `subagent`）
- 可选 `preset`：让这一路的子代理跑在某个 DSH 预设里（工具集、提示词段、persona 都跟着预设走）。不写就是默认组合；预设名写错时派活会报出角色、预设名和 `dmr.json` 路径，不会等创建完才失败。**预设本身要在 DSH 里定义好**，DSH 默认只有一个 `standard`。
- 文件存在但**不是合法 JSON** → 派活直接报错并指出文件路径（静默退回会让整轮跑错模型而没人知道）
- **模型名写错** → 派活**在创建子代理之前**就拒绝，报出角色、写错的模型、该供应商实际可用的模型、以及文件路径。校验用的是供应商的实时目录（`llm.listModels`），不是 `resolveModelInfo`——后者对未列出的 id 会照常返回，直到请求发出去才失败。目录为空（比如还没配凭据）时跳过校验，不会误拒合法路由。
- 插件代码里**没有任何模型名**

## 用法

```powershell
# 首次：把示例复制到 DSH_HOME
copy dmr.example.json $env:USERPROFILE\.dsh\dmr.json
```

然后在任意会话里用三个工具派活；核对与自检用：

```powershell
node doctor.js                           # 安装链 / 配置 / 日志 / 四个接口，一次查完
node route-check.js                      # 自动找最近派过角色工具的父会话
node route-check.js --parent <id8> --cost
node usage-audit.js --cost --since 2026-11-04
```

`doctor` 退出码：没有 ✗ → 0，有 ✗ → 1，参数错误 → 2；`!` 只是提醒，不影响退出码。端口默认从本机监听端口里**按 `/config` 的响应形状**认出来（GUI 端口每次重启都变），也可以用 `--port` 直接指定。
`route-check` 退出码：全部符合 → 0，有 ✗ → 1。`usage-audit`：正常 0 / 目录不存在 1 / 参数错误 2。

一次实测（2026-11-04，同一会话、standard preset；当时规划与审查放在 pro 上，现在默认全用 flash）：

```
角色  工具             子会话    模型             effort  req  in     out  判定  $
规划  plan_subagent    95de324b  deepseek-v4-pro  max     1    11638  388  ✓     $0.0084
实现  impl_subagent    d1fc7b84  deepseek-flash   high    1    8745   2    ✓     $0.0013
审查  review_subagent  cb825c54  deepseek-v4-pro  max     1    11944  149  ✓     $0.0084
```

模型列取自各子会话日志里**第一条** `request/header`，不是配置推断。三次合计 $0.0181，其中审查一次就 $0.0084——子代理是全额上下文，能自己判断的小改动别派活。

## 路线图

### v2：配置面板（已完成）

Plugins 详情页里 **DeepSeek Model Route** 自己那一页（`plugins.detail.section`，不是 Settings 的标签页）：

- host 侧两个接口（仅回环地址）：
  - `GET/PUT /plugins/dsh-deepseek-model-route/config` —— 返回文件路径与原文；PUT 校验后写回
  - `GET /plugins/dsh-deepseek-model-route/models` —— 从 `llm.listProviders()` / `llm.listModels()` / `resolveModelInfo()` **实时**读可用模型与 effort 档位，缓存 60 秒
- client 侧注册到 `plugins.detail.section`：三个角色各一组 provider / model / effort / lifecycle 下拉，选完保存；也可以展开直接改 JSON。这个槽在**每个**插件页都会渲染，所以组件对别的插件返回 null
- 配置里的模型不在实时目录里时，页面直接把问题列出来（派活时 `index.mjs` 的预检也会拦，这里是提前说）
- 校验在写之前：角色名必须是 `plan`/`impl`/`review`，`provider`/`model` 非空字符串，`effort` 可选字符串；不合法返回 400 且**不落盘**

实测（2026-11-04）：

```
GET /models → deepseek-account: deepseek-flash, deepseek-v4-pro (efforts: off,low,high,max)
              deepseek-official: 0 个（未配 key —— 不凭空造模型）
PUT /config 合法 → 200；坏 JSON → 400；角色名 typo → 400；磁盘文件保持完好
```

> 首次安装后 client 半需要**重启 DSH**：client 模块表是启动时扫描 `dsh.client` 建的。host 侧（三个工具 + 四个接口）装完即生效。

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

**释放不等于不能用**：实测对一个已释放的 `one-shot` 子代理发 `send_message`，冷恢复成功并正常回复；它按**当时记录的** provider/model/effort（flash @high）发请求，不是按当前 `dmr.json` 走——所以之后改表不会让一个已存在的子代理换模型。

### 还没做的可选项

- 按角色配 `agentPreset`，让审查子代理拿到只读的工具集（现在三个角色的工具集相同，只靠 prompt 约束「审查不许改文件」）

### v4：最近委派（已完成）

详情页的路由表下面多了一块「最近委派」：每次派活只写一行到 `$DSH_HOME/dmr-rounds.jsonl`（`at` / `role` / `childId` / 声明的 provider·model·effort / lifecycle），页面打开时按 `childId` 去**子会话自己的日志**里算花费。

- `GET /plugins/dsh-deepseek-model-route/rounds` —— 回最近 8 次，最新在前；每行带 `cost: { status: 'ok' | 'missing' | 'too-large' | 'unreadable', … }` 与 `releasedAt`
- 计价走 `lib/cost.js`，和 `route-check.js --cost` **同一份实现**（同一个累计器、同一张价表），所以页面上的数和命令行不会对不上
- 面板只做展示：记录写不进去、日志丢了、日志超过 48 MB，都只让那一行显示「—」或「日志过大」，不影响派活
- 会话日志按 `<id>` 找：主会话目录名带 `session-` 前缀，子代理直接用 id，两者同层，扫描结果缓存 5 秒；计价结果按「文件 + 大小 + mtime」缓存 8 秒，子会话在跑的时候会跟着变大
- `one-shot` 释放时往同一份日志追加一行 `{ kind: 'release', childId, at }`，面板给那一行标「已释放」。只留在内存里的话，宿主一重启，上一轮到底释放没释放就只能靠猜；日志里没记着的行不写任何标记，不猜「未释放」。

实测（2026-11-10）：`85e683b0` → `$0.0221` / 26 次调用、`d93b29e5` → `$0.0809` / 40 次，与 `route-check --cost` 逐位一致；坏行跳过、`childId` 找不到的记 `missing`、非回环地址 403、非 GET 405。
实测（2026-11-11）：假 ctx 挂 `impl_subagent`（`one-shot`）与 `plan_subagent`（`continuable`），交付后 `impl` 被 dispose，日志里多出一行 `kind: 'release'`，`/rounds` 给 `impl` 的 `releasedAt` 是时间戳、给 `plan` 的是 `null`；坏行与「未知 childId 的释放行」都不影响表格。

### 界面语言（已完成）

DSH 自带官方 locale（`@deepseek-ai/dsh-client-locale`，随包提供 en / zh / ja / es / fr / de / ru / pt 八种语言，在「设置 → 通用 → 语言」里切），面板跟着它走，不再是内联中文：

- 命名空间 `dsh-deepseek-model-route`，注册 `{ zh, en }` 两套字典（官方要求基线语言成对；54 个 key 一一对应，缺 key 会退回显示 key 本身）
- 组件用槽注入的 `t`（注册时声明 `locale: NS`），切换语言即时生效、不用刷新；槽没给 `t` 时回落到 `ctx.locale.bind(NS)`（它每次调用都看当前语言），所以不会把 key 漏到界面上
- 其余六种语言按官方的 fallback 链落到英文；数字、金额、`@effort` 这些保持原样，只有界面文案跟着变
- 插件列表里的标题与说明放在 `locale/zh.json` / `locale/en.json` 的 `meta` 里（官方就是这样给已安装插件做本地化的），`package.json` 导出 `./locale/*.json`，`dsh.client.inject` 里加上 locale 包
- **插件详情页的正文不再用 README**：`meta.detail` 指向 `docs/page.zh.md` / `docs/page.md`（宿主读包内 Markdown，找不到就退回 README），这两份正文**故意留空**——介绍只保留标题下那一句（`meta.description`），其余说明（配置在哪、怎么核对）收在面板最底下两行
- 插件页的区块顺序是 DSH 定的：正文 → 工具行 → 来源信息 → 插件自己的区块。插件只能控制「正文」和「最底下那块」，没法把面板挪到来源信息之前
- 改完 `docs/page*.md` 或 `meta.detail` 要**升 `version`**：宿主按 `包名@版本` 缓存文档，不升版本打开还是旧的那份
- 改了 `client.js` 仍然要重启 DSH：client 模块表是启动时扫的

实测（2026-11-11）：用最小 hooks 替身把 `client.js` 在 Node 里渲染两遍——`en` 那份文本里没有任何 CJK 字符、`zh` 那份全是中文，两边「已释放 / released」都只出现一次，没有 key 泄漏；槽不给 `t` 时回落到中文，同样不漏 key。

### 自检：`doctor.js`（已完成）

一次回答「现在哪一环坏了」，不按清单推断，只读盘或直接问接口：

| 段 | 查什么 |
|---|---|
| 环境 | `DSH_HOME` 在不在、能不能读 |
| 安装 | 包目录、`main` 与 `exports["./client"]` 指向的文件、bundle patch 里那行 `id: dmr-delegation`、`locale/zh.json` 与 `en.json` 的 `meta`（标题、说明、`detail` 指向的正文文件）及 `./locale/*.json` 导出（宿主读不到就退回包名）、profile 的 `dependencies` 与 `dsh.profile.bundles`、`node_modules` 链接**指向何处**、profile 的 `cordis.patch.yml` / `cordis.yml` 有没有把它 `disabled: true`、还有没有别的断链 |
| 配置 | `dmr.json` 是否存在·合法（与面板共用 `lib/route-table.js` 的校验），每个角色的 provider/model/effort 是否在**实时目录**里；顺手报「最近委派」日志的行数 |
| 会话日志 | `sessions/` 可读吗、多少条日志、最近一条的时间、头 4 字节是不是 zstd 魔数 |
| 接口 | 端口（默认扫本机监听端口，按 `/config` 的响应形状认，不只看状态码）、四个接口的状态与耗时、`/config` 与 `/rounds` 读的文件是否和 `--home` 一致、磁盘上的 `index.mjs` / `client.js` 是否比运行中的进程更新 |

```
DMR doctor · home C:\Users\yx\.dsh · profile desktop · 端口 7523

检查                 状态  说明
-------------------  ----  --------------------------------------------------
profile desktop      ✓     C:\Users\yx\.dsh\profiles\desktop
  node_modules 链接  ✓     → E:\code\program\deepseek-model-router
  plan               ✓     deepseek-account/deepseek-flash @max（DeepSeek-V4.1-Flash） · continuable
  /rounds            ✓     200 · 14ms · 回报 5 次委派
```

只读，不改任何文件；`!` 只是提醒（例如 effort 因目录为空而无法核对），不影响退出码。

## 已知限制

- **法定节假日**：DeepSeek 官方节假日全天算非高峰，这里只按周一至周五 UTC 01–04 / 06–10 为高峰算，节假日会多估。
- **缓存 TTL**：DSH 日志不区分 5 分钟 / 1 小时写缓存，`lib/pricing.js` 里没有 1h 那档。
- **`subagent_fork` 不参与**：fork 子代理继承父会话路由以复用 KV cache，钉模型没有意义。
- **`route-check` 的自动选父会话**只认三个角色工具；只有通用 `subagent` 的会话要用 `--parent` 指定。
- **工具不是线程安全的**：`isConcurrencySafe` 返回 false，同一时刻只跑一个派活，避免两个包同时改同一批文件。
- **`doctor` 的端口发现**是扫本机 LISTENING 端口再按响应形状认；同一台机器上跑多个 DSH 实例时优先选「读的正是 `--home` 那份 `dmr.json`」的那个，都读同一份时按端口号取小的。非 Windows 上进程启动时间靠 `ps -o etimes=`，拿不到就跳过那一行。

## 运维注意

**应用升级或 profile 重装之后，先跑一次 `node doctor.js`。** 实测踩到过一次：`profiles/desktop/package.json` 里仍然声明着 `dsh-deepseek-model-route`，但 `profiles/desktop/node_modules/` 下的链接已经消失——插件没被加载，三个工具和详情页里的面板**同时消失**，而包清单看起来一切正常。doctor 对这一条会直接报 ✗ 并给出重装命令。

```powershell
node doctor.js                 # 退出码 0 = 没有 ✗
node doctor.js --json          # 机器可读：{"sections":[…],"summary":{…}}
node doctor.js --port 7523     # 端口已知时跳过扫描
```

恢复只要重装一次（先卸再装，`install_bundle` 对已装的包会直接拒绝）：

```
plugin_manager remove_bundle  dsh-deepseek-model-route
plugin_manager install_bundle E:\code\program\deepseek-model-router
```

重装后工具立刻可用；**插件详情页里的面板要重启 DSH** 才会回来（client 模块在启动时扫描）。doctor 的「运行中的代码」那一行会用进程启动时间和文件 mtime 比对，晚于进程启动就会提醒你重启。
