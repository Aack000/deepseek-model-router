# 变更记录

按里程碑记，不按提交记：每条只说**用户能看见的行为**。日期取首次落地的提交。

## 未发布

### 新增

- `doctor.js`：一次回答「现在哪一环坏了」——包目录与两个入口、bundle patch 里那行插件、`locale/*.json` 的 meta 与导出、profile 的依赖声明 / bundle 列表 / `node_modules` 链接指向 / 有没有被 `disabled: true`、`dmr.json` 与实时模型目录、会话日志、四个接口。只读，不改任何文件。
- 端口自动发现：扫本机 LISTENING 端口，用 `/config` 的**响应形状**（`{path, exists, text}`）认端口，不只看状态码——实测本机有别的程序对任意路径都回 200。也可 `--port` 直接指定。
- 「运行中的代码」：比对 `index.mjs` / `client.js` 的 mtime 与 DSH 进程启动时间，改了但没重装 / 没重启会提醒。
- `--json` 输出与 0 / 1 / 2 退出码，风格与 `route-check.js` 一致。

### 调整

- 路由表的结构校验搬到 `lib/route-table.js`，面板的 `PUT /config` 与 `doctor.js` 共用一份；400 的错误话术保持不变。

### 审查后的修复

- `PUT /config` 要求 `content-type: application/json`：跨站的 `text/plain` POST 不能再改写路由表；写盘改成「临时文件 + rename」，崩溃不会留下半个 `dmr.json`。
- 面板在 JSON 非法时动下拉不再覆盖用户正在编辑的文本（以前会兜底成空表）。
- effort 校验不再被自己的 `catch` 吞掉（以前写错 effort 根本不报）；`resolveModelInfo` 失败会带角色名和文件路径报错。
- 面板只在包页（`kind: 'bundle'`）渲染，行页不再重复整块面板。
- `provider` / `model` / `effort` 读取时自动 trim。
- `/rounds` 计算花费时用 `DSH_HOME` 定位会话日志，不再假设 `dmr.json` 就在 DSH_HOME 里；rounds 日志裁剪也改成原子写。

### 账本口径

- `usage-audit.js` 与 `route-check.js` 的 `req` 都改成两个字段：`calls`（带 usage 的 `assistant/message` 条数，真正的模型调用次数）与 `ctx`（`request/header` 条数，只表示上下文重置）。原来只显示 `ctx`，一条 474 次调用的会话会被读成 `req=26`，严重低估；子会话里 `ctx` 通常只有 1，按它看成本会差一个量级。

### 按角色换预设

- `roles.<role>.preset`：这一路的子代理跑在某个 DSH 预设里（工具集、提示词段、persona 随预设），不写就是默认组合。
- 预设名写错时，派活报出角色、预设名和 `dmr.json` 路径；其它创建失败（例如并发上限）保持 DSH 原样的错误码，不被改写。
- 面板在角色名下面标 `· preset <名字>`，「最近委派」的悬停提示里也带上；没有下拉，因为预设清单取决于这份 DSH 里定义了哪些。

### 界面双语

- 面板文案接入官方的 `@deepseek-ai/dsh-client-locale`：命名空间 `dsh-deepseek-model-route`，注册 `{ zh, en }` 两套字典；语言跟随「设置 → 通用」，其余六种语言回落英文。
- 组件用槽注入的 `t`（注册时声明 `locale: NS`），切换语言即时生效；槽没给 `t` 时回落到 `ctx.locale.bind(NS)`，不会显示 key。
- 插件列表的标题与说明改由 `locale/zh.json`、`locale/en.json` 的 `meta` 提供；`package.json` 增加 `./locale/*.json` 导出、`dsh.client.inject` 加上 locale 包，`description` 改为英文（中文在 `locale/zh.json`）。
- 插件详情页正文改用 `meta.detail`（zh → `docs/page.zh.md`，en → `docs/page.md`），且**故意留空**：介绍只保留标题下面那一句，插件页的区块顺序（正文 → 工具行 → 来源信息 → 面板）由 DSH 决定，插件只能控制首尾两块。
- 面板底部补两行：配置在 `$DSH_HOME/dmr.json`、改完下一个子代理生效，以及 `node doctor.js` / `node route-check.js --cost`；面板与上一块之间的间距从 28+20 收到 10+12。`version` 提到 0.1.3——宿主按 `包名@版本` 缓存文档，不升版本就不会刷新。

### 「最近委派」的已释放标记

- `one-shot` 释放时往 `dmr-rounds.jsonl` 追加一行 `{ kind: 'release', childId, at }`，`/rounds` 每行多一个 `releasedAt`（没记着就是 `null`）。
- 面板在「时间」列下面给这些行标「已释放」，鼠标悬停显示释放时间；没有记录的行不写标记，不猜「未释放」。
- 为什么落盘：释放列表原本只在宿主内存里，进程一重启，上一轮那几个 one-shot 有没有交付释放就说不清了。

## v4 — 最近委派（2026-11-10）

- 详情页的路由表下面多一块「最近委派」：每次派活往 `$DSH_HOME/dmr-rounds.jsonl` 追加一行（`at` / `role` / `childId` / 声明的 provider·model·effort / lifecycle），页面打开时按 `childId` 去**子会话自己的日志**里算钱。
- `GET /plugins/dsh-deepseek-model-route/rounds`：最近 8 次，最新在前，每行带 `cost.status`（`ok` / `missing` / `too-large` / `unreadable`）与 `cost.actual`（子会话第一条 `request/header` 的路由）。
- 计价抽到 `lib/cost.js`，`route-check --cost` 与面板共用同一个累计器和同一张价表，两边不会算出不同的数。
- 面板开头改成一句介绍 + 两张表，去掉说明段落；超过 8 次的旧委派给一句「更早的去 `dmr-rounds.jsonl` 看」。
- 记录写不进去、日志丢了、日志超过 48 MB，都只影响那一格显示，不影响派活。

## v3 — 生命周期（2026-11-04）

- 每个角色多一个 `lifecycle`：`continuable`（默认，`send_message` 可续跑）/ `one-shot`（交付即 `activation.dispose()` 释放，续跑走冷恢复）。
- `GET /plugins/dsh-deepseek-model-route/stats` 回报本进程释放过的子代理——释放是可观测的，不是配置里的承诺。
- 不做「关闭子代理」按钮：DSH 的子代理条目是 durable 的，删不掉，做出来是假功能。
- 面板从 Settings 的标签页搬到**插件自己的详情页**（`plugins.detail.section`），并给不可用的路由提前标红。

## v2 — 设置页（2026-11-04）

- 插件详情页里可以改路由：三个角色各一组 provider / model / effort / lifecycle 下拉，也能展开直接改 JSON。
- `GET/PUT /plugins/dsh-deepseek-model-route/config`（仅回环地址）：GET 返回路径与原文；PUT 先校验再落盘，坏 JSON / 未知角色 / 空 provider / 非法 lifecycle 一律 400 且**不落盘**。
- `GET /plugins/dsh-deepseek-model-route/models`：从 `llm.listProviders/listModels/resolveModelInfo` 实时读模型与 effort 档位，缓存 60 秒；目录里没有的模型在页面上提前标红，不等派活失败。
- client 半在首次安装后必须**重启 DSH**：client 模块表是启动时扫描 `dsh.client` 建的，刷新页面不够。

## v1 — 路由表每次派活读一遍（2026-11-04）

- 三个工具 `plan_subagent` / `impl_subagent` / `review_subagent` 每次调用读一遍 `dmr.json`，改表下一句话生效，不用重装 bundle。
- 模型名写错在**创建子代理之前**就拒绝：用 `llm.listModels` 的成员比对（不是 `resolveModelInfo`，后者对未知 id 照常返回），报出角色、写错的模型、该供应商可用的模型、以及文件路径。
- 工具放在 **host 平面**（`cordis.patch.yml` 一行），不用 preset：preset 的插件列表在会话创建时组合一次，已开始的会话不能换 preset，放进 preset 等于「装完还得开新会话」。
- `route-check.js`：子代理归属按父会话日志里 `tool/call` ↔ `tool/result` 的 `callId` 匹配，子会话模型取它第一条 `request/header`；提供 `--expect` / `--from` / `--json` / `--cost`，退出码 0/1/2。
- 期望值改为取自**该次派活声明的路由**（工具返回文本里的 `route: provider/model`），没有声明才回退到当前 `dmr.json`；声明为 `inherited` 的行不比对——改表不会误伤历史轮次，「声明 A 实际跑 B」照样抓得出。

## v0 — 起点（2026-11-04）

- 最初按 Claude Code 插件的思路用 preset 组合三个阶段的模型；同一天放弃（已开始的会话不能换 preset，模型写死在预设里要改 YAML + 重装）。
- `usage-audit.js`：会话日志的 token 汇总与美元计价，`--since` 支持 ISO 时间与 epoch。
- `lib/session-log.js`：多帧 zstd 的**结构化**解析（RFC 8878 帧头 + 块头）。整份日志绝不能用 `zstdDecompressSync` 一次解——多帧时只返回第一帧，且首帧明文长度恰为 131072 的倍数时还会漏出后续帧。
- `lib/pricing.js`：价表（$/百万 token）与分时计价；查不到单价的模型按默认价估并标 `*`。
