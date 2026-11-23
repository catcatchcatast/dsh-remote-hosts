// Public change history: docs/PUBLIC-CHANGES.md
const HEADER_ACTIONS = 'conversation.session.header.actions'
const COMPOSER = 'conversation.composer'
const MAX_SESSION_ID_LENGTH = 512
const NOOP = () => {}

function encodePart(value) {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function decodePart(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid composite session id')
  const standard = value.replaceAll('-', '+').replaceAll('_', '/')
  const binary = atob(standard + '='.repeat((4 - standard.length % 4) % 4))
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, char => char.charCodeAt(0)))
  if (encodePart(decoded) !== value) throw new Error('non-canonical composite session id')
  return decoded
}

function resolveOwnerRoute(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > MAX_SESSION_ID_LENGTH || sessionId.includes('\0')) {
    throw new TypeError('sessionId is invalid')
  }
  const parts = sessionId.split('.')
  const composite = parts.length === 3 && parts[0] === 'rh1'
  const hostToken = composite ? parts[1] : undefined
  const rawSessionId = composite ? decodePart(parts[2]) : sessionId
  if (composite) decodePart(hostToken)
  const base = composite ? `/remote-runtime/${hostToken}/api/session-share/v1` : '/api/session-share/v1'
  const route = {
    kind: composite ? 'remote' : 'local',
    scopeKey: composite ? `remote:${hostToken}` : 'local',
    rawSessionId,
    mapSessionId: raw => composite ? `rh1.${hostToken}.${encodePart(raw)}` : raw,
    async request(path, init) {
      if (typeof path !== 'string' || !/^\/shares(?:\/[A-Za-z0-9_-]{1,128}(?:\/revoke)?)?$/.test(path)) throw new TypeError('owner API path is invalid')
      const response = await fetch(`${base}${path}`, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      })
      const value = await response.json()
      if (!response.ok) throw new Error(typeof value?.error === 'string' ? value.error : `Owner API failed (${response.status})`)
      return value
    },
  }
  return Object.freeze(route)
}

function sessionOwner(props) {
  const sessionId = props?.sessionId
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > MAX_SESSION_ID_LENGTH || sessionId.includes('\0')) return undefined
  return Object.freeze({ sessionId })
}

/**
 * Stable share UI port. Official SlotRegistry props and slot names terminate
 * here; share components receive only the selected session identity.
 */
export function createSessionShareClient(slots, { createElement } = {}) {
  if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
    throw new TypeError('official slot binding is required')
  }
  if (typeof createElement !== 'function') throw new TypeError('React element factory is required')

  return Object.freeze({
    resolveOwnerRoute,
    install({ headerAction, selectReadOnlyComposer, readOnlyComposer } = {}) {
      if (typeof headerAction !== 'function' || typeof selectReadOnlyComposer !== 'function' || typeof readOnlyComposer !== 'function') {
        throw new TypeError('share header action, composer selector, and read-only composer are required')
      }

      let refreshComposer = NOOP
      const disposers = []
      let disposed = false
      const dispose = () => {
        if (disposed) return
        disposed = true
        refreshComposer = NOOP
        for (const stop of disposers.splice(0).reverse()) stop()
      }
      try {
        disposers.push(slots.inject(HEADER_ACTIONS, () => slots.register({
          name: HEADER_ACTIONS,
          id: 'session-share',
          order: 30,
        }, props => {
          const owner = sessionOwner(props)
          return owner === undefined ? null : createElement(headerAction, owner)
        })))

        disposers.push(slots.inject(COMPOSER, () => {
          let disposeRegistration = NOOP
          let active = true
          const register = () => {
            disposeRegistration()
            disposeRegistration = slots.register({
              name: COMPOSER,
              priority: -30,
              select: props => {
                const owner = sessionOwner(props)
                return owner !== undefined && selectReadOnlyComposer(owner) ? true : null
              },
            }, props => {
              const owner = sessionOwner(props)
              return owner === undefined ? null : createElement(readOnlyComposer, owner)
            })
          }

          register()
          refreshComposer = () => { if (active && !disposed) register() }
          return () => {
            active = false
            refreshComposer = NOOP
            disposeRegistration()
            disposeRegistration = NOOP
          }
        }))
      } catch (error) {
        dispose()
        throw error
      }

      return Object.freeze({ refreshComposer: () => refreshComposer(), dispose })
    },
  })
}
