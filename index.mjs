// DMR host plugin — registers the three phase tools whose model routes come from
// dmr.json at call time.
//
// Why the routes are read per call instead of pinned in the preset: a preset's
// `agentOptions` are static, so pinning there means re-editing YAML and
// reinstalling the bundle for every model change. `startActivation` takes
// `request.agentOptions` per call, so reading the JSON here makes a model change
// take effect on the next delegation — no remount, no reinstall.
//
// This module imports nothing from the DSH installation: the profile's
// node_modules holds no `@deepseek-ai/*` packages, so a bundle that imported them
// would fail to resolve. Everything comes from the Cordis context.

import { readFileSync, writeFileSync, appendFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import costLib from './lib/cost.js'
// 校验规则与 `doctor.js` 共用：面板说「角色名写错」和命令行说「角色名写错」要是同一句话。
import routeTable from './lib/route-table.js'

/** The settings page talks to this exact path. */
const ROUTE_PATH = '/plugins/dsh-deepseek-model-route/config'
const MODELS_PATH = '/plugins/dsh-deepseek-model-route/models'
const ROUNDS_PATH = '/plugins/dsh-deepseek-model-route/rounds'

export const name = 'dmr'
// `inject` makes Cordis wait for both services before apply() runs, and fail the
// mount rather than let apply() read a missing service.
export const inject = ['tools', 'subagents']

/** The three phases, in the order a round runs them. */
const ROLES = [
  {
    id: 'plan',
    tool: 'plan_subagent',
    label: 'planning',
    description:
      'Delegate a planning or design task to a subagent. Use it for the phase that reads the codebase and writes a plan; it must not write production code. Returns the child session id immediately; the answer arrives as a completion notice.',
  },
  {
    id: 'impl',
    tool: 'impl_subagent',
    label: 'implementation',
    description:
      'Delegate an implementation, fix, or documentation task to a subagent. Use it for every package of work that edits files. Returns the child session id immediately; the answer arrives as a completion notice.',
  },
  {
    id: 'review',
    tool: 'review_subagent',
    label: 'review',
    description:
      'Delegate an adversarial review of a change to a subagent. Use it after implementation, before reporting; it reads the change and reports defects, it must not edit files. Returns the child session id immediately; the answer arrives as a completion notice.',
  },
]

/** Where the route table lives; a plugin config `path` overrides it. */
function routeFile(config) {
  if (typeof config?.path === 'string' && config.path.length > 0) return config.path
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'dmr.json')
}

/**
 * Read one role's route from the table.
 *
 * A missing file or a role without a route is NOT an error: the child then
 * inherits the parent's route, which is what a plain delegation tool would do.
 * That keeps a fresh install working before anyone edits the file, and keeps this
 * plugin free of baked-in model names. A file that exists but does not parse IS an
 * error — silently ignoring a typo would route the whole round on the wrong model.
 */
function readRoute(file, roleId) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { kind: 'inherited' }
    throw new Error(`DMR: cannot read ${file}: ${error?.message ?? error}`)
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`DMR: ${file} is not valid JSON (${error?.message ?? error})`)
  }

  const entry = parsed?.roles?.[roleId]
  if (!entry || typeof entry !== 'object') return { kind: 'inherited' }

  const provider = entry.provider
  const model = entry.model
  if (typeof provider !== 'string' || provider.length === 0) {
    throw new Error(`DMR: roles.${roleId}.provider must be a non-empty string in ${file}`)
  }
  if (typeof model !== 'string' || model.length === 0) {
    throw new Error(`DMR: roles.${roleId}.model must be a non-empty string in ${file}`)
  }
  const effort = typeof entry.effort === 'string' && entry.effort.length > 0 ? entry.effort : undefined
  // Absent means `continuable`: that is DSH's native behaviour, and a planner or a
  // reviewer is often continued with send_message. Opting into `one-shot` is the
  // only way to get a child released as soon as it delivers.
  const lifecycle = entry.lifecycle === 'one-shot' ? 'one-shot' : 'continuable'
  return { kind: 'pinned', provider, model, effort, lifecycle }
}

function describeRoute(route) {
  if (route.kind === 'inherited') return 'inherited from the parent session'
  return `${route.provider}/${route.model}${route.effort ? ` @${route.effort}` : ''}`
}
/** One tool definition per role; the model is decided inside execute(). */
function toolFor(ctx, role, file, provider, released) {
  return {
    name: role.tool,
    description: role.description,
    parameters: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'Short (3-5 word) label for this delegation, shown in the child roster.',
        },
        prompt: {
          type: 'string',
          description:
            'The complete, self-contained task. The child does not see this conversation, so include every path, constraint, and deliverable it needs.',
        },
        cwd: {
          type: 'string',
          description:
            'Initial working directory for the child. Relative paths resolve against the caller current directory; omitted inherits it.',
        },
      },
      required: ['description', 'prompt'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          subagentId: { type: 'string' },
          route: { type: 'string' },
          lifecycle: { type: 'string' },
        },
        required: ['subagentId', 'route', 'lifecycle'],
        additionalProperties: false,
      },
      // The model reads this line. It names the route and the lifecycle so a wrong
      // table entry is visible at delegation time instead of at the next route-check.
      render: (_args, value) =>
        [{
          type: 'text',
          text: `started subagent ${value?.subagentId ?? '?'} (route: ${value?.route ?? '?'}, ${value?.lifecycle ?? '?'})`,
        }],
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) throw new Error('DMR: this tool needs a calling agent')

      const description = String(args?.description ?? '').trim()
      const prompt = String(args?.prompt ?? '').trim()
      if (prompt.length === 0) throw new Error('DMR: prompt must not be empty')

      const route = readRoute(file, role.id)
      const agentOptions = route.kind === 'pinned'
        ? {
            provider: route.provider,
            model: route.model,
            ...(route.effort ? { reasoningEffort: route.effort } : {}),
          }
        : undefined

      // Resolve the route before creating anything. A typo in dmr.json otherwise
      // surfaces as a provider error during child creation, where nothing says which
      // line of which file is wrong.
      //
      // Membership, not `resolveModelInfo`: the catalog is advisory for routing, so an
      // unknown id resolves without complaint and only fails at the provider. Comparing
      // against the advertised list is what catches a typo. An empty list means the
      // provider has no catalog to compare with (for example no credential), so the
      // check is skipped rather than rejecting a legitimate route.
      if (route.kind === 'pinned') {
        const llm = ctx.get?.('llm') ?? ctx.llm
        if (llm && typeof llm.listModels === 'function') {
          let available = []
          try {
            available = ((await llm.listModels(route.provider)) ?? []).map((model) => model.id)
          } catch (error) {
            throw new Error(
              `DMR: cannot list models for provider "${route.provider}" (${error?.message ?? error}) — fix ${file}`,
            )
          }
          if (available.length > 0 && !available.includes(route.model)) {
            throw new Error(
              `DMR: roles.${role.id}.model "${route.model}" is not offered by "${route.provider}" `
              + `(available: ${available.join(', ')}) — fix ${file}`,
            )
          }
          if (route.effort && typeof llm.resolveModelInfo === 'function') {
            try {
              const info = await llm.resolveModelInfo(route.provider, route.model)
              const efforts = (info?.reasoning?.efforts ?? []).map((entry) => entry.id)
              if (efforts.length > 0 && !efforts.includes(route.effort)) {
                throw new Error(
                  `DMR: roles.${role.id}.effort "${route.effort}" is not offered by ${route.provider}/${route.model} `
                  + `(available: ${efforts.join(', ')}) — fix ${file}`,
                )
              }
            } catch (error) {
              if (!String(error?.message ?? error).startsWith('DMR:')) throw error
            }
          }
        }
      }

      // A fresh signal: the spec's signal cancels STARTUP. Handing it the tool
      // call's signal would tie the child's creation to a call that returns
      // immediately, and the activation is owned by the runtime from then on.
      const signal = new AbortController().signal

      const activation = await ctx.subagents.startActivation({
        provider,
        label: description || role.label,
        request: {
          prompt: [{ type: 'text', text: prompt }],
          parent,
          ...(agentOptions ? { agentOptions } : {}),
          ...(typeof args?.cwd === 'string' && args.cwd.length > 0 ? { cwd: args.cwd } : {}),
        },
        signal,
        delivery: 'parent',
      })

      // 插件页的「最近委派」读这一行。它只是展示，写不进去也不该影响派活。
      recordRound(file, {
        at: Date.now(),
        role: role.id,
        tool: role.tool,
        childId: String(activation.childId),
        provider: route.kind === 'pinned' ? route.provider : null,
        model: route.kind === 'pinned' ? route.model : null,
        effort: route.kind === 'pinned' ? route.effort : null,
        lifecycle: route.kind === 'pinned' ? route.lifecycle : 'continuable',
      })

      // `one-shot` releases the child as soon as it delivers, so a phase that only
      // needs the answer leaves no resident activation behind. `continuable` — the
      // default — keeps the native behaviour, where send_message can continue it.
      if (route.kind === 'pinned' && route.lifecycle === 'one-shot') {
        activation.result
          .catch(() => undefined)
          .then(() => activation.dispose())
          .then(() => {
            released.push({ child: String(activation.childId), role: role.id, at: Date.now() })
            if (released.length > 200) released.shift()
          })
          .catch((error) => console.warn('[dmr] release failed:', error?.message ?? error))
      }

      return {
        subagentId: String(activation.childId),
        route: describeRoute(route),
        lifecycle: route.kind === 'pinned' ? route.lifecycle : 'continuable',
      }
    },
    // Delegation must not run in parallel with another delegation: two children
    // started in one step would race on the same files.
    isConcurrencySafe: () => false,
  }
}

// ────────────────────────── 插件详情页的接口 ──────────────────────────

// ─────────────────────────── 最近委派（插件页用） ───────────────────────────

/**
 * 插件页那一块「最近委派」：派活时在 $DSH_HOME/dmr-rounds.jsonl 追加一行，
 * 页面打开时再按子会话 id 去会话日志里算它花了多少。
 *
 * 为什么不只在内存里攒：宿主进程一重启就空了，页面会突然说「没有记录」，
 * 可一小时前明明刚派过活。一行一个 JSON，坏行跳过，写失败只 warn。
 */
const ROUNDS_KEEP = 40
const ROUNDS_ROWS = 8

function roundsFile(file) {
  return join(dirname(file), 'dmr-rounds.jsonl')
}

function recordRound(file, round) {
  const target = roundsFile(file)
  try {
    appendFileSync(target, `${JSON.stringify(round)}\n`, 'utf8')
  } catch (error) {
    console.warn('[dmr] cannot record a delegation:', error?.message ?? error)
    return
  }
  // 文件不会无限长：大了就只留最近 ROUNDS_KEEP 行。
  try {
    if (statSync(target).size < 256 * 1024) return
    const lines = readFileSync(target, 'utf8').split('\n').filter((line) => line.trim() !== '')
    writeFileSync(target, `${lines.slice(-ROUNDS_KEEP).join('\n')}\n`, 'utf8')
  } catch (error) {
    console.warn('[dmr] cannot trim the delegation log:', error?.message ?? error)
  }
}

/** 最新的在前。坏行跳过：一条记录坏掉不该让整块面板消失。 */
function readRounds(file, limit) {
  let text
  try {
    text = readFileSync(roundsFile(file), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }

  const rounds = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object') rounds.push(parsed)
    } catch {
      // 半行 / 非 JSON：跳过
    }
  }
  return rounds.slice(-limit).reverse()
}

function roundsRoute(file) {
  return async (req, res) => {
    if (!isLocal(req)) return sendJson(res, 403, { error: 'local access only' })
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })

    let rounds
    try {
      rounds = readRounds(file, ROUNDS_ROWS)
    } catch (error) {
      return sendJson(res, 500, { error: String(error?.message ?? error) })
    }

    // 花费来自子会话自己的日志，跟 route-check.js --cost 用同一份计价器。
    // 解压 + 逐行解析是同步的，所以每算完一行让出一拍：别把宿主的事件循环按住不放。
    const home = dirname(file)
    const rows = []
    for (const round of rounds) {
      await new Promise((resolve) => setImmediate(resolve))
      const cost = typeof round.childId === 'string'
        ? costLib.costOfSession(round.childId, { home })
        : { status: 'missing' }
      rows.push({
        at: typeof round.at === 'number' ? round.at : null,
        role: typeof round.role === 'string' ? round.role : null,
        childId: typeof round.childId === 'string' ? round.childId : null,
        provider: typeof round.provider === 'string' ? round.provider : null,
        model: typeof round.model === 'string' ? round.model : null,
        effort: typeof round.effort === 'string' ? round.effort : null,
        lifecycle: typeof round.lifecycle === 'string' ? round.lifecycle : null,
        cost: cost.status === 'ok'
          ? {
              status: 'ok',
              usd: cost.usd,
              unpriced: cost.unpriced,
              calls: cost.calls,
              input: cost.input,
              output: cost.output,
              cacheRead: cost.cacheRead,
              // 子会话日志里的第一条 request/header：这才是**实际**跑的模型，
              // 上面那三个字段只是派活时声明的值。
              actual: cost.header ?? null,
            }
          : { status: cost.status, bytes: typeof cost.bytes === 'number' ? cost.bytes : null },
      })
    }

    return sendJson(res, 200, { rounds: rows, file: roundsFile(file) })
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function isLocal(req) {
  const address = req.socket?.remoteAddress ?? ''
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)
}

// Validation lives in lib/route-table.js: `doctor.js` checks the same file and must
// report a bad entry the same way this route rejects it.

/**
 * The model catalog, read from the live `llm` service so the page never offers a
 * model the runtime cannot serve. Cached briefly: the account route refreshes its
 * listing in the background and a settings page should not hammer it.
 *
 * A model whose route cannot be resolved still appears with an empty effort list;
 * the page then leaves effort alone rather than inventing a value.
 */
function modelsRoute(modelCache) {
  return async (req, res) => {
    if (!isLocal(req)) return sendJson(res, 403, { error: 'local access only' })
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })

    if (modelCache.data && Date.now() - modelCache.at < 60_000) return sendJson(res, 200, modelCache.data)

    const llm = modelCache.ctx?.get?.('llm') ?? modelCache.ctx?.llm
    if (!llm) return sendJson(res, 503, { error: 'the llm service is not available in this composition' })

    let providers
    try {
      providers = await llm.listProviders()
    } catch (error) {
      return sendJson(res, 502, { error: `cannot list providers: ${error?.message ?? error}` })
    }

    const out = []
    for (const provider of providers ?? []) {
      let models = []
      try {
        models = await llm.listModels(provider.id)
      } catch {
        models = []
      }
      const entries = []
      for (const model of models ?? []) {
        let efforts = []
        let defaultEffort
        try {
          const info = await llm.resolveModelInfo(provider.id, model.id)
          efforts = (info?.reasoning?.efforts ?? []).map((effort) => effort.id)
          defaultEffort = info?.reasoning?.defaultEffort
        } catch {
          efforts = []
        }
        entries.push({ id: model.id, name: model.name ?? model.id, efforts, defaultEffort })
      }
      out.push({ id: provider.id, name: provider.name ?? provider.id, models: entries })
    }

    const data = { providers: out, readAt: Date.now() }
    modelCache.at = Date.now()
    modelCache.data = data
    return sendJson(res, 200, data)
  }
}

function configRoute(file) {
  return async (req, res) => {
    if (!isLocal(req)) return sendJson(res, 403, { error: 'local access only' })

    if (req.method === 'GET') {
      try {
        return sendJson(res, 200, { path: file, exists: true, text: readFileSync(file, 'utf8') })
      } catch (error) {
        if (error?.code === 'ENOENT') return sendJson(res, 200, { path: file, exists: false, text: '' })
        return sendJson(res, 500, { error: String(error?.message ?? error) })
      }
    }

    if (req.method === 'PUT' || req.method === 'POST') {
      let body
      try {
        body = await readBody(req)
      } catch (error) {
        return sendJson(res, 413, { error: String(error?.message ?? error) })
      }
      let parsed
      try {
        parsed = JSON.parse(body)
      } catch (error) {
        return sendJson(res, 400, { error: `not valid JSON: ${error?.message ?? error}` })
      }
      try {
        routeTable.validateRouteTable(parsed)
      } catch (error) {
        return sendJson(res, 400, { error: String(error?.message ?? error) })
      }
      try {
        writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
        return sendJson(res, 200, { path: file, exists: true, text: readFileSync(file, 'utf8') })
      } catch (error) {
        return sendJson(res, 500, { error: String(error?.message ?? error) })
      }
    }

    return sendJson(res, 405, { error: 'method not allowed' })
  }
}

export function apply(ctx, config = {}) {
  const file = routeFile(config)
  // Health, not an archive: children this plugin released after they delivered.
  // DMR cannot delete a child's catalog entry (DSH keeps it durable on purpose),
  // so the only honest way to show the lifecycle working is to report releases.
  const released = []
  // The backend that materializes the child; `spawn` ships with the harness and is
  // the one this plugin's tools were designed against.
  const provider = typeof config.provider === 'string' && config.provider.length > 0 ? config.provider : 'spawn'
  for (const role of ROLES) {
    ctx.effect(() => ctx.tools.register(toolFor(ctx, role, file, provider, released)), `dmr:${role.tool}`)
  }

  // The settings page reads and writes the same file the tools read, so a saved
  // edit applies to the next delegation. A route failure must never take the
  // session down: it only makes the page unavailable.
  try {
    if (typeof ctx.inject === 'function') {
      // The catalog route needs the plugin's own ctx (for `llm`) and a place to
      // cache the listing, so it captures both here rather than per request.
      const modelCache = { at: 0, data: null, ctx }
      ctx.inject(['webServer'], (httpCtx) => {
        httpCtx.effect(
          () => httpCtx.webServer.register({ kind: 'exact', path: ROUTE_PATH, handler: configRoute(file) }),
          'dmr: config route',
        )
        httpCtx.effect(
          () => httpCtx.webServer.register({ kind: 'exact', path: MODELS_PATH, handler: modelsRoute(modelCache) }),
          'dmr: models route',
        )
        httpCtx.effect(
          () => httpCtx.webServer.register({ kind: 'exact', path: ROUNDS_PATH, handler: roundsRoute(file) }),
          'dmr: rounds route',
        )
        httpCtx.effect(
          () => httpCtx.webServer.register({
            kind: 'exact',
            path: '/plugins/dsh-deepseek-model-route/stats',
            handler: async (req, res) => {
              if (!isLocal(req)) return sendJson(res, 403, { error: 'local access only' })
              return sendJson(res, 200, { released: released.slice(-50) })
            },
          }),
          'dmr: stats route',
        )
      })
    }
  } catch (error) {
    console.warn('[dmr] settings routes unavailable:', error)
  }
}
