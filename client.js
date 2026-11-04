window.__ModuleLoader__.load({
  id: 'dsh-deepseek-model-route',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const CONFIG = '/plugins/dsh-deepseek-model-route/config'
    const MODELS = '/plugins/dsh-deepseek-model-route/models'
    const ROLES = ['plan', 'impl', 'review']
    const ROLE_LABEL = { plan: '规划', impl: '实现', review: '审查' }
    const ROLE_HINT = { plan: '读代码出方案', impl: '改文件的主力', review: '只读、找缺陷' }

    // ── 视觉 ────────────────────────────────────────────────────────────────
    const GRID = '96px minmax(150px,1fr) minmax(190px,1.3fr) 96px 128px'
    const S = {
      section: {
        marginTop: 28, paddingTop: 20, borderTop: '1px solid rgba(127,127,127,.22)',
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
    }

    // ── 数据 ────────────────────────────────────────────────────────────────
    function parse(text) {
      try {
        const parsed = JSON.parse(text)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: '顶层必须是一个对象' }
        return { table: parsed, error: null }
      } catch (error) {
        return { error: String(error?.message ?? error) }
      }
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

    function RoleLine({ role, entry, providers, onChange }) {
      const provider = providers.find((item) => item.id === entry.provider)
      const models = provider?.models ?? []
      const model = models.find((item) => item.id === entry.model)
      const efforts = model?.efforts ?? []
      return h('div', { style: S.liner },
        h('div', { style: S.roleCell },
          h('span', { style: S.roleName }, ROLE_LABEL[role] ?? role),
          h('span', { style: S.roleHint }, ROLE_HINT[role] ?? ''),
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
          h('option', { value: '' }, '默认'),
          (efforts.length > 0 ? efforts : ['off', 'low', 'high', 'max'])
            .map((effort) => h('option', { key: effort, value: effort }, effort)),
        ),
        h('select', {
          style: S.select,
          value: entry.lifecycle ?? 'continuable',
          title: '可续跑：跑完仍可用 send_message 续同一个子代理。交付即释放：拿到结果就释放激活，之后续跑要走冷恢复。',
          onChange: (event) => onChange({ lifecycle: event.target.value }),
        },
          h('option', { value: 'continuable' }, '可续跑'),
          h('option', { value: 'one-shot' }, '交付即释放'),
        ),
      )
    }

    // ── 页面 ────────────────────────────────────────────────────────────────
    function RoutePanel() {
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
          setState((prev) => ({ ...prev, path: body.path ?? prev.path, text: body.text ?? prev.text, message: '已保存，下一个子代理生效。' }))
        } catch (error) {
          setState((prev) => ({ ...prev, message: null, error: String(error?.message ?? error) }))
        }
      }, [state.text])

      const parsed = React.useMemo(() => parse(state.text), [state.text])
      const roles = parsed.table?.roles ?? {}
      const canSave = state.status === 'ready' && !parsed.error

      return h('section', { style: S.section },
        h('div', { style: S.title }, '阶段路由'),
        h('div', { style: S.desc },
          '三个阶段的子代理各走各的模型。每次派活都会重新读这份配置，所以保存后下一个子代理就生效，不需要重装。下拉里的选项来自运行时真实可用的模型。',
          h('br'),
          '配置文件：', h('code', { style: S.code }, state.path || '读取中…'),
          h('span', { style: S.note }, '默认取 DSH_HOME 环境变量，不是写死的路径'),
        ),

        catalog.error
          ? h('div', { style: S.bad }, `模型目录读不出来：${catalog.error}。下拉不可用，但可以展开下面的 JSON 直接改。`)
          : null,

        h('div', { style: S.panel },
          h('div', { style: S.head },
            h('span', null, '阶段'),
            h('span', null, '供应商'),
            h('span', null, '模型'),
            h('span', null, '推理强度'),
            h('span', null, '生命周期'),
          ),
          ROLES.map((role) => h(RoleLine, {
            key: role,
            role,
            entry: roles[role] ?? {},
            providers: catalog.providers,
            onChange: (patch) => setState((prev) => ({
              ...prev,
              text: withRole(prev.text || '{"roles":{}}', role, patch),
              message: null,
              error: null,
            })),
          })),
          h('div', { style: S.footer },
            h('button', { type: 'button', style: S.btnPrimary, onClick: save, disabled: !canSave }, '保存'),
            h('button', { type: 'button', style: S.btn, onClick: load, disabled: state.status === 'loading' }, '重新读取'),
            h('span', { style: S.spacer }),
            state.message ? h('span', { style: S.ok }, state.message) : null,
            state.error ? h('span', { style: S.bad }, state.error) : null,
            parsed.error ? h('span', { style: S.bad }, `JSON 不合法：${parsed.error}`) : null,
          ),
        ),

        h('details', null,
          h('summary', { style: S.summary }, '直接编辑 JSON'),
          h('textarea', {
            value: state.text,
            spellCheck: false,
            rows: 12,
            style: S.textarea,
            onChange: (event) => setState((prev) => ({ ...prev, text: event.target.value, message: null, error: null })),
          }),
        ),
      )
    }

    /** The detail slot draws one entry on every plugin page; stay silent for other subjects. */
    function RouteSection(props) {
      let match = false
      try {
        match = JSON.stringify(props?.subject ?? null).includes('dsh-deepseek-model-route')
      } catch {
        match = false
      }
      return match ? h(RoutePanel) : null
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
          name: 'plugins.detail.section',
          id: 'dmr-route',
          order: 40,
          label: '模型路由',
        }, RouteSection))
      },
    }
  },
})
