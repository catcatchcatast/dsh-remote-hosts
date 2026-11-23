// Public change history: docs/PUBLIC-CHANGES.md
import { composerHistorySessionId } from './composer-history.js'

/** Let the official editor consume the current native selection before plain-text deletion. */
export function bindComposerDeleteSelection({ sessions, conversation }, doc = globalThis.document) {
  const view = doc?.defaultView
  if (!view) return () => {}
  const keydown = event => {
    if (!['Backspace', 'Delete'].includes(event.key) || event.isComposing || event.keyCode === 229) return
    const root = event.target instanceof view.Element ? event.target.closest('[data-composer-input]') : null
    if (!root || doc.activeElement !== root || root.getAttribute('contenteditable') !== 'true') return
    // Reference/entity composers retain their own native deletion semantics.
    if (root.querySelector('[contenteditable="false"], [data-composer-chip], [data-composer-text-ref]')) return
    const selection = doc.getSelection()
    if (!selection?.rangeCount || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return
    let editor
    try {
      const id = composerHistorySessionId(sessions.list)
      if (id === undefined) return
      editor = conversation.input.for(sessions.scope(id))?.editor
    } catch { return }
    if (typeof editor?.getRootElement !== 'function' || editor.getRootElement() !== root
      || typeof editor.isComposing !== 'function' || editor.isComposing()) return
    doc.dispatchEvent(new view.Event('selectionchange'))
  }
  view.addEventListener('keydown', keydown, true)
  return () => view.removeEventListener('keydown', keydown, true)
}
