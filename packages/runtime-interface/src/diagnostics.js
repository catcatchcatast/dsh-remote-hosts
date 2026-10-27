// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                                   
                                                                                                                                             
                                                                                                                                                   
                                                                                                                                                   
import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { sanitizeStreamFailure, sanitizeTransportDiagnostic } from './stream-failure.js'
                                                                                                                                                       

const PHASES = new Set(['carrier_error', 'carrier_close', 'carrier_drop', 'request_start', 'request_success', 'request_error', 'stream_open', 'stream_snapshot', 'stream_end', 'stream_error', 'stream_cancel', 'interaction_delivery', 'interaction_deferred', 'interaction_retry_limit', 'interaction_answer', 'interaction_rejected'])
const ENDPOINTS = new Set(['session/follow', 'session/control', 'workspace/follow', '$events', '$events/result', 'session/list', 'workspace/archiveSession', 'host/describe', 'hostInteractions/v1/read', 'hostInteractions/v1/respond'])
const CODES = new Set(['unknown', 'timeout', 'aborted', 'transport', 'protocol', 'unauthorized', 'forbidden', 'overflow'])
const LIMIT = 512
const FILE_BYTES = 256 * 1024

/** Strict allow-list: no free-form messages, paths, request payloads or credentials. */
export function createDiagnosticJournal({ file, now = Date.now } = {}) {
  const salt = randomBytes(32)
  const rows = []
  let persistenceAvailable = Boolean(file)
  let dropped = 0
  const alias = value => createHash('sha256').update(salt).update(String(value)).digest('hex').slice(0, 20)
  const safeRow = input => {
    if (!input || !PHASES.has(input.phase)) return null
    const row = { time: now(), phase: input.phase, endpoint: ENDPOINTS.has(input.endpoint) ? input.endpoint : 'other' }
    if (CODES.has(input.code)) row.code = input.code
    const failure = sanitizeStreamFailure(input)
    if (failure) Object.assign(row, failure)
    Object.assign(row, sanitizeTransportDiagnostic(input))
    for (const key of ['closeCode', 'count', 'durationMs', 'lastSeq']) {
      if (Number.isSafeInteger(input[key]) && input[key] >= 0) row[key] = input[key]
    }
    return row
  }
  const push = row => { rows.push(row); if (rows.length > LIMIT) { rows.shift(); dropped++ } }
  if (file) {
    for (const path of [file + '.1', file]) {
      try {
        if (statSync(path).size > FILE_BYTES + 2048) continue
        for (const line of readFileSync(path, 'utf8').split('\n')) {
          try {
            const value = JSON.parse(line), row = safeRow(value)
            if (!row || !Number.isSafeInteger(value.time)) continue
            row.time = value.time
            for (const key of ['host', 'session', 'entry', 'read']) if (/^[a-f0-9]{20}$/.test(value[key] ?? '')) row[key] = value[key]
            push(row)
          } catch { /* ignore interrupted or invalid records */ }
        }
      } catch (error) { if (error.code !== 'ENOENT') persistenceAvailable = false }
    }
  }
  return Object.freeze({
    record(input) {
      const row = safeRow(input)
      if (!row) return
      if (typeof input.hostId === 'string') row.host = alias(input.hostId)
      if (typeof input.sessionId === 'string') row.session = alias(`${input.hostId ?? ''}\0${input.sessionId}`)
      for (const key of ['entry', 'read']) if (typeof input[key + 'Id'] === 'string') row[key] = alias(String(input.hostId ?? '') + '\0' + input[key + 'Id'])
      push(row)
      if (!file) return
      try {
        mkdirSync(dirname(file), { recursive: true })
        let bytes = 0
        try { bytes = statSync(file).size } catch (error) { if (error.code !== 'ENOENT') throw error }
        if (bytes >= FILE_BYTES) { rmSync(file + '.1', { force: true }); renameSync(file, file + '.1') }
        appendFileSync(file, JSON.stringify(row) + '\n', { encoding: 'utf8', mode: 0o600 })
        persistenceAvailable = true
      } catch { persistenceAvailable = false }
    },
    snapshot() {
      return { schemaVersion: 1, generatedAt: new Date(now()).toISOString(), limit: LIMIT, dropped, persistenceAvailable, scope: 'local-hub-only', events: rows.map(row => ({ ...row })) }
    },
  })
}
