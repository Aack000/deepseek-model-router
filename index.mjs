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

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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
  return { kind: 'pinned', provider, model, effort }
}

function describeRoute(route) {
  if (route.kind === 'inherited') return 'inherited from the parent session'
  return `${route.provider}/${route.model}${route.effort ? ` @${route.effort}` : ''}`
}

/** One tool definition per role; the model is decided inside execute(). */
function toolFor(ctx, role, file, provider) {
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
        },
        required: ['subagentId', 'route'],
        additionalProperties: false,
      },
      // The model reads this line. It names the route so a wrong table entry is
      // visible at delegation time instead of at the next route-check.
      render: (_args, value) =>
        [{ type: 'text', text: `started subagent ${value?.subagentId ?? '?'} (route: ${value?.route ?? '?'})` }],
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

      return { subagentId: String(activation.childId), route: describeRoute(route) }
    },
    // Delegation must not run in parallel with another delegation: two children
    // started in one step would race on the same files.
    isConcurrencySafe: () => false,
  }
}

export function apply(ctx, config = {}) {
  const file = routeFile(config)
  // The backend that materializes the child; `spawn` ships with the harness and is
  // the one this plugin's tools were designed against.
  const provider = typeof config.provider === 'string' && config.provider.length > 0 ? config.provider : 'spawn'
  for (const role of ROLES) {
    ctx.effect(() => ctx.tools.register(toolFor(ctx, role, file, provider)), `dmr:${role.tool}`)
  }
}
