window.__ModuleLoader__.load({
  id: 'dsh-deepseek-model-route',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const CONFIG = '/plugins/dsh-deepseek-model-route/config'
    const MODELS = '/plugins/dsh-deepseek-model-route/models'
    const ROUNDS = '/plugins/dsh-deepseek-model-route/rounds'
    const ROLES = ['plan', 'impl', 'review']

    // 文案跟着官方的 `@deepseek-ai/dsh-client-locale` 走：注册一个命名空间，
    // 基线语言是 zh 与 en（必须成对），其余语言按各自的 fallback 链落到 en。
    // 中文仍然是主语言；英文不是另写一套界面，是同一份 key 的另一份值。
    const NS = 'dsh-deepseek-model-route'
    const zh = {
      'nav': '模型路由',
      'title': '阶段路由',
      'intro': '三个阶段的子代理各走各的模型，保存后下一个子代理生效。',
      'catalog.failed': '模型目录读不出来：{error}。下拉不可用，但可以展开下面的 JSON 直接改。',
      'col.phase': '阶段',
      'col.provider': '供应商',
      'col.model': '模型',
      'col.effort': '推理强度',
      'col.lifecycle': '生命周期',
      'role.plan': '规划',
      'role.impl': '实现',
      'role.review': '审查',
      'role.planHint': '读代码出方案',
      'role.implHint': '改文件的主力',
      'role.reviewHint': '只读、找缺陷',
      'role.unknown': '未知',
      'lifecycle.continuable': '可续跑',
      'lifecycle.oneShot': '交付即释放',
      'lifecycle.hint': '可续跑：跑完仍可用 send_message 续同一个子代理。交付即释放：拿到结果就释放激活，之后续跑要走冷恢复。',
      'effort.default': '默认',
      'action.save': '保存',
      'action.reload': '重新读取',
      'state.saved': '已保存，下一个子代理生效。',
      'state.invalidJson': 'JSON 不合法：{error}',
      'state.notObject': '顶层必须是一个对象',
      'problem.line': '配置有问题：{text}',
      'problem.provider': '{role}：供应商 "{provider}" 不在当前可用列表里',
      'problem.model': '{role}：模型 "{model}" 不在 {provider} 的可用列表里（可用：{list}）',
      'problem.effort': '{role}：effort "{effort}" 不在 {model} 支持的档位里（可用：{list}）',
      'list.separator': '、',
      'rounds.title': '最近委派',
      'rounds.failed': '最近委派读不出来：{error}',
      'rounds.loading': '读取中…',
      'rounds.empty': '还没有记录，派一次活之后就有了。',
      'rounds.colPhase': '阶段',
      'rounds.colModel': '模型',
      'rounds.colCost': '花费',
      'rounds.colCalls': '调用与令牌',
      'rounds.colTime': '时间',
      'rounds.inherited': '继承父会话',
      'rounds.dash': '—',
      'rounds.tooLarge': '日志过大',
      'rounds.tooLargeHint': '{mb} MB，未计价',
      'rounds.unreadable': '读不出',
      'rounds.unreadableHint': '子会话日志坏了',
      'rounds.noLog': '日志还没生成',
      'rounds.calls': '{calls} 次 · 入 {input} / 出 {output}',
      'rounds.actualTitle': '实际 {actual} · 声明 {declared}',
      'rounds.declaredTitle': '声明 {declared}（子会话日志里还没有模型）',
      'rounds.released': '已释放',
      'rounds.releasedAt': '释放于 {time}',
      'rounds.total': '这 {count} 次合计 {usd}',
      'rounds.note': '一个子代理一个会话，这里是它整段会话的合计',
      'json.edit': '直接编辑 JSON',
      'foot.config': '配置在 $DSH_HOME/dmr.json，改完下一个子代理生效。',
      'foot.check': '核对：node doctor.js · node route-check.js --cost',
    }
    const en = {
      'nav': 'Model route',
      'title': 'Phase routing',
      'intro': 'Each phase delegates to its own model. A save applies to the next subagent.',
      'catalog.failed': 'The model catalog is unavailable: {error}. The dropdowns are off, but the JSON below can still be edited.',
      'col.phase': 'Phase',
      'col.provider': 'Provider',
      'col.model': 'Model',
      'col.effort': 'Effort',
      'col.lifecycle': 'Lifecycle',
      'role.plan': 'Plan',
      'role.impl': 'Implement',
      'role.review': 'Review',
      'role.planHint': 'reads the code, writes the plan',
      'role.implHint': 'the one that edits files',
      'role.reviewHint': 'read-only, hunts defects',
      'role.unknown': 'Unknown',
      'lifecycle.continuable': 'Continuable',
      'lifecycle.oneShot': 'Release on delivery',
      'lifecycle.hint': 'Continuable: send_message can continue the same child. Release on delivery: the activation is disposed as soon as the answer arrives, and a later send_message takes the cold-recovery path.',
      'effort.default': 'Default',
      'action.save': 'Save',
      'action.reload': 'Reload',
      'state.saved': 'Saved. Applies to the next subagent.',
      'state.invalidJson': 'Invalid JSON: {error}',
      'state.notObject': 'the top level must be an object',
      'problem.line': 'Config problem: {text}',
      'problem.provider': '{role}: provider "{provider}" is not in the live catalog',
      'problem.model': '{role}: model "{model}" is not offered by {provider} (available: {list})',
      'problem.effort': '{role}: effort "{effort}" is not offered by {model} (available: {list})',
      'list.separator': ', ',
      'rounds.title': 'Recent delegations',
      'rounds.failed': 'Recent delegations unavailable: {error}',
      'rounds.loading': 'Loading…',
      'rounds.empty': 'Nothing yet. One delegation and it shows up here.',
      'rounds.colPhase': 'Phase',
      'rounds.colModel': 'Model',
      'rounds.colCost': 'Cost',
      'rounds.colCalls': 'Calls and tokens',
      'rounds.colTime': 'When',
      'rounds.inherited': 'inherits the parent',
      'rounds.dash': '—',
      'rounds.tooLarge': 'log too large',
      'rounds.tooLargeHint': '{mb} MB, not priced',
      'rounds.unreadable': 'unreadable',
      'rounds.unreadableHint': 'the child log is damaged',
      'rounds.noLog': 'no log yet',
      'rounds.calls': '{calls} calls · in {input} / out {output}',
      'rounds.actualTitle': 'actual {actual} · declared {declared}',
      'rounds.declaredTitle': 'declared {declared} (the child log has no model yet)',
      'rounds.released': 'released',
      'rounds.releasedAt': 'released at {time}',
      'rounds.total': 'Shown: {count} · total {usd}',
      'rounds.note': 'One subagent, one session; this is its whole session',
      'json.edit': 'Edit the JSON directly',
      'foot.config': 'Config lives in $DSH_HOME/dmr.json; an edit applies to the next subagent.',
      'foot.check': 'Check: node doctor.js · node route-check.js --cost',
    }

    // ── 视觉 ────────────────────────────────────────────────────────────────
    const GRID = '96px minmax(150px,1fr) minmax(190px,1.3fr) 96px 128px'
    const ROUND_GRID = '64px minmax(150px,1fr) 84px minmax(150px,1.1fr) 52px'
    const S = {
      section: {
        // 上一段（来源信息）本身有下边距，这里再留 28 就成了两块空白；10 只够让分隔线不贴字。
        marginTop: 10, paddingTop: 12, borderTop: '1px solid rgba(127,127,127,.22)',
        display: 'flex', flexDirection: 'column', gap: 14, color: 'inherit',
      },
      title: { fontSize: 15, fontWeight: 600, letterSpacing: '.01em' },
      desc: { fontSize: 12.5, lineHeight: 1.7, opacity: 0.72, maxWidth: 720 },
      panel: { border: '1px solid rgba(127,127,127,.22)', borderRadius: 10, overflow: 'hidden', background: 'rgba(127,127,127,.04)' },
      head: {
        display: 'grid', gridTemplateColumns: GRID, gap: 10, alignItems: 'center', padding: '8px 14px',
        fontSize: 11.5, opacity: 0.6, borderBottom: '1px solid rgba(127,127,127,.18)',
      },
      liner: {
        display: 'grid', gridTemplateColumns: GRID, gap: 10, alignItems: 'center',
        padding: '10px 14px', borderBottom: '1px solid rgba(127,127,127,.1)',
      },
      roleCell: { display: 'flex', flexDirection: 'column', gap: 2 },
      roleName: { fontSize: 13, fontWeight: 500 },
      roleHint: { fontSize: 11, opacity: 0.55 },
      select: {
        width: '100%', boxSizing: 'border-box', padding: '6px 8px', fontSize: 12.5, borderRadius: 7,
        border: '1px solid rgba(127,127,127,.3)', background: 'rgba(127,127,127,.05)',
        color: 'inherit', cursor: 'pointer',
      },
      footer: { display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', flexWrap: 'wrap' },
      btn: {
        padding: '6px 14px', borderRadius: 7, fontSize: 12.5, cursor: 'pointer',
        border: '1px solid rgba(127,127,127,.35)', background: 'transparent', color: 'inherit',
      },
      btnPrimary: {
        padding: '6px 16px', borderRadius: 7, fontSize: 12.5, cursor: 'pointer',
        border: '1px solid transparent', background: '#3b82f6', color: '#fff', fontWeight: 500,
      },
      spacer: { flex: 1 },
      ok: { fontSize: 12, color: '#3c9d5d' },
      bad: { fontSize: 12, color: '#d9534f' },
      note: { fontSize: 11.5, opacity: 0.55, marginLeft: 4 },
      code: {
        fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 11.5,
        padding: '1px 5px', borderRadius: 4, background: 'rgba(127,127,127,.12)',
      },
      textarea: {
        fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 12,
        lineHeight: 1.55, width: '100%', boxSizing: 'border-box', padding: 10, borderRadius: 8,
        border: '1px solid rgba(127,127,127,.25)', background: 'rgba(127,127,127,.05)',
        color: 'inherit', resize: 'vertical', tabSize: 2, marginTop: 8,
      },
      summary: { fontSize: 12, cursor: 'pointer', opacity: 0.7, userSelect: 'none' },
      // 最近委派
      subHead: { display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 4 },
      subTitle: { fontSize: 13.5, fontWeight: 600 },
      subNote: { fontSize: 11.5, opacity: 0.55 },
      roundsHead: {
        display: 'grid', gridTemplateColumns: ROUND_GRID, gap: 10, padding: '7px 14px',
        fontSize: 11.5, opacity: 0.6, borderBottom: '1px solid rgba(127,127,127,.18)',
      },
      roundsRow: {
        display: 'grid', gridTemplateColumns: ROUND_GRID, gap: 10, padding: '9px 14px',
        borderBottom: '1px solid rgba(127,127,127,.1)', alignItems: 'center',
      },
      num: { fontVariantNumeric: 'tabular-nums', fontSize: 12.5 },
      dim: { fontSize: 11.5, opacity: 0.6 },
      clock: { display: 'flex', flexDirection: 'column', gap: 2 },
      released: { fontSize: 10.5, color: '#3c9d5d', whiteSpace: 'nowrap' },
      // 页面最底下那两行：配置在哪、怎么核对。插件页的其它区块由 DSH 渲染，这里是我们能放的最后一块。
      bottom: { display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11.5, opacity: 0.55, lineHeight: 1.7 },
    }

    // ── 数据 ────────────────────────────────────────────────────────────────
    function parse(text) {
      try {
        const parsed = JSON.parse(text)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: 'not-an-object' }
        return { table: parsed, error: null }
      } catch (error) {
        return { error: String(error?.message ?? error) }
      }
    }

    // ── 数字格式 ────────────────────────────────────────────────────────────
    function moneyOf(usd) {
      if (typeof usd !== 'number' || !Number.isFinite(usd)) return '—'
      if (usd === 0) return '$0'
      // 单次委派常常只有几厘钱：小数位给足，不然整列都是 $0.00。
      return usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`
    }

    function shortTokens(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '0'
      if (value < 1000) return String(Math.round(value))
      if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`
      return `${(value / 1_000_000).toFixed(1)}m`
    }

    function clockOf(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
      const at = new Date(ms)
      const pad = (value) => String(value).padStart(2, '0')
      if (at.toDateString() === new Date().toDateString()) return `${pad(at.getHours())}:${pad(at.getMinutes())}`
      return `${at.getMonth() + 1}/${at.getDate()}`
    }

    function withRole(text, role, patch) {
      const parsed = parse(text)
      const table = parsed.table ?? { roles: {} }
      const roles = { ...(table.roles ?? {}) }
      const next = { ...(roles[role] ?? {}), ...patch }
      for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key]
      roles[role] = next
      return JSON.stringify({ ...table, roles }, null, 2)
    }

    function RoleLine({ role, entry, providers, onChange, t }) {
      const provider = providers.find((item) => item.id === entry.provider)
      const models = provider?.models ?? []
      const model = models.find((item) => item.id === entry.model)
      const efforts = model?.efforts ?? []
      return h('div', { style: S.liner },
        h('div', { style: S.roleCell },
          h('span', { style: S.roleName }, t(`role.${role}`)),
          h('span', { style: S.roleHint }, t(`role.${role}Hint`)),
        ),
        h('select', {
          style: S.select,
          value: entry.provider ?? '',
          onChange: (event) => {
            const target = providers.find((item) => item.id === event.target.value)
            const first = target?.models?.[0]
            onChange({ provider: event.target.value, ...(first ? { model: first.id } : {}) })
          },
        },
          providers.length === 0 ? h('option', { value: entry.provider ?? '' }, entry.provider ?? '—') : null,
          providers.map((item) => h('option', { key: item.id, value: item.id }, item.name || item.id)),
        ),
        h('select', {
          style: S.select,
          value: entry.model ?? '',
          onChange: (event) => onChange({ model: event.target.value }),
        },
          models.length === 0 ? h('option', { value: entry.model ?? '' }, entry.model ?? '—') : null,
          models.map((item) => h('option', { key: item.id, value: item.id }, item.name || item.id)),
        ),
        h('select', {
          style: S.select,
          value: entry.effort ?? '',
          onChange: (event) => onChange({ effort: event.target.value || undefined }),
        },
          h('option', { value: '' }, t('effort.default')),
          (efforts.length > 0 ? efforts : ['off', 'low', 'high', 'max'])
            .map((effort) => h('option', { key: effort, value: effort }, effort)),
        ),
        h('select', {
          style: S.select,
          value: entry.lifecycle ?? 'continuable',
          title: t('lifecycle.hint'),
          onChange: (event) => onChange({ lifecycle: event.target.value }),
        },
          h('option', { value: 'continuable' }, t('lifecycle.continuable')),
          h('option', { value: 'one-shot' }, t('lifecycle.oneShot')),
        ),
      )
    }

    /** 一行委派记录：实际跑的模型、花了多少、多大上下文。 */
    function RoundRow({ row, t }) {
      const cost = row.cost ?? { status: 'missing' }
      const actual = cost.actual ?? null
      const declared = row.model
        ? `${row.provider ? `${row.provider}/` : ''}${row.model}${row.effort ? ` @${row.effort}` : ''}`
        : null
      const model = actual?.model ?? row.model
      const effort = actual?.effort ?? row.effort
      // 声明和实际不一致，正是 route-check 要抓的那件事：标红，别让它看起来正常。
      // 只在两边都写了同一项时才比，缺的那一侧不算「不一致」。
      const mismatch = Boolean(
        (row.model && actual?.model && row.model !== actual.model)
        || (row.provider && actual?.provider && row.provider !== actual.provider),
      )
      const route = model ? `${model}${effort ? ` @${effort}` : ''}` : t('rounds.inherited')
      const actualText = actual?.model
        ? `${actual.provider ?? '?'}/${actual.model}${actual.effort ? ` @${actual.effort}` : ''}`
        : null
      const title = actualText
        ? t('rounds.actualTitle', { actual: actualText, declared: declared ?? t('rounds.inherited') })
        : declared
          ? t('rounds.declaredTitle', { declared })
          : t('rounds.inherited')
      let costText
      let tokenText
      if (cost.status === 'ok') {
        costText = `${moneyOf(cost.usd)}${cost.unpriced ? '*' : ''}`
        tokenText = t('rounds.calls', {
          calls: cost.calls ?? 0,
          input: shortTokens(cost.input),
          output: shortTokens(cost.output),
        })
      } else if (cost.status === 'too-large') {
        costText = t('rounds.tooLarge')
        tokenText = t('rounds.tooLargeHint', { mb: Math.round((cost.bytes ?? 0) / 1024 / 1024) })
      } else if (cost.status === 'unreadable') {
        costText = t('rounds.unreadable')
        tokenText = t('rounds.unreadableHint')
      } else {
        costText = t('rounds.dash')
        tokenText = t('rounds.noLog')
      }
      return h('div', { style: S.roundsRow },
        h('span', { style: S.roleName }, row.role ? t(`role.${row.role}`) : t('role.unknown')),
        h('span', { style: mismatch ? { ...S.num, color: '#d9534f' } : S.num, title }, route),
        h('span', { style: S.num }, costText),
        h('span', { style: S.dim }, tokenText),
        h('span', { style: S.clock },
          h('span', { style: S.dim }, clockOf(row.at)),
          // 只标「日志里真的记着这次释放」的行：宿主重启前释放的 one-shot 没有记录，
          // 那就什么都不写，而不是猜一个「未释放」。
          row.releasedAt
            ? h('span', { style: S.released, title: t('rounds.releasedAt', { time: clockOf(row.releasedAt) }) }, t('rounds.released'))
            : null,
        ),
      )
    }

    // ── 页面 ────────────────────────────────────────────────────────────────
    function RoutePanel({ t }) {
      const [state, setState] = React.useState({ status: 'loading', path: '', text: '', message: null, error: null })
      const [catalog, setCatalog] = React.useState({ providers: [], error: null })
      const [rounds, setRounds] = React.useState({ status: 'loading', rows: [], error: null })

      const load = React.useCallback(async () => {
        setState((prev) => ({ ...prev, status: 'loading', error: null, message: null }))
        setRounds((prev) => ({ ...prev, status: 'loading', error: null }))
        try {
          const [configResponse, modelsResponse, roundsResponse] = await Promise.all([
            fetch(CONFIG, { headers: { accept: 'application/json' } }),
            fetch(MODELS, { headers: { accept: 'application/json' } }).catch(() => null),
            fetch(ROUNDS, { headers: { accept: 'application/json' } }).catch(() => null),
          ])
          const body = await configResponse.json()
          if (!configResponse.ok) throw new Error(body?.error ?? `HTTP ${configResponse.status}`)
          if (modelsResponse) {
            const models = await modelsResponse.json().catch(() => null)
            setCatalog(models?.providers
              ? { providers: models.providers, error: null }
              : { providers: [], error: models?.error ?? `HTTP ${modelsResponse.status}` })
          }
          if (roundsResponse) {
            const recent = await roundsResponse.json().catch(() => null)
            setRounds(roundsResponse.ok
              ? { status: 'ready', rows: Array.isArray(recent?.rounds) ? recent.rounds : [], error: null }
              : { status: 'ready', rows: [], error: recent?.error ?? `HTTP ${roundsResponse.status}` })
          } else {
            setRounds({ status: 'ready', rows: [], error: 'fetch failed' })
          }
          setState({ status: 'ready', path: body.path ?? '', text: body.text ?? '', message: null, error: null })
        } catch (error) {
          setState({ status: 'error', path: '', text: '', message: null, error: String(error?.message ?? error) })
        }
      }, [])

      React.useEffect(() => { void load() }, [load])

      const save = React.useCallback(async () => {
        setState((prev) => ({ ...prev, message: null, error: null }))
        try {
          const response = await fetch(CONFIG, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: state.text,
          })
          const body = await response.json()
          if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
          // 只存标记，渲染时再翻译：切换语言后这条提示也要跟着变。
          setState((prev) => ({ ...prev, path: body.path ?? prev.path, text: body.text ?? prev.text, message: 'saved' }))
        } catch (error) {
          setState((prev) => ({ ...prev, message: null, error: String(error?.message ?? error) }))
        }
      }, [state.text])

      const parsed = React.useMemo(() => parse(state.text), [state.text])
      const roles = parsed.table?.roles ?? {}
      const canSave = state.status === 'ready' && !parsed.error

      // 配置里的模型是否真的可用。派活时也会拦（index.mjs 的预检），但在这里提前
      // 标出来，省得等到那一轮跑到一半才发现表里写了个不存在的 id。
      const problems = []
      if (catalog.providers.length > 0) {
        for (const role of ROLES) {
          const entry = roles[role] ?? {}
          if (!entry.provider || !entry.model) continue
          const provider = catalog.providers.find((item) => item.id === entry.provider)
          if (!provider) {
            problems.push(t('problem.provider', { role: t(`role.${role}`), provider: entry.provider }))
            continue
          }
          const ids = (provider.models ?? []).map((item) => item.id)
          if (ids.length > 0 && !ids.includes(entry.model)) {
            problems.push(t('problem.model', {
              role: t(`role.${role}`),
              model: entry.model,
              provider: provider.id,
              list: ids.join(t('list.separator')),
            }))
            continue
          }
          const model = (provider.models ?? []).find((item) => item.id === entry.model)
          const efforts = (model?.efforts ?? [])
          if (entry.effort && efforts.length > 0 && !efforts.includes(entry.effort)) {
            problems.push(t('problem.effort', {
              role: t(`role.${role}`),
              effort: entry.effort,
              model: entry.model,
              list: efforts.join(t('list.separator')),
            }))
          }
        }
      }

      // 合计只加算得出来的行：读不出日志的那次不假装知道它花了多少。
      const spent = rounds.rows.reduce((sum, row) => sum + (row.cost?.status === 'ok' ? row.cost.usd : 0), 0)

      return h('section', { style: S.section },
        h('div', { style: S.title }, t('title')),
        h('div', { style: S.desc }, t('intro')),

        catalog.error
          ? h('div', { style: S.bad }, t('catalog.failed', { error: catalog.error }))
          : null,

        h('div', { style: S.panel },
          h('div', { style: S.head },
            h('span', null, t('col.phase')),
            h('span', null, t('col.provider')),
            h('span', null, t('col.model')),
            h('span', null, t('col.effort')),
            h('span', null, t('col.lifecycle')),
          ),
          ROLES.map((role) => h(RoleLine, {
            key: role,
            role,
            entry: roles[role] ?? {},
            providers: catalog.providers,
            t,
            onChange: (patch) => setState((prev) => ({
              ...prev,
              text: withRole(prev.text || '{"roles":{}}', role, patch),
              message: null,
              error: null,
            })),
          })),
          h('div', { style: S.footer },
            h('button', { type: 'button', style: S.btnPrimary, onClick: save, disabled: !canSave }, t('action.save')),
            h('button', { type: 'button', style: S.btn, onClick: load, disabled: state.status === 'loading' }, t('action.reload')),
            h('span', { style: S.spacer }),
            state.message ? h('span', { style: S.ok }, state.message === 'saved' ? t('state.saved') : state.message) : null,
            state.error ? h('span', { style: S.bad }, state.error) : null,
            parsed.error
              ? h('span', { style: S.bad }, t('state.invalidJson', {
                error: parsed.error === 'not-an-object' ? t('state.notObject') : parsed.error,
              }))
              : null,
          ),
        ),

        problems.length > 0
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              problems.map((text) => h('div', { key: text, style: S.bad }, t('problem.line', { text }))),
            )
          : null,

        // 最近委派：实际跑的模型和花费，全部来自子会话自己的日志。
        h('div', { style: S.subHead },
          h('span', { style: S.subTitle }, t('rounds.title')),
        ),
        rounds.error
          ? h('div', { style: S.bad }, t('rounds.failed', { error: rounds.error }))
          : null,
        h('div', { style: S.panel },
          h('div', { style: S.roundsHead },
            h('span', null, t('rounds.colPhase')),
            h('span', null, t('rounds.colModel')),
            h('span', null, t('rounds.colCost')),
            h('span', null, t('rounds.colCalls')),
            h('span', null, t('rounds.colTime')),
          ),
          rounds.rows.length === 0
            ? h('div', { style: { display: 'flex', padding: '10px 14px' } },
                h('span', { style: S.dim }, rounds.status === 'loading' ? t('rounds.loading') : t('rounds.empty')),
              )
            : rounds.rows.map((row, index) => h(RoundRow, { key: `${row.childId ?? 'row'}-${index}`, row, t })),
          rounds.rows.length > 0
            ? h('div', { style: S.footer },
                h('span', { style: S.dim }, t('rounds.total', { count: rounds.rows.length, usd: moneyOf(spent) })),
                h('span', { style: S.spacer }),
                h('span', { style: S.note }, t('rounds.note')),
              )
            : null,
        ),

        h('details', null,
          h('summary', { style: S.summary, title: state.path || '' }, t('json.edit')),
          h('textarea', {
            value: state.text,
            spellCheck: false,
            rows: 12,
            style: S.textarea,
            onChange: (event) => setState((prev) => ({ ...prev, text: event.target.value, message: null, error: null })),
          }),
        ),

        // 插件页最底下两行：配置在哪、怎么核对。正文里不再重复这些。
        h('div', { style: S.bottom },
          h('div', null, t('foot.config')),
          h('div', null, t('foot.check')),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // 官方的调度：先 bind 拿到本命名空间的 t，再用 effect 注册字典——注册在 UI 挂载
        // 之后也会被拾起，不需要重新挂载。bind 返回的函数每次调用都看当前语言，
        // 所以它既能给 slot label 用，也能当组件里的兜底。
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dmr: dictionaries')

        /**
         * 详情槽在每个插件页都会渲染一次；不是本插件就返回 null。
         * 文案优先用槽注入的 `t`（它随语言切换触发重渲染），没有就用上面那个绑定的。
         */
        const RouteSection = (props) => {
          let match = false
          try {
            match = JSON.stringify(props?.subject ?? null).includes('dsh-deepseek-model-route')
          } catch {
            match = false
          }
          if (!match) return null
          return h(RoutePanel, { t: typeof props?.t === 'function' ? props.t : t })
        }

        ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
          name: 'plugins.detail.section',
          id: 'dmr-route',
          order: 40,
          label: () => t('nav'),
          locale: NS,
        }, RouteSection))
      },
    }
  },
})
