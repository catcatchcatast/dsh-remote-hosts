
import { useState } from 'react'
import type { ReactElement } from 'react'
import { IconGlobeOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from '@deepseek-ai/dsh-client-locale/client'
import css from './DirectoryBrowser.module.css'

const LOCAL_HOST_ID = 'local'

interface HostOption {
  hostId: string
  label: string
}

interface HostBridge {
  getSelectedHost?: () => string | undefined
  setSelectedHost?: (hostId: string) => string | undefined
  getHosts?: () => unknown
}

type GlobalWithHostBridge = typeof globalThis & {
  __DSH_BROWSER_HOST_HUB__?: HostBridge
}

const localHost: HostOption = { hostId: LOCAL_HOST_ID, label: 'Local' }

function bridge(): HostBridge | undefined {
  return (globalThis as GlobalWithHostBridge).__DSH_BROWSER_HOST_HUB__
}

/** Read the page-local selection without creating a second global selector. */
export function selectedHostId(): string {
  const value = bridge()?.getSelectedHost?.()
  return typeof value === 'string' && value.length > 0 ? value : LOCAL_HOST_ID
}

/** Keep only the authenticated inventory's safe display fields. */
function normalizeHosts(value: unknown): HostOption[] {
  const rows = Array.isArray(value)
    ? value
    : value !== null && typeof value === 'object' && Array.isArray((value as { hosts?: unknown }).hosts)
      ? (value as { hosts: unknown[] }).hosts
      : []
  const seen = new Set<string>([LOCAL_HOST_ID])
  const result: HostOption[] = [localHost]
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const hostId = (row as { hostId?: unknown }).hostId
    const label = (row as { label?: unknown }).label
    if (typeof hostId !== 'string' || hostId.length === 0 || seen.has(hostId)) continue
    if (typeof label !== 'string' || label.trim().length === 0) continue
    seen.add(hostId)
    result.push({ hostId, label })
  }
  return result
}

export interface HostPickerProps {
  selectedHost: string
  disabled: boolean
  onSelectedHost: (hostId: string) => void
  t: Translate
}

/**
 * Host choice scoped to the New Project directory dialog.
 *
 * The browser hub owns selection and transport routing. This component only
 * displays its authenticated inventory and changes that page-local selection;
 * it deliberately does not mount a fixed or global Host control.
 */
export function HostPicker({ selectedHost, disabled, onSelectedHost, t }: HostPickerProps): ReactElement {
  const [hosts] = useState<HostOption[]>(() => normalizeHosts(bridge()?.getHosts?.()))
  const [error, setError] = useState<string | null>(null)

  const choose = (hostId: string): void => {
    const current = bridge()
    if (current?.setSelectedHost === undefined) {
      setError(t('browser.hostUnavailable'))
      return
    }
    try {
      current.setSelectedHost(hostId)
      onSelectedHost(hostId)
      setError(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  // Keep the page-local route visible when a previously selected remote Host
  // has just gone offline. The bootstrap inventory is
  // authoritative for normal choices, but hiding the active route would make
  // the list say Local while directory calls still target the remote Host.
  const visibleHosts = hosts.some(host => host.hostId === selectedHost) || selectedHost === LOCAL_HOST_ID
    ? hosts
    : [...hosts, { hostId: selectedHost, label: selectedHost }]

  return (
    <div className={css.hostPicker} data-dsh-directory-host-picker="">
      <div className={css.hostPickerLabel}>{t('browser.host')}</div>
      <div className={css.hostPickerField}>
        <IconGlobeOutline14 size={16} />
        <select
          className={css.hostSelect}
          value={selectedHost}
          disabled={disabled}
          aria-label={t('browser.host')}
          onChange={event => { choose(event.target.value) }}
        >
          {visibleHosts.map(host => <option key={host.hostId} value={host.hostId}>{host.label}</option>)}
        </select>
      </div>
      <div className={css.hostStatus} role="status" aria-live="polite">
        {error ?? t('browser.hostHint')}
      </div>
    </div>
  )
}
