window.__ModuleLoader__.load({
  id: 'dsh-deepseek-model-route',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const CONFIG = '/plugins/dsh-deepseek-model-route/config'
    const MODELS = '/plugins/dsh-deepseek-model-route/models'
    const ROLES = ['plan', 'impl', 'review']
    const ROLE_LABEL = { plan: '规划', impl: '实现', review: '审查' }

    const box = { display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 2px 20px', color: 'inherit' }
    const muted = { opacity: 0.7, fontSize: 12, lineHeight: 1.6 }
    const row = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }
    const button = {
      padding: '5px 12px', borderRadius: 6, cursor: 'pointer',
      border: '1px solid rgba(127,127,127,.45)', background: 'transparent', color: 'inherit', fontSize: 13,
    }
    const select = {
      padding: '4px 6px', borderRadius: 6, border: '1px solid rgba(127,127,127,.45)',
      background: 'transparent', color: 'inherit', fontSize: 13, minWidth: 150,
    }
    const mono = {
      fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 12, lineHeight: 1.5,
      width: '100%', boxSizing: 'border-box', padding: 10, borderRadius: 6,
      border: '1px solid rgba(127,127,127,.45)', background: 'rgba(127,127,127,.06)', color: 'inherit',
      resize: 'vertical', tabSize: 2,
    }
    const bad = { color: '#d9534f', fontSize: 12 }
    const okText = { color: '#3c9d5d', fontSize: 12 }

    function parse(text) {
      try {
        const parsed = JSON.parse(text)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: '顶层必须是一个对象' }
        return { table: parsed, error: null }
      } catch (error) {
        return { error: String(error?.message ?? error) }
      }
    }

    /** Rewrite one role in the JSON text so every control keeps a single source of truth. */
    function withRole(text, role, patch) {
      const parsed = parse(text)
      const table = parsed.table ?? { roles: {} }
      const roles = { ...(table.roles ?? {}) }
      roles[role] = { ...(roles[role] ?? {}), ...patch }
      return JSON.stringify({ ...table, roles }, null, 2)
    }

    function RoleRow({ role, entry, providers, onChange }) {
      const provider = providers.find((item) => item.id === entry.provider)
      const models = provider?.models ?? []
      const model = models.find((item) => item.id === entry.model)
      const efforts = model?.efforts ?? []
      return h('div', { style: { ...row, gap: 10 } },
        h('span', { style: { width: 42, opacity: 0.8, fontSize: 13 } }, ROLE_LABEL[role] ?? role),
        h('select', {
          style: select,
          value: entry.provider ?? '',
          onChange: (event) => {
            const next = event.target.value
            const target = providers.find((item) => item.id === next)
            const first = target?.models?.[0]
            onChange({ provider: next, ...(first ? { model: first.id, ...(first.defaultEffort ? { effort: first.defaultEffort } : {}) } : {}) })
          },
        },
          providers.length === 0 ? h('option', { value: entry.provider ?? '' }, entry.provider ?? '—') : null,
          providers.map((item) => h('option', { key: item.id, value: item.id }, item.name || item.id)),
        ),
        h('select', {
          style: { ...select, minWidth: 210 },
          value: entry.model ?? '',
          onChange: (event) => {
            const next = models.find((item) => item.id === event.target.value)
            onChange({ model: event.target.value, ...(next?.defaultEffort ? { effort: next.defaultEffort } : {}) })
          },
        },
          models.length === 0 ? h('option', { value: entry.model ?? '' }, entry.model ?? '—') : null,
          models.map((item) => h('option', { key: item.id, value: item.id }, item.name || item.id)),
        ),
        h('select', {
          style: { ...select, minWidth: 96 },
          value: entry.effort ?? '',
          onChange: (event) => onChange({ effort: event.target.value || undefined }),
        },
          h('option', { value: '' }, 'effort 默认'),
          (efforts.length > 0 ? efforts : ['off', 'low', 'high', 'max']).map((effort) => h('option', { key: effort, value: effort }, effort)),
        ),
      )
    }

    function RoutePage() {
      const [state, setState] = React.useState({ status: 'loading', path: '', text: '', message: null, error: null })
      const [catalog, setCatalog] = React.useState({ providers: [], error: null })

      const load = React.useCallback(async () => {
        setState((prev) => ({ ...prev, status: 'loading', error: null, message: null }))
        try {
          const [configResponse, modelsResponse] = await Promise.all([
            fetch(CONFIG, { headers: { accept: 'application/json' } }),
            fetch(MODELS, { headers: { accept: 'application/json' } }).catch(() => null),
          ])
          const body = await configResponse.json()
          if (!configResponse.ok) throw new Error(body?.error ?? `HTTP ${configResponse.status}`)
          if (modelsResponse) {
            const models = await modelsResponse.json().catch(() => null)
            setCatalog(models?.providers
              ? { providers: models.providers, error: null }
              : { providers: [], error: models?.error ?? `HTTP ${modelsResponse.status}` })
          }
          setState({
            status: 'ready',
            path: body.path ?? '',
            text: body.text ?? '',
            message: body.exists ? null : '还没有 dmr.json，选一次并保存即可创建。',
            error: null,
          })
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
          setState((prev) => ({ ...prev, path: body.path ?? prev.path, text: body.text ?? prev.text, message: '已保存，下一个子代理就用新路由。' }))
        } catch (error) {
          setState((prev) => ({ ...prev, message: null, error: String(error?.message ?? error) }))
        }
      }, [state.text])

      const parsed = React.useMemo(() => parse(state.text), [state.text])
      const roles = parsed.table?.roles ?? {}

      return h('div', { style: box },
        h('div', { style: { fontSize: 14, fontWeight: 600 } }, '路由表'),
        h('div', { style: muted },
          '选项来自运行时真实可用的模型（不是手填的字符串）。保存后**下一个子代理**生效，不用重装。',
          h('br'),
          '文件：', h('code', null, state.path || '(未知)'),
        ),

        catalog.error
          ? h('div', { style: bad }, `模型目录读不出来：${catalog.error}（下拉不可用，仍可直接改下面的 JSON）`)
          : null,

        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          ROLES.map((role) => h(RoleRow, {
            key: role,
            role,
            entry: roles[role] ?? {},
            providers: catalog.providers,
            onChange: (patch) => setState((prev) => ({ ...prev, text: withRole(prev.text || '{"roles":{}}', role, patch), message: null })),
          })),
        ),

        h('details', { style: { fontSize: 13 } },
          h('summary', { style: { cursor: 'pointer', opacity: 0.8 } }, '直接编辑 JSON'),
          h('textarea', {
            value: state.text,
            spellCheck: false,
            rows: 12,
            style: { ...mono, marginTop: 8 },
            onChange: (event) => setState((prev) => ({ ...prev, text: event.target.value, message: null, error: null })),
          }),
        ),

        parsed.error ? h('div', { style: bad }, `JSON 不合法：${parsed.error}`) : null,
        state.message ? h('div', { style: okText }, state.message) : null,
        state.error ? h('div', { style: bad }, state.error) : null,

        h('div', { style: row },
          h('button', { type: 'button', style: button, onClick: load, disabled: state.status === 'loading' }, '重新读取'),
          h('button', { type: 'button', style: button, onClick: save, disabled: Boolean(parsed.error) }, '保存'),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
          name: 'settings.plugins.tab',
          id: 'dmr-route',
          order: 40,
          label: 'DeepSeek Model Route',
        }, RoutePage))
      },
    }
  },
})
