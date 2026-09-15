
import { appendFile } from 'node:fs/promises'
import { AsyncLocalStorage } from 'node:async_hooks'
import {
  BUNDLED_MANAGED_RUNTIME_LAUNCHER,
  ManagedRuntimeError,
  descriptorFingerprint,
  forkManagedRuntimeBroker,
  normalizeManagedRuntimeDescriptor,
  verifyCurrentRuntimeIdentity,
} from './managed-runtime-launcher.mjs'

export const LOCAL_RUNTIME_RESTART_STATES = Object.freeze(['unavailable', 'ready', 'starting', 'requested', 'failed'])

function toError(error, fallbackCode = 'LOCAL_RESTART_FAILED') {
  if (error instanceof Error && typeof error.code === 'string') return error
  return new ManagedRuntimeError(fallbackCode, fallbackCode, { cause: String(error?.message ?? error) })
}

function safeState(value) {
  return LOCAL_RUNTIME_RESTART_STATES.includes(value) ? value : 'failed'
}

function readyMessage(value, fingerprint) {
  return value?.type === 'ready' && value?.fingerprint === fingerprint
}

// The official Connection RPC handler intentionally exposes only its decoded
// endpoint/payload/signal.  Keep the shutdown edge at the runtime boundary by
// observing the response owned by the web server bridge.  The path is a
// protocol constant of the remote-hosts adapter; the client still supplies no
// path or process data.
const LOCAL_RESTART_RESPONSE_PATH = '/remote-hosts/restart'

function createResponseFinishTracker(webServer) {
  // WebServer keeps the node:http Server as an ordinary (non-#private) field;
  // older test/runtime doubles may expose only host/port, in which case the
  // direct capability retains its old timer fallback below.
  const server = webServer?.server
  if (server === null || server === undefined || typeof server.on !== 'function') return undefined
  const records = new Set()
  const requestScope = new AsyncLocalStorage()

  const onRequest = (request, response) => {
    if (request?.method !== 'POST' || typeof response?.once !== 'function') return
    let pathname
    try { pathname = new URL(request.url ?? '/', 'http://dsh.internal').pathname } catch { return }
    if (pathname !== LOCAL_RESTART_RESPONSE_PATH) return

    const record = { claimed: false, settled: false, finished: false, closed: false, onFinish: undefined, onClose: undefined }
    records.add(record)
    const detach = () => {
      response.off?.('finish', finish)
      response.off?.('close', close)
      records.delete(record)
    }
    const finish = () => {
      if (record.settled) return
      record.settled = true
      record.finished = true
      detach()
      record.onFinish?.()
    }
    const close = () => {
      if (record.settled) return
      record.settled = true
      record.closed = true
      detach()
      record.onClose?.()
    }
    response.once('finish', finish)
    response.once('close', close)
    // A minimal response double or an already-finished response may not emit
    // the event after registration.  Node's ServerResponse normally does.
    if (response.writableFinished === true || response.finished === true) finish()
    requestScope.enterWith(record)
  }
  // Capture the response before the official server listener starts the
  // bridge. Each handler continuation then retains its own request scope;
  // FIFO selection would bind an interleaved restart to the wrong response.
  server.prependListener?.('request', onRequest)
  if (typeof server.prependListener !== 'function') server.on('request', onRequest)

  return Object.freeze({
    claim() {
      const record = requestScope.getStore()
      if (record !== undefined && records.has(record) && !record.claimed) {
        record.claimed = true
        return record
      }
      return undefined
    },
    arm(record, { onFinish, onClose } = {}) {
      if (!records.has(record)) {
        if (record?.finished) onFinish?.()
        return record?.closed ? 'closed' : 'finished'
      }
      record.onFinish = onFinish
      record.onClose = onClose
      if (record.settled) {
        records.delete(record)
        return record.closed ? 'closed' : 'finished'
      }
      return 'pending'
    },
    release(record) {
      if (!records.delete(record)) return
      record.claimed = true
      record.onFinish = undefined
      record.onClose = undefined
    },
  })
}

function scheduleRestartDiagnostics(processLike, descriptor) {
  if (processLike?.env?.DSH_LOCAL_RESTART_DIAGNOSTICS !== '1' || typeof descriptor?.logPath !== 'string') return
  for (const delayMs of [5000, 15000]) {
    const timer = setTimeout(() => {
      const resources = {}
      try {
        for (const type of processLike?.getActiveResourcesInfo?.() ?? []) {
          if (typeof type === 'string') resources[type] = (resources[type] ?? 0) + 1
        }
      } catch { /* diagnostic sampling must never affect restart */ }
      const entry = {
        event: 'local-restart-diagnostics',
        delayMs,
        exitCode: processLike?.exitCode ?? null,
        resources,
      }
      void appendFile(descriptor.logPath, `${JSON.stringify(entry)}\n`, 'utf8').catch(() => {})
    }, delayMs)
    timer.unref?.()
  }
}

// The official rc1 shutdown capability returns before its async disposer has
// completed.  It records completion by changing an initially undefined
// process.exitCode to zero.  Once that explicit restart path has finished,
// terminate this process so the committed broker can launch the replacement;
// an unref'ed poll and the descriptor budget make a missing completion a
// no-op rather than an external kill or a health timeout.
function scheduleProcessExitAfterShutdown(processLike, descriptor, initialExitCode) {
  if (initialExitCode !== undefined || typeof processLike?.exit !== 'function') return
  const timeoutMs = Number.isSafeInteger(descriptor?.exitWaitMs) ? descriptor.exitWaitMs : 30000
  const deadline = Date.now() + timeoutMs
  let exitRequested = false
  let timer
  const check = () => {
    if (exitRequested) return
    if (processLike.exitCode === 0) {
      exitRequested = true
      try { processLike.exit(0) } catch { /* preserve the accepted shutdown */ }
      return
    }
    if (Date.now() >= deadline) return
    timer = setTimeout(check, 25)
    timer.unref?.()
  }
  check()
}

/**
 * Narrow local restart capability. The caller supplies no command-line data;
 * all launch identity comes from the trusted package configuration.
 */
export function createLocalRuntimeRestart({
  descriptor,
  appExit,
  webServer,
  processLike = globalThis.process,
  forkBroker = forkManagedRuntimeBroker,
} = {}) {
  let normalized
  let descriptorError
  if (descriptor !== undefined) {
    try {
      normalized = normalizeManagedRuntimeDescriptor(descriptor, { launcherPath: BUNDLED_MANAGED_RUNTIME_LAUNCHER })
    } catch (error) {
      descriptorError = toError(error, 'LOCAL_RESTART_DESCRIPTOR_INVALID')
    }
  }
  const available = normalized !== undefined && typeof appExit === 'function'
  let responseTracker = createResponseFinishTracker(webServer)
  const getResponseTracker = () => {
    // WebServer normally has its ordinary server field by construction.  A
    // runtime double or an early plugin may expose it later; retry at the
    // request boundary in that case, before any accepted result is returned.
    if (responseTracker === undefined) responseTracker = createResponseFinishTracker(webServer)
    return responseTracker
  }
  const state = {
    state: available ? 'ready' : 'unavailable',
    busy: false,
    lastError: descriptorError?.code ?? null,
  }
  let pending

  function status() {
    return Object.freeze({
      available,
      busy: state.busy,
      state: safeState(state.state),
      ...(state.lastError === null ? {} : { lastError: state.lastError }),
    })
  }

  async function run() {
    state.busy = true
    state.state = 'starting'
    state.lastError = null
    let broker
    let responseRecord
    let responseTrackerForRun
    try {
      if (!available) throw descriptorError ?? new ManagedRuntimeError('LOCAL_RESTART_UNAVAILABLE', 'local restart is unavailable')
      verifyCurrentRuntimeIdentity(normalized, { processLike, webServer })
      responseTrackerForRun = getResponseTracker()
      try {
        broker = await forkBroker({
          descriptor: normalized,
          parentPid: processLike?.pid,
          fingerprint: descriptorFingerprint(normalized),
        })
      } catch (error) {
        throw toError(error, 'LOCAL_RESTART_BROKER_FAILED')
      }
      let ready
      try {
        ready = await Promise.resolve(broker?.ready ?? broker)
      } catch (error) {
        throw toError(error, 'LOCAL_RESTART_BROKER_FAILED')
      }
      if (!readyMessage(ready, descriptorFingerprint(normalized))) {
        throw new ManagedRuntimeError('LOCAL_RESTART_BROKER_FAILED', 'managed runtime broker ready handshake did not match the descriptor')
      }
      // Claim after the first async boundary: the node:http server may invoke
      // the route listener before this installer's request listener in the
      // same request event.  The response record is kept while the broker
      // handshakes and is still live when the accepted reply is assembled.
      responseRecord = responseTrackerForRun?.claim()
      state.state = 'requested'
      const finishExit = () => {
        const initialExitCode = processLike?.exitCode
        let exitAccepted = false
        try {
          appExit(0)
          exitAccepted = true
        } catch (error) {
          state.state = 'failed'
          state.lastError = toError(error, 'LOCAL_RESTART_APP_EXIT_FAILED').code
          state.busy = false
          pending = undefined
          try { broker?.cancel?.() } catch { /* preserve the appExit error */ }
        }
        if (exitAccepted) {
          // The response is already handed to node:http. Close the committed
          // broker IPC channel before natural appExit teardown; this is not a
          // cancellation and cannot prevent the broker's PID wait/launch.
          try { broker?.close?.() } catch { /* preserve the accepted exit */ }
          scheduleRestartDiagnostics(processLike, normalized)
          scheduleProcessExitAfterShutdown(processLike, normalized, initialExitCode)
        }
      }
      const responseState = responseTrackerForRun === undefined
        ? 'fallback'
        : responseRecord === undefined
          ? 'missing'
          : responseTrackerForRun.arm(responseRecord, {
            onFinish: finishExit,
            onClose: () => {
              state.state = 'failed'
              state.lastError = 'LOCAL_RESTART_RESPONSE_CLOSED'
              state.busy = false
              pending = undefined
              try { broker?.cancel?.() } catch { /* preserve the response-close state */ }
            },
          })
      if (responseState === 'missing') {
        throw new ManagedRuntimeError('LOCAL_RESTART_RESPONSE_UNAVAILABLE', 'management response lifecycle is unavailable')
      }
      if (responseState === 'closed') {
        throw new ManagedRuntimeError('LOCAL_RESTART_RESPONSE_CLOSED', 'management response closed before it finished')
      }
      if (responseState === 'fallback') {
        // Direct callers and old runtime doubles have no node:http response.
        // Production WebServer instances always take the finish-gated path.
        setTimeout(finishExit, 0)
      }
      return Object.freeze({ accepted: true, state: 'requested' })
    } catch (error) {
      const normalizedError = toError(error)
      state.state = 'failed'
      state.lastError = normalizedError.code
      responseTrackerForRun?.release(responseRecord)
      try { broker?.disconnect?.() } catch { /* preserve the restart error */ }
      pending = undefined
      throw normalizedError
    } finally {
      if (state.state !== 'requested') state.busy = false
    }
  }

  function restart(...args) {
    if (args.length !== 0) return Promise.reject(new ManagedRuntimeError('LOCAL_RESTART_PARAMS_INVALID', 'local restart does not accept request parameters'))
    if (pending !== undefined) return pending
    pending = run()
    return pending
  }

  return Object.freeze({ status, restart })
}
