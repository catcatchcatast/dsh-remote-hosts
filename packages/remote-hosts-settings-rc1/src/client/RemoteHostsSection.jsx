import { useCallback, useEffect, useRef, useState } from 'react'

const card = {
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 12,
  padding: '12px 14px',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
}
const row = { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }
const button = {
  font: 'inherit',
  padding: '4px 10px',
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-secondary, transparent)',
  color: 'var(--dsw-alias-label-primary)',
  cursor: 'pointer',
}
const input = {
  font: 'inherit',
  padding: '4px 8px',
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'transparent',
  color: 'inherit',
  colorScheme: 'light dark',
}
const muted = { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }
const optionStyle = { color: 'var(--dsw-alias-label-primary, #222)', background: 'var(--dsw-alias-bg-base, #fff)' }


function errorText(t, code) {
  if (!code) return ''
  const key = `error_${code}`
  const text = t(key)
  return text === key ? t('error_HOST_UNAVAILABLE') : text
}

function HostCard({ host, t, busy, onAction, onEdit }) {
  const state = t(`state_${host.state}`) === `state_${host.state}` ? host.state : t(`state_${host.state}`)
  return (
    <section style={card}>
      <div style={row}>
        <span style={{
          width: 8, height: 8, borderRadius: '50%',
          background: host.state === 'connected' ? 'var(--dsw-alias-success, #3c3)' : 'var(--dsw-alias-label-tertiary)',
        }} />
        <strong>{host.kind === 'local' ? t('local') : host.label}</strong>
        <span style={muted}>{state}</span>
      </div>
      {host.kind === 'remote' && (
        <p style={muted}>
          {host.alias} · 127.0.0.1:{host.localPort} → 127.0.0.1:{host.remotePort} · {host.launch}
        </p>
      )}
      {host.kind === 'local' && <p style={muted}>127.0.0.1:{host.localPort}</p>}
      <p style={muted}>{host.helperReadable ? t('helperYes') : t('helperNo')}</p>
      {host.lastError && <p style={muted}>{errorText(t, host.lastError)}</p>}
      {host.kind === 'local' && (
        <div style={row}>
          <button
            type="button"
            style={button}
            disabled={busy || !host.restartAvailable}
            title={host.restartAvailable ? undefined : t('localRestartUnavailable')}
            onClick={() => onAction('restart', host)}
          >
            {t('restart')}
          </button>
        </div>
      )}
      {host.kind === 'remote' && (
        <div style={row}>
          <button type="button" style={button} disabled={busy} onClick={() => onEdit(host)}>{t('edit')}</button>
          <button type="button" style={button} disabled={busy} onClick={() => onAction('retry', host)}>{t('retry')}</button>
          <button type="button" style={button} disabled={busy} onClick={() => onAction('disconnect', host)}>{t('disconnect')}</button>
          <button
            type="button"
            style={button}
            disabled={busy || !host.restartAvailable}
            title={host.restartAvailable ? undefined : t('restartUnavailable')}
            onClick={() => onAction('restart', host)}
          >
            {t('restart')}
          </button>
          <button type="button" style={button} disabled={busy} onClick={() => onAction('remove', host)}>{t('remove')}</button>
        </div>
      )}
    </section>
  )
}

export function RemoteHostsSection({ hostsApi, t }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [aliases, setAliases] = useState([])
  const [draft, setDraft] = useState(null)
  const [editingId, setEditingId] = useState(null)
  const requests = useRef({ live: true, generation: 0, refreshing: false, mutating: false })

  const refresh = useCallback(async () => {
    const state = requests.current
    if (!state.live || state.refreshing || state.mutating) return
    state.refreshing = true
    const generation = state.generation
    try {
      const value = await hostsApi.call('status')
      if (!state.live || generation !== state.generation) return
      setData(value)
      setError('')
    } catch (reason) {
      if (!state.live || generation !== state.generation) return
      setError(errorText(t, reason.code ?? reason.message))
    } finally {
      state.refreshing = false
    }
  }, [hostsApi, t])

  useEffect(() => {
    requests.current.live = true
    void refresh()
    const timer = setInterval(() => { void refresh() }, 4000)
    return () => {
      clearInterval(timer)
      requests.current.live = false
      requests.current.generation++
    }
  }, [refresh])

  const run = async (endpoint, payload, confirmText) => {
    const state = requests.current
    if (!state.live || state.mutating) return false
    if (confirmText && !window.confirm(confirmText)) return false
    state.mutating = true
    const generation = ++state.generation
    setBusy(true)
    try {
      const value = await hostsApi.call(endpoint, payload)
      if (!state.live || generation !== state.generation) return false
      setData(value)
      setError('')
      return true
    } catch (reason) {
      if (!state.live || generation !== state.generation) return false
      setError(errorText(t, reason.code ?? reason.message))
      return false
    } finally {
      state.mutating = false
      if (state.live) setBusy(false)
    }
  }

  const openAdd = async () => {
    const state = requests.current
    if (!state.live || state.mutating) return
    const generation = state.generation
    try {
      const listed = await hostsApi.call('discoverAliases')
      if (!state.live || generation !== state.generation) return
      setAliases(listed.aliases ?? [])
      setEditingId(null)
      setDraft({
        alias: listed.aliases?.[0] ?? '',
        label: listed.aliases?.[0] ?? '',
        localPort: data?.suggestedLocalPort ?? 33080,
        remotePort: 3080,
        launch: 'none',
      })
      setError('')
    } catch (reason) {
      if (!state.live || generation !== state.generation) return
      setError(errorText(t, reason.code ?? reason.message))
    }
  }

  const openEdit = host => {
    setEditingId(host.id)
    setDraft({
      alias: host.alias,
      label: host.label,
      localPort: host.localPort,
      remotePort: host.remotePort,
      launch: host.launch,
      enabled: host.enabled,
    })
  }

  const saveDraft = async () => {
    if (!draft || (editingId === null && !draft.alias)) return
    const endpoint = editingId === null ? 'add' : 'update'
    const payload = editingId === null ? draft : { ...draft, hostId: editingId }
    if (await run(endpoint, payload)) {
      setDraft(null)
      setEditingId(null)
    }
  }

  const onAction = (action, host) => {
    if (action === 'restart') return run('restart', { hostId: host.id }, t('restartConfirm').replace('{label}', host.label))
    if (action === 'remove') return run('remove', { hostId: host.id }, t('removeConfirm').replace('{label}', host.label))
    return run(action, { hostId: host.id })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 640, color: 'var(--dsw-alias-label-primary)' }}>
      <h2 style={{ margin: 0, fontSize: 16 }}>{t('title')}</h2>
      <p style={muted}>{t('intro')}</p>
      {error && <p style={muted}>{error}</p>}
      {(data?.hosts ?? []).map(host => (
        <HostCard key={host.id} host={host} t={t} busy={busy} onAction={onAction} onEdit={openEdit} />
      ))}
      {draft ? (
        <section style={card}>
          <strong>{editingId === null ? t('add') : t('edit')}</strong>
          {editingId === null && aliases.length === 0 ? <p style={muted}>{t('emptyAliases')}</p> : (
            <>
              {editingId === null ? (
                <label style={muted}>{t('alias')}
                  <select style={{ ...input, marginLeft: 8 }} value={draft.alias} onChange={event => setDraft({ ...draft, alias: event.target.value, label: draft.label || event.target.value })}>
                    {aliases.map(alias => <option key={alias} value={alias} style={optionStyle}>{alias}</option>)}
                  </select>
                </label>
              ) : <p style={muted}>{t('alias')}: {draft.alias}</p>}
              <label style={muted}>{t('label')}
                <input style={{ ...input, marginLeft: 8 }} value={draft.label} onChange={event => setDraft({ ...draft, label: event.target.value })} />
              </label>
              <label style={muted}>{t('localPort')}
                <input style={{ ...input, marginLeft: 8, width: 80 }} type="number" value={draft.localPort} onChange={event => setDraft({ ...draft, localPort: Number(event.target.value) })} />
              </label>
              <label style={muted}>{t('remotePort')}
                <input style={{ ...input, marginLeft: 8, width: 80 }} type="number" value={draft.remotePort} onChange={event => setDraft({ ...draft, remotePort: Number(event.target.value) })} />
              </label>
              <label style={muted}>{t('launch')}
                <select style={{ ...input, marginLeft: 8 }} value={draft.launch} onChange={event => setDraft({ ...draft, launch: event.target.value })}>
                  <option value="none" style={optionStyle}>{t('launchNone')}</option>
                  <option value="systemd-user" style={optionStyle}>{t('launchSystemd')}</option>
                </select>
              </label>
            </>
          )}
          <div style={row}>
            <button type="button" style={button} disabled={busy || (editingId === null && !draft.alias)} onClick={() => { void saveDraft() }}>{t('save')}</button>
            <button type="button" style={button} disabled={busy} onClick={() => { setDraft(null); setEditingId(null) }}>{t('cancel')}</button>
          </div>
        </section>
      ) : (
        <button type="button" disabled={busy} style={{ ...button, alignSelf: 'flex-start' }} onClick={() => { void openAdd() }}>{t('add')}</button>
      )}
    </div>
  )
}
