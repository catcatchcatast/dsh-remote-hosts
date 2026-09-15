'use strict'
const { parentPort, workerData } = require('node:worker_threads')

let disposed = false
const cancelView = workerData.cancelBuffer instanceof SharedArrayBuffer ? new Int32Array(workerData.cancelBuffer) : undefined
let disposeWaiter
let delayTimer
let delayWaiter

function safeFailureCode(error) {
  const candidate = typeof error?.code === 'string' ? error.code : error?.message
  return /^BOOTSTRAP_[A-Z0-9_]+$/.test(candidate || '') ? candidate : 'BOOTSTRAP_PUBLISH_FAILED'
}

function send(message) {
  try { parentPort?.postMessage(message) } catch { /* the owner may already be unloading */ }
}

function requestDispose() {
  if (disposed) return
  disposed = true
  if (cancelView) Atomics.store(cancelView, 0, 1)
  if (delayTimer !== undefined) {
    clearTimeout(delayTimer)
    delayTimer = undefined
    delayWaiter?.(false)
    delayWaiter = undefined
  }
  disposeWaiter?.()
  disposeWaiter = undefined
}

function waitForDispose() {
  if (disposed || cancelView && Atomics.load(cancelView, 0) === 1) return Promise.resolve()
  return new Promise(resolve => { disposeWaiter = resolve })
}

function waitForRetry(milliseconds) {
  if (disposed || cancelView && Atomics.load(cancelView, 0) === 1) return Promise.resolve(false)
  return new Promise(resolve => {
    delayWaiter = resolve
    delayTimer = setTimeout(() => {
      delayTimer = undefined
      delayWaiter = undefined
      resolve(!disposed && (!cancelView || Atomics.load(cancelView, 0) !== 1))
    }, milliseconds)
  })
}

function closeWorker() {
  try { parentPort?.close() } catch { /* already closed */ }
}

async function run() {
  let disposer
  const baseDelay = Number.isSafeInteger(workerData.retryBaseMs) && workerData.retryBaseMs > 0 ? workerData.retryBaseMs : 100
  const maxDelay = Number.isSafeInteger(workerData.retryMaxMs) && workerData.retryMaxMs >= baseDelay ? workerData.retryMaxMs : 5000
  const maxAttempts = Number.isSafeInteger(workerData.maxAttempts) && workerData.maxAttempts > 0 ? workerData.maxAttempts : 8
  for (let attempt = 1; !disposed && (!cancelView || Atomics.load(cancelView, 0) !== 1) && attempt <= maxAttempts; attempt++) {
    try {
      const store = require(workerData.storePath)
      disposer = store.publishBootstrap(workerData.port, workerData.authenticatedRootUrl, workerData.home)
      if (disposed || cancelView && Atomics.load(cancelView, 0) === 1) {
        try { disposer?.() } catch { send({ type: 'failure', code: 'BOOTSTRAP_CLEANUP_FAILED' }) }
        return
      }
      send({ type: 'published' })
      await waitForDispose()
      if (disposer) {
        try { disposer() } catch { send({ type: 'failure', code: 'BOOTSTRAP_CLEANUP_FAILED' }) }
      }
      return
    } catch (error) {
      disposer = undefined
      if (disposed) return
      send({ type: 'failure', code: safeFailureCode(error) })
      if (attempt >= maxAttempts) return
      const delay = Math.min(maxDelay, baseDelay * 2 ** Math.min(attempt - 1, 30))
      if (!await waitForRetry(delay)) return
    }
  }
}

parentPort?.on('message', message => {
  if (message?.type === 'dispose') requestDispose()
})

run().catch(() => send({ type: 'failure', code: 'BOOTSTRAP_PUBLISH_FAILED' })).finally(closeWorker)
