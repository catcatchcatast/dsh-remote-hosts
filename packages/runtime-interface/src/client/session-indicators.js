// Public change history: docs/PUBLIC-CHANGES.md
import { createElement, Fragment, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'

/** Render the official indicator through the EXISTING application React root.
 * This roster contains only DOM targets; session facts stay in uiSession. */
export function installSessionIndicators(slots, presentation) {
  let targets = [], active = true
  const listeners = new Set()
  const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener) }
  const Component = () => {
    const rows = useSyncExternalStore(subscribe, () => targets)
    return createElement(Fragment, null, rows.map(({ id, element }, index) => {
      const value = presentation.get(id)
      return value && value.state !== 'idle' ? createPortal(createElement(StateDot, { state: value.state }), element, `${id}:${index}`) : null
    }))
  }
  const stop = slots.inject('shell.overlay', () => slots.register({ name: 'shell.overlay', id: 'sidebar-session-indicators', inject: () => ({}) }, Component))
  return Object.freeze({
    render(rows) { if (!active) return; targets = rows; for (const listener of listeners) listener() },
    dispose() { if (!active) return; active = false; stop(); targets = []; listeners.clear() },
  })
}
