Three delegation tools, one model per phase:

| Tool | What it is for |
|---|---|
| `plan_subagent` | reads the code, writes the plan |
| `impl_subagent` | edits files |
| `review_subagent` | read-only, reports defects |

The route table lives in `$DSH_HOME/dmr.json` and is read on every delegation, so an edit applies to the next subagent:

```json
{ "roles": { "impl": { "provider": "deepseek-account", "model": "deepseek-flash", "effort": "high", "lifecycle": "one-shot" } } }
```

A role with no entry inherits the parent's route; a model the provider does not offer is rejected before the child is created.

Check it from the package directory:

```powershell
node doctor.js              # install chain, config, logs, the four routes
node route-check.js --cost  # the model each round actually ran on, and its spend
```

Spend is read from the child's own session log, not inferred from the config. A subagent starts with a full fresh context, so do not delegate a small change you can judge yourself.

The table below is the live setting; save it and the next delegation picks it up.
