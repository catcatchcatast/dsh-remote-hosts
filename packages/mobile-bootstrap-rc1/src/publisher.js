import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'

const WORKER_PATH = fileURLToPath(new URL('./bootstrap-publisher-worker.cjs', import.meta.url))
const STORE_PATH = fileURLToPath(new URL('./bootstrap-store.cjs', import.meta.url))
const DEFAULT_RETRY_BASE_MS = 100
const DEFAULT_RETRY_MAX_MS = 5000
const DEFAULT_MAX_ATTEMPTS = 8

function safeFailureCode(error) {
  const candidate = typeof error === 'string' ? error : typeof error?.code === 'string' ? error.code : error?.message
  return /^BOOTSTRAP_[A-Z0-9_]+$/.test(candidate ?? '') ? candidate : 'BOOTSTRAP_PUBLISH_FAILED'
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function reportFailure(report, code) {
  if (typeof report !== 'function') return
  try { report(code) } catch { /* failure reporting must not affect the runtime */ }
}

/** Start the isolated publisher and return a synchronous cancellation disposer. */
export function createBootstrapPublisher({
  port,
  authenticatedRootUrl,
  home,
  WorkerCtor = Worker,
  workerPath = WORKER_PATH,
  storePath = STORE_PATH,
  workerEnvironment,
  retryBaseMs = DEFAULT_RETRY_BASE_MS,
  retryMaxMs = DEFAULT_RETRY_MAX_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  onFailure,
} = {}) {
  const baseDelay = positiveInteger(retryBaseMs, DEFAULT_RETRY_BASE_MS)
  const maxDelay = Math.max(baseDelay, positiveInteger(retryMaxMs, DEFAULT_RETRY_MAX_MS))
  const attempts = positiveInteger(maxAttempts, DEFAULT_MAX_ATTEMPTS)
  let disposed = false
  const cancelBuffer = new SharedArrayBuffer(4)
  let worker
  try {
    worker = new WorkerCtor(workerPath, {
      workerData: { port, authenticatedRootUrl, home, storePath, retryBaseMs: baseDelay, retryMaxMs: maxDelay, maxAttempts: attempts, cancelBuffer },
      ...(workerEnvironment === undefined ? {} : { env: workerEnvironment }),
    })
  } catch (error) {
    reportFailure(onFailure, safeFailureCode(error))
    return () => { disposed = true }
  }

  const notify = message => {
    if (disposed || !message || typeof message !== 'object') return
    if (message.type === 'failure') reportFailure(onFailure, safeFailureCode(message.code))
  }
  worker.on?.('message', notify)
  let workerError = false
  worker.on?.('error', error => {
    if (!disposed) {
      workerError = true
      reportFailure(onFailure, safeFailureCode(error))
    }
  })
  worker.on?.('exit', code => {
    if (!disposed && code !== 0 && !workerError) reportFailure(onFailure, 'BOOTSTRAP_PUBLISH_FAILED')
  })
  worker.unref?.()

  return () => {
    if (disposed) return
    disposed = true
    Atomics.store(new Int32Array(cancelBuffer), 0, 1)
    try { worker.postMessage?.({ type: 'dispose' }) } catch { /* worker may already be exiting */ }
  }
}

export const bootstrapPublisherDefaults = Object.freeze({
  retryBaseMs: DEFAULT_RETRY_BASE_MS,
  retryMaxMs: DEFAULT_RETRY_MAX_MS,
  maxAttempts: DEFAULT_MAX_ATTEMPTS,
})
