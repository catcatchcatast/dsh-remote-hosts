
/** Bind the official Connection RPC registry to the caller's Cordis scope. */
import { symbols, withProps } from '@deepseek-ai/cordis'

function originalConnection(connection) {
  const originalSymbol = symbols?.original
  if (originalSymbol === undefined || connection === null || connection === undefined) return connection
  return connection[originalSymbol] ?? connection
}

/**
 * Create the narrow management registration face used by the runtime boundary.
 * The official service is rebound internally; callers receive no Cordis context.
 */
export function bindManagementConnection(ctx, connection, upstreamVersion) {
  const raw = originalConnection(connection)
  const bound = ctx && raw !== null && (typeof raw === 'object' || typeof raw === 'function')
    ? withProps(raw, { ctx })
    : raw
  const rpc = bound?.rpc
  const handle = rpc?.handle
  return Object.freeze({
    upstreamVersion,
    register: typeof handle === 'function'
      ? (channel, handler) => handle.call(rpc, channel, handler)
      : undefined,
  })
}
