// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                                   
                                                                                                                                                   
                                                                                                                                                   
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDiagnosticJournal } from '../packages/runtime-interface/src/diagnostics.js'
                                                                                                                                                       

test('interaction retry diagnostics preserve bounded metadata through persistence and export', async t => {
  const { createRemoteHostsClient } = await import('../packages/runtime-interface/src/client/index.js')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-diagnostic-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'events.jsonl'), journal = createDiagnosticJournal({ file })
  const phases = ['interaction_delivery', 'interaction_deferred', 'interaction_retry_limit', 'interaction_answer', 'interaction_rejected']
  for (const phase of phases) journal.record({ phase, endpoint: '$events/result', hostId: 'PRIVATE_HOST', sessionId: 'PRIVATE_SESSION', count: 4, question: 'PRIVATE_BODY', outcome: 'PRIVATE_ANSWER' })
  const restored = createDiagnosticJournal({ file })
  const client = createRemoteHostsClient({ call: async () => ({ ok: true, value: restored.snapshot() }) })
  const result = await client.call('exportDiagnostics')
  assert.deepEqual(result.events.map(row => row.phase), phases)
  assert.ok(result.events.every(row => row.count === 4 && row.endpoint === '$events/result'))
  assert.ok(!readFileSync(file, 'utf8').includes('PRIVATE'))
  assert.ok(!JSON.stringify(result).includes('PRIVATE'))
})

test('diagnostics persist only allow-listed metadata and anonymize identities', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-diagnostic-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'events.jsonl'), log = createDiagnosticJournal({ file })
  log.record({ phase: 'stream_error', endpoint: 'session/follow', hostId: 'PRIVATE_HOST', sessionId: 'PRIVATE_SESSION', code: 'transport', message: 'SECRET_TOKEN', body: 'SECRET_BODY', url: 'SECRET_URL' })
  const disk = readFileSync(file, 'utf8'), snapshot = log.snapshot()
  assert.equal(snapshot.events.length, 1)
  assert.match(snapshot.events[0].host, /^[a-f0-9]{20}$/)
  for (const secret of ['PRIVATE_HOST', 'PRIVATE_SESSION', 'SECRET_TOKEN', 'SECRET_BODY', 'SECRET_URL']) assert.ok(!disk.includes(secret))
  assert.deepEqual(createDiagnosticJournal({ file }).snapshot().events, snapshot.events)
  snapshot.events[0].phase = 'changed'
  assert.equal(log.snapshot().events[0].phase, 'stream_error')
})

test('journal bounds memory, excludes arbitrary codes and revalidates disk input', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-diagnostic-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'events.jsonl')
  writeFileSync(file, JSON.stringify({ phase: 'stream_open', time: 1, endpoint: 'SECRET_URL', code: 'SECRET', host: 'PRIVATE', body: 'SECRET' }) + '\ninvalid\n')
  const log = createDiagnosticJournal({ file })
  assert.equal(log.snapshot().events[0].endpoint, 'other')
  assert.ok(!JSON.stringify(log.snapshot()).includes('SECRET'))
  for (let i = 0; i < 600; i++) log.record({ phase: 'stream_end', endpoint: '$events', code: 'SECRET' })
  assert.equal(log.snapshot().events.length, 512)
  assert.equal(log.snapshot().dropped, 89)
})

test('unavailable persistence cannot break subscription processing', () => {
  const log = createDiagnosticJournal({ file: '\0' })
  assert.doesNotThrow(() => log.record({ phase: 'stream_open' }))
  assert.equal(log.snapshot().persistenceAvailable, false)
  assert.equal(log.snapshot().events.length, 1)
})

test('management export uses interface snapshot without host credentials or filesystem reads', async () => {
  const { createDispatcher } = await import('../packages/remote-hosts-settings-rc1/src/dispatch.js')
  const diagnostics = createDiagnosticJournal()
  diagnostics.record({ phase: 'stream_error', endpoint: 'session/follow', code: 'transport' })
  const dispatch = createDispatcher({ diagnostics, control: { secret: 'DO_NOT_EXPORT' }, configFile: 'PRIVATE_PATH' })
  const result = await dispatch('exportDiagnostics', {})
  assert.equal(result.ok, true)
  assert.equal(result.value.events[0].code, 'transport')
  assert.ok(!JSON.stringify(result).includes('DO_NOT_EXPORT'))
  assert.ok(!JSON.stringify(result).includes('PRIVATE_PATH'))
})

test('browser interface accepts bounded diagnostic export and strips unknown fields', async () => {
  const { createRemoteHostsClient } = await import('../packages/runtime-interface/src/client/index.js')
  const journal = createDiagnosticJournal()
  journal.record({ phase: 'stream_end', endpoint: 'session/follow', lastSeq: 42 })
  let args
  const client = createRemoteHostsClient({ call: async (...values) => { args = values; return { ok: true, value: { ...journal.snapshot(), secret: 'SECRET' } } } })
  const result = await client.call('exportDiagnostics')
  assert.equal(args[1], 'exportDiagnostics')
  assert.equal(result.events[0].lastSeq, 42)
  assert.equal(result.secret, undefined)
})


test('structured failure survives persistence and browser export without secrets', async () => {
  const { createRemoteHostsClient } = await import('../packages/runtime-interface/src/client/index.js')
  const journal = createDiagnosticJournal()
  journal.record({ phase: 'stream_error', endpoint: 'session/follow', source: 'interface', reason: 'sequence-gap', recoverable: false, stage: 'live', expected: 5, actual: 7, message: 'SECRET_BODY', stack: 'SECRET_PATH' })
  journal.record({ phase: 'stream_error', endpoint: 'session/follow', source: 'SECRET_SOURCE', reason: 'SECRET_REASON', recoverable: true, stage: 'SECRET_STAGE', expected: 'SECRET_EXPECTED', actual: Infinity })
  const client = createRemoteHostsClient({ call: async () => ({ ok: true, value: journal.snapshot() }) })
  const result = await client.call('exportDiagnostics')
  assert.equal(result.events[0].reason, 'sequence-gap')
  assert.equal(result.events[0].expected, 5)
  assert.equal(result.events[0].actual, 7)
  assert.equal(result.events[0].recoverable, false)
  assert.ok(!JSON.stringify(result).includes('SECRET'))
  assert.notEqual(result.events[1].recoverable, true)
})

test('carrier first-error and close metadata survive rotation and export with strict redaction', async t => {
  const { createRemoteHostsClient } = await import('../packages/runtime-interface/src/client/index.js')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-carrier-diagnostic-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'events.jsonl'), journal = createDiagnosticJournal({ file })
  for (let i = 0; i < 1200; i++) journal.record({ phase: 'carrier_error', endpoint: 'session/follow', hostId: 'PRIVATE_HOST', entryId: 'PRIVATE_ENTRY', readId: 'PRIVATE_READ',
    operation: 'ws-error', httpStatus: 503, errorCode: 'ECONNRESET', cancelSource: 'none', message: 'SECRET_BODY', url: 'SECRET_URL', token: 'SECRET_TOKEN' })
  journal.record({ phase: 'carrier_close', endpoint: 'host/describe', hostId: 'PRIVATE_HOST', entryId: 'PRIVATE_ENTRY', operation: 'ssh-exit',
    sshPid: 123, exitCode: 255, killIntent: false, closeSource: 'child-exit' })
  const restored = createDiagnosticJournal({ file })
  const client = createRemoteHostsClient({ call: async () => ({ ok: true, value: restored.snapshot() }) })
  const exported = await client.call('exportDiagnostics')
  assert.equal(exported.events.length, 512)
  const error = exported.events.find(row => row.operation === 'ws-error'), exit = exported.events.at(-1)
  assert.equal(error.httpStatus, 503); assert.equal(error.errorCode, 'ECONNRESET')
  assert.match(error.entry, /^[a-f0-9]{20}$/); assert.match(error.read, /^[a-f0-9]{20}$/)
  assert.equal(exit.entry, error.entry); assert.equal(exit.sshPid, 123); assert.equal(exit.exitCode, 255)
  assert.equal(exit.killIntent, false); assert.equal(exit.closeSource, 'child-exit')
  const persisted = readFileSync(file, 'utf8') + readFileSync(file + '.1', 'utf8') + JSON.stringify(exported)
  assert.ok(!/PRIVATE|SECRET/.test(persisted))
  const poisoned = createRemoteHostsClient({ call: async () => ({ ok: true, value: { schemaVersion: 1, scope: 'local-hub-only', events: [{
    phase: 'carrier_error', entry: 'SECRET', read: 'SECRET', operation: 'SECRET', errorCode: 'SECRET', sshPid: -1, exitCode: Infinity,
    cancelSource: 'SECRET', closeSource: 'SECRET', httpStatus: 999, killIntent: 'SECRET', exitSignal: 'SECRET'
  }] } }) })
  const value = await poisoned.call('exportDiagnostics')
  assert.ok(!JSON.stringify(value).includes('SECRET')); assert.equal(value.events[0].httpStatus, undefined)
})
