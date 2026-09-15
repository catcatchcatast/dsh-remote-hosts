import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'

const [oldScope, newScope, probeRoot, reportPath] = process.argv.slice(2)
if (!oldScope || !newScope || !probeRoot || !reportPath) throw new Error('USAGE: official-regression-probes.mjs <old-scope> <new-scope> <empty-probe-dir> <report>')
await fs.mkdir(probeRoot, { recursive: true })
assert.equal((await fs.readdir(probeRoot)).length, 0, 'probe requires an empty isolated directory')
const oldPackage = JSON.parse(await fs.readFile(path.join(oldScope, 'dsh-session-persistence/package.json'), 'utf8'))
assert.equal(oldPackage.version, '0.1.2-rc.1')
const oldCode = await fs.readFile(path.join(oldScope, 'dsh-session-persistence/lib/index.js'), 'utf8')
const start = oldCode.indexOf('var SessionPreparations = class {')
const end = oldCode.indexOf('\n};', start)
assert.ok(start >= 0 && end > start, 'the pinned old class must exist')
// Execute the exact installed class in a separate test object, never in the running process.
const Preparations = new Function(`${oldCode.slice(start, end + 3)}; return SessionPreparations;`)()
const pool = new Preparations(5)
const borrowed = []
for (let i = 0; i < 5; i++) borrowed.push(await pool.borrow(`held-${i}`, async () => ({ session: { id: `held-${i}` } })))
let loads = 0, commits = 0
const load = async () => { loads++; return { session: { id: 'cold' } } }
const commit = async source => { commits++; return { source, state: {} } }
for (let i = 0; i < 12; i++) assert.equal(await pool.reserve('cold', load, commit), undefined)
assert.equal(loads, 12); assert.equal(commits, 0)
const pinnedResult = { attempts: 12, loads, commits }
borrowed[0][Symbol.dispose]()
const resumed = await pool.reserve('cold', load, commit)
assert.ok(resumed); assert.equal(commits, 1)
pool.discard(resumed)
for (const handle of borrowed) handle[Symbol.dispose]()

const moduleAt = name => import(pathToFileURL(path.join(newScope, name, 'lib/index.js')).href)
const { Context } = await moduleAt('cordis')
const { default: Persistence } = await moduleAt('dsh-session-persistence-jsonl')
const { sessionFormatCatalog } = await moduleAt('dsh-session-format-catalog')
const makeContext = () => { const ctx = new Context(); ctx.provide('logger', { warn() {}, info() {}, error() {}, debug() {} }); return ctx }
let ctx = makeContext(), persistence = new Persistence(ctx, { root: probeRoot, compression: 'zstd' })
for (let i = 0; i < 16; i++) {
  const h = await persistence.create({ id: `session-probe-${i}`, version: 3, createdAt: 0, cwd: path.resolve(probeRoot), delegationDepth: 0, isSeeded: false })
  await h.flush(); await h.close()
}
await ctx.fiber.dispose()
ctx = makeContext(); persistence = new Persistence(ctx, { root: probeRoot, compression: 'zstd' })
const held = [], begin = performance.now()
try {
  for (let i = 0; i < 10; i++) {
    const h = await persistence.open(`session-probe-${i}`, 'read')
    await h.read(0); held.push(h)
  }
  for (let i = 10; i < 16; i++) {
    const h = await persistence.open(`session-probe-${i}`, 'write', { signal: AbortSignal.timeout(3000) })
    await h.read(0); await h.close(); await h.close()
  }
  const owned = await persistence.open('session-probe-15', 'write')
  await assert.rejects(persistence.open('session-probe-15', 'write'), { name: 'SessionAlreadyOwnedError' })
  await owned.close()
  const cancelled = new AbortController(); cancelled.abort()
  await assert.rejects(persistence.open('session-probe-15', 'read', { signal: cancelled.signal }), { name: 'AbortError' })
} finally {
  await Promise.all(held.map(h => h.close()))
  await ctx.fiber.dispose()
}

const descriptorResults = []
for (const version of [2, 3]) {
  const restore = sessionFormatCatalog.createRestore({ type: 'session', version: 0, id: 'session-fixture', createdAt: 0, cwd: path.resolve(probeRoot), delegationDepth: 1, origin: 'subagent' }, { recovery: 'strict', validation: 'transformed' })
  try {
    restore.decodeRow({ type: 'subagent/descriptor', seq: 0, time: 0, data: { version, mode: 'one-shot', provider: 'fixture', label: 'fixture' } })
    descriptorResults.push({ version, payloadAccepted: true })
  } catch (error) {
    descriptorResults.push({ version, payloadAccepted: false, errorClass: error.name, reason: error.message })
  }
}
assert.equal(descriptorResults[0].payloadAccepted, false)
assert.equal(descriptorResults[1].payloadAccepted, true)
const report = {
  oldRuntime: oldPackage.version,
  oldPersistenceSha256: createHash('sha256').update(oldCode).digest('hex'),
  oldPinned: pinnedResult, oldAfterRelease: { loads, commits },
  newRuntime: '0.1.5-rc.2', newColdOpen: { heldReaders: held.length, completedWriters: 6, cancellation: 'PASS', ownership: 'PASS', durationMs: Math.round(performance.now() - begin) },
  migrationDescriptorProbe: descriptorResults,
  deploymentGate: 'BLOCKED_BY_HISTORY_MIGRATION',
}
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report))
