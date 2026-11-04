window.__ModuleLoader__.load({
  id: 'dsh-deepseek-model-route',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const ENDPOINT = '/plugins/dsh-deepseek-model-route/config'
    const ROLES = ['plan', 'impl', 'review']

    const box = { display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 2px 16px', color: 'inherit' }
    const muted = { opacity: 0.7, fontSize: 12, lineHeight: 1.6 }
    const row = { display: 'flex', gap: 8, alignItems: 'center' }
    const button = {
      padding: '5px 12px', borderRadius: 6, cursor: 'pointer',
      border: '1px solid rgba(127,127,127,.45)', background: 'transparent', color: 'inherit', fontSize: 13,
    }
    const mono = {
      fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 12, lineHeight: 1.5,
      width: '100%', boxSizing: 'border-box', padding: 10, borderRadius: 6,
      border: '1px solid rgba(127,127,127,.45)', background: 'rgba(127,127,127,.06)', color: 'inherit',
      resize: 'vertical', tabSize: 2,
    }
    const bad = { color: '#d9534f', fontSize: 12 }
    const ok = { color: '#3c9d5d', fontSize: 12 }

    function summarize(text) {
      try {
        const parsed = JSON.parse(text)
        const roles = parsed?.roles ?? {}
        return { roles, error: null }
      } catch (error) {
        return { roles: null, error: String(error?.message ?? error) }
      }
    }

    function RoutePage() {
      const [state, setState] = React.useState({ status: 'loading', path: '', text: '', message: null, error: null })

      const load = React.useCallback(async () => {
        setState((prev) => ({ ...prev, status: 'loading', error: null, message: null }))
        try {
          const response = await fetch(ENDPOINT, { headers: { accept: 'application/json' } })
          const body = await response.json()
          if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
          setState({
            status: 'ready',
            path: body.path ?? '',
            text: body.text ?? '',
            message: body.exists ? null : '还没有 dmr.json，保存一次就会创建。',
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
          const response = await fetch(ENDPOINT, {
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

      const summary = React.useMemo(() => summarize(state.text), [state.text])

      return h('div', { style: box },
        h('div', { style: { fontSize: 14, fontWeight: 600 } }, '路由表'),
        h('div', { style: muted },
          '每次派活都会重新读这份文件，所以保存后**下一个子代理**就生效，不需要重装插件。',
          h('br'),
          '文件：', h('code', null, state.path || '(未知)'),
        ),
        summary.roles
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
              ROLES.map((role) => {
                const entry = summary.roles[role]
                const text = entry && entry.model
                  ? `${entry.provider ?? '?'} / ${entry.model}${entry.effort ? ` @${entry.effort}` : ''}`
                  : '继承父会话'
                return h('div', { key: role, style: { fontSize: 13 } },
                  h('span', { style: { display: 'inline-block', width: 64, opacity: 0.75 } }, role),
                  text,
                )
              }),
            )
          : null,
        h('textarea', {
          value: state.text,
          spellCheck: false,
          rows: 14,
          style: mono,
          onChange: (event) => setState((prev) => ({ ...prev, text: event.target.value, message: null, error: null })),
        }),
        summary.error ? h('div', { style: bad }, `JSON 不合法：${summary.error}`) : null,
        state.message ? h('div', { style: ok }, state.message) : null,
        state.error ? h('div', { style: bad }, state.error) : null,
        h('div', { style: row },
          h('button', { type: 'button', style: button, onClick: load, disabled: state.status === 'loading' }, '重新读取'),
          h('button', { type: 'button', style: button, onClick: save, disabled: Boolean(summary.error) }, '保存'),
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
