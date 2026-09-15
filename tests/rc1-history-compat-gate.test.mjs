import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import test from 'node:test'
import { classifyPersistenceError, isSessionLoadCompatible, runHistoryCompatGate, summarizeOfficialEvents, summarizeUnsupportedEvents } from '../tools/rc1-history-compat-gate.mjs'

const fixtureDir = fileURLToPath(new URL('./fixtures/rc1-history-compat/', import.meta.url))
const fixtureSamples = [
  ['sample-unseeded.jsonl', 'synthetic-unseeded'],
  ['sample-seeded.jsonl', 'synthetic-seeded'],
  ['sample-agent.jsonl', 'synthetic-agent'],
]

test('official event summary detects contiguous sequences without retaining event bodies', () => {
  assert.deepEqual(summarizeOfficialEvents([{ seq: 3 }, { seq: 4 }, { seq: 5 }]), {
    eventCount: 3,
    invalidSeqCount: 0,
    gapCount: 0,
    duplicateCount: 0,
    firstSeq: 3,
    lastSeq: 5,
    sequenceSha256: 'be5e90a9f3da4d02fe339d2f5e95f9a8ad6b6f5499d9c051ca602df557253d2a',
    contiguous: true,
  })
  const result = summarizeOfficialEvents([{ seq: 0 }, { seq: 2 }, { seq: 2 }, { nope: true }])
  assert.equal(result.eventCount, 4)
  assert.equal(result.invalidSeqCount, 1)
  assert.equal(result.gapCount, 1)
  assert.equal(result.duplicateCount, 1)
  assert.equal(result.contiguous, false)
})

test('persistence error classification never requires exposing official messages', () => {
  assert.equal(classifyPersistenceError({ name: 'SessionPersistenceCorruptionError', message: 'contains a path and identity' }), 'persistence-corruption')
  assert.equal(classifyPersistenceError({ name: 'SessionFormatUnsupportedError', message: 'sensitive' }), 'format-unsupported')
  assert.equal(classifyPersistenceError({ name: 'TypeError', message: 'sensitive' }), 'validation')
})

test('unsupported event diagnostics retain only type, seq, and field names', () => {
  const result = summarizeUnsupportedEvents([
    { seq: 4, type: 'plugin/required', data: { alpha: 1 }, marker: true },
    { seq: 7, type: 'plugin/required', data: { beta: 2 }, marker: true },
    { seq: 8, type: 'known', data: { hidden: 'not retained' } },
    { seq: 9, type: 'plugin/optional', ignorable: true, data: { skipped: true } },
  ], new Set(['known']))
  assert.deepEqual(result, [
    {
      type: 'plugin/required',
      count: 2,
      seqs: [4, 7],
      eventFields: ['data', 'marker', 'seq', 'type'],
      dataFields: ['alpha', 'beta'],
    },
  ])
})

test('session-load compatibility is strict and does not bless a refusal', () => {
  assert.equal(isSessionLoadCompatible({ inspect: { succeeded: 1 }, load: { succeeded: 1 } }, 1), true)
  assert.equal(isSessionLoadCompatible({ inspect: { succeeded: 0, failed: 1 }, load: { succeeded: 0, failed: 1 } }, 1), false)
  assert.equal(isSessionLoadCompatible({ inspect: { succeeded: 1 }, load: { succeeded: 0, failed: 1 } }, 1), false)
})

test('real rc1 persistence reads synthetic v0 history copies with the official SessionStore context and leaves sources unchanged', { skip: !process.env.DSH_RC1_UPSTREAM_ROOT }, async (t) => {
  const upstreamRoot = process.env.DSH_RC1_UPSTREAM_ROOT
  assert.ok(upstreamRoot, 'set DSH_RC1_UPSTREAM_ROOT to the installed public 0.1.2-rc.1 @deepseek-ai scope')
  const persistencePackage = JSON.parse(await fs.readFile(path.join(upstreamRoot, 'dsh-session-persistence-jsonl', 'package.json'), 'utf8'))
  assert.equal(persistencePackage.version, '0.1.2-rc.1')
  const reportDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-history-compat-'))
  const manifestPath = path.join(reportDir, 'manifest.json')
  const reportPath = path.join(reportDir, 'report.json')
  t.after(async () => { await fs.rm(reportDir, { recursive: true, force: true }) })
  const manifestDir = reportDir
  const entries = []
  for (const [fixtureName, id] of fixtureSamples) {
    const logicalJsonl = await fs.readFile(path.join(fixtureDir, fixtureName), 'utf8')
    const [header, ...events] = logicalJsonl.trimEnd().split('\n')
    const artifact = Buffer.concat([
      zstdCompressSync(Buffer.from(`${header}\n`, 'utf8')),
      zstdCompressSync(Buffer.from(`${events.join('\n')}\n`, 'utf8')),
    ])
    const sourceRelative = path.join('sources', `${fixtureName}.zstd`)
    const rootRelative = path.join('roots', id)
    const copyRelative = path.join(rootRelative, '_no-cwd', id, 'session.jsonl.zstd')
    const sourcePath = path.join(manifestDir, sourceRelative)
    const copyPath = path.join(manifestDir, copyRelative)
    await fs.mkdir(path.dirname(sourcePath), { recursive: true })
    await fs.mkdir(path.dirname(copyPath), { recursive: true })
    await fs.writeFile(sourcePath, artifact, { flag: 'wx' })
    await fs.writeFile(copyPath, artifact, { flag: 'wx' })
    const sha256 = createHash('sha256').update(artifact).digest('hex')
    entries.push({ source: sourceRelative, copy: copyRelative, root: rootRelative, bytes: artifact.byteLength, sha256 })
  }
  await fs.writeFile(manifestPath, `${JSON.stringify(entries, null, 2)}\n`, 'utf8')
  const result = await runHistoryCompatGate({ manifestPath, reportPath, upstreamRoot })
  assert.equal(result.status, 'PASS')
  assert.equal(result.sampleCount, 3)
  assert.equal(result.sourceUnchanged, true)
  assert.equal(result.copyMutationCount, 0)
  assert.equal(result.rawReadable, true)
  assert.equal(result.sessionLoadCompatible, true)
  assert.equal(result.officialRuntime, 'dsh-session-persistence-jsonl')
  assert.deepEqual(result.errorCategories, {})
  assert.deepEqual(result.contextServices, { sessionStore: true, knownEventCatalog: 51 })
  assert.ok(result.samples.every((sample) => sample.status === 'PASS'))
  assert.ok(result.samples.every((sample) => sample.sourceMatchesManifest === true))
  assert.ok(result.samples.every((sample) => sample.copyMatchesManifest === true))
  assert.ok(result.samples.every((sample) => sample.contextServices.sessionStore === true))
  assert.ok(result.samples.every((sample) => sample.headerReadable === true))
  assert.ok(result.samples.every((sample) => sample.eventReadable === true))
  assert.ok(result.samples.every((sample) => sample.rawReadable === true))
  assert.ok(result.samples.every((sample) => sample.sessionLoadCompatible === true))
  assert.ok(result.samples.every((sample) => sample.incompatibleEvents.length === 0))
  assert.ok(result.samples.every((sample) => sample.compatibilityReason === 'official-inspect-and-load-succeeded'))
  assert.ok(result.samples.every((sample) => sample.projection.readable === false))
  const report = JSON.parse(await fs.readFile(reportPath, 'utf8'))
  assert.equal(report.status, 'PASS')
  assert.equal(report.sampleCount, 3)
  assert.equal(report.rawReadable, true)
  assert.equal(report.sessionLoadCompatible, true)
  const serialized = JSON.stringify(report)
  assert.equal(serialized.includes('session.jsonl'), false)
  const forbiddenKeys = new Set(['title', 'content', 'message', 'sessionId', 'path', 'id', 'body'])
  const containsForbiddenKey = (value) => Array.isArray(value)
    ? value.some((item) => item && typeof item === 'object' && containsForbiddenKey(item))
    : value && typeof value === 'object'
      ? Object.entries(value).some(([key, item]) => forbiddenKeys.has(key) || containsForbiddenKey(item))
      : false
  assert.equal(containsForbiddenKey(report), false)
})
