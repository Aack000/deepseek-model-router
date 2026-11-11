三个派活工具，三个阶段各走各的模型：

| 工具 | 用途 |
|---|---|
| `plan_subagent` | 读代码、写方案 |
| `impl_subagent` | 改文件 |
| `review_subagent` | 只读、找缺陷 |

路由表在 `$DSH_HOME/dmr.json`，每次派活都会重读一遍，所以改完下一个子代理就生效：

```json
{ "roles": { "impl": { "provider": "deepseek-account", "model": "deepseek-flash", "effort": "high", "lifecycle": "one-shot" } } }
```

某个角色没有条目，表示它继承父会话的路由；模型不在该供应商的目录里，派活会在创建子代理之前被拒绝。

核对（在仓库目录里跑）：

```powershell
node doctor.js              # 安装链、配置、日志、四个接口
node route-check.js --cost  # 每轮实际跑的模型与花费
```

花费取自子会话自己的日志，不按配置推断。每个子代理都是一份全新的完整上下文，能自己判断的小改动别派活。

下面的表格就是当前设置，改完保存，下一句话生效。
