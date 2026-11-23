// Public change history: docs/PUBLIC-CHANGES.md
import { createElement } from 'react'

const holes = ['conversation.hero.workspace.directoryFlow', 'sidebar.workspaces.directoryFlow']
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = () => Object.assign(new Error('Directory browser is unavailable'), { code: 'DIRECTORY_UNAVAILABLE' })
const pathValue = value => { if (typeof value !== 'string' || !value || value.includes('\0')) throw fail(); return value }
const publicDirectoryErrors = new Set(['directory-unreadable', 'directory-exists', 'directory-create-failed'])
const cancelledError = () => new DOMException('Directory operation cancelled', 'AbortError')
function directoryFailure(error, cancelled = false) {
  if (cancelled) return cancelledError()
  const problem = error?.rpcError
  if (record(problem) && publicDirectoryErrors.has(problem.code) && typeof problem.message === 'string' && problem.message.length <= 2048) {
    return Object.assign(new Error(problem.message), { code: problem.code })
  }
  return fail()
}
function entryValue(row) {
  if (!record(row) || typeof row.name !== 'string' || typeof row.hidden !== 'boolean') throw fail()
  return Object.freeze({ name: row.name, path: pathValue(row.path), hidden: row.hidden })
}
export function directoryListingValue(value) {
  if (!record(value) || !Array.isArray(value.crumbs) || !Array.isArray(value.entries) || typeof value.truncated !== 'boolean') throw fail()
  return Object.freeze({ path: pathValue(value.path), home: pathValue(value.home),
    crumbs: Object.freeze(value.crumbs.map(entryValue)), entries: Object.freeze(value.entries.map(entryValue)), truncated: value.truncated,
    ...(value.roots === undefined ? {} : { roots: Object.freeze(Array.isArray(value.roots) ? value.roots.map(entryValue) : (()=>{ throw fail() })()) }) })
}

/** Official slot owners, directory wire values and page-host identity stay here. */
export function createDirectoryPickerClient({ slots, uiWorkspace, locale, getBridge = () => globalThis.__DSH_BROWSER_HOST_HUB__ }) {
  return Object.freeze({
    install({ component, dictionaries, namespace = 'directory-browser' }) {
      if (typeof component !== 'function' || !Array.isArray(dictionaries)) throw new TypeError('directory dialog policy is required')
      let active = true
      const controllers = new Set(), disposers = []
      const stop = () => { if (!active) return; active = false; for (const controller of controllers) controller.abort(); for (const dispose of disposers.reverse()) dispose?.() }
      const requireActive = () => { if (!active) throw new DOMException('Directory dialog unmounted', 'AbortError') }
      const selectedHost = () => { requireActive(); const id = getBridge()?.getSelectedHost?.(); return typeof id === 'string' && id ? id : 'local' }
      const hosts = () => {
        requireActive()
        const raw = getBridge()?.getHosts?.(), rows = Array.isArray(raw) ? raw : raw?.hosts
        const seen = new Set(['local']), result = [{ hostId: 'local', label: 'Local' }]
        for (const row of Array.isArray(rows) ? rows : []) if (record(row) && typeof row.hostId === 'string' && row.hostId && !seen.has(row.hostId) && typeof row.label === 'string' && row.label.trim()) {
          seen.add(row.hostId); result.push(Object.freeze({ hostId: row.hostId, label: row.label }))
        }
        return Object.freeze(result)
      }
      const selectHost = hostId => {
        requireActive(); pathValue(hostId)
        const bridge = getBridge()
        if (typeof bridge?.setSelectedHost !== 'function') throw fail()
        try { bridge.setSelectedHost(hostId) } catch { throw fail() }
      }
      const listDirectory = async (path, signal) => {
        requireActive(); if (signal?.aborted) throw cancelledError(); if (path !== undefined) pathValue(path)
        const controller = new AbortController(); controllers.add(controller)
        const abort = () => controller.abort(signal.reason)
        signal?.addEventListener('abort', abort, { once: true })
        let rejectAbort
        const cancelled = new Promise((_, reject) => { rejectAbort = () => reject(controller.signal.reason); controller.signal.addEventListener('abort', rejectAbort, { once: true }) })
        try {
          const value = await Promise.race([uiWorkspace.listDirectory(path, controller.signal), cancelled])
          controller.signal.throwIfAborted(); requireActive(); return directoryListingValue(value)
        } catch (error) { throw directoryFailure(error, controller.signal.aborted || signal?.aborted === true || !active) }
        finally { controllers.delete(controller); signal?.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', rejectAbort) }
      }
      const createDirectory = async (path, name) => {
        requireActive(); pathValue(path); pathValue(name)
        try { const value = await uiWorkspace.createDirectory(path, name); requireActive(); return pathValue(value) }
        catch (error) { throw directoryFailure(error, !active) }
      }
      try {
        for (const [language, dictionary] of dictionaries) disposers.push(locale.register(namespace, language, dictionary))
        // Hub pages must keep host-aware browsing, including a desktop Hub.
        // Standalone desktop pages retain the actual native chooser as winner.
        const priority = getBridge() || typeof globalThis.__DSH_DIRECTORY_PICKER__?.pick !== 'function' ? -1 : 1
        const stable = Object.freeze({ listDirectory, createDirectory, t: locale.bind(namespace), selectedHost, hosts, selectHost })
        const occupant = props => {
          requireActive()
          if (typeof props.open !== 'boolean' || typeof props.busy !== 'boolean' || typeof props.onPicked !== 'function' || typeof props.onCancel !== 'function') throw fail()
          return createElement(component, { ...stable, open: props.open, busy: props.busy,
            onPicked: path => { requireActive(); props.onPicked(pathValue(path)) }, onCancel: () => { requireActive(); props.onCancel() } })
        }
        disposers.push(slots.inject(holes[0], () => slots.inject(holes[1], function* () {
          for (const name of holes) yield slots.register({ name, priority, inject: () => ({}) }, occupant)
        })))
        return stop
      } catch (error) { stop(); throw error }
    },
  })
}
