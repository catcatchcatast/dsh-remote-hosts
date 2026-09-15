import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'

const digest = value => createHash('sha256').update(value).digest('hex')
const inside = (root, target) => { const rel = path.relative(root, target); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)) }

async function regularFiles(root, relative = '') {
  const result = []
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const rel = path.join(relative, entry.name)
    const stat = await fs.lstat(path.join(root, rel))
    if (stat.isSymbolicLink()) throw new Error('HISTORY_REPARSE_POINT_REFUSED')
    if (stat.isDirectory()) result.push(...await regularFiles(root, rel))
    else if (stat.isFile()) result.push(rel)
    else throw new Error('HISTORY_NON_REGULAR_FILE_REFUSED')
  }
  return result.sort()
}

/** Copy a read-only source with before/after checks; never call an upstream writer on it. */
export async function snapshotHistory(sourceRoot, copyRoot) {
  sourceRoot = await fs.realpath(sourceRoot)
  copyRoot = path.resolve(copyRoot)
  if (inside(sourceRoot, copyRoot) || inside(copyRoot, sourceRoot)) throw new Error('HISTORY_COPY_OVERLAPS_SOURCE')
  await fs.mkdir(copyRoot, { recursive: true })
  if ((await fs.readdir(copyRoot)).length) throw new Error('HISTORY_COPY_NOT_EMPTY')
  const manifest = []
  for (const relative of await regularFiles(sourceRoot)) {
    const from = path.join(sourceRoot, relative), to = path.join(copyRoot, relative)
    const bytes = await fs.readFile(from)
    await fs.mkdir(path.dirname(to), { recursive: true })
    await fs.writeFile(to, bytes, { flag: 'wx' })
    const sha256 = digest(bytes)
    if (digest(await fs.readFile(from)) !== sha256) throw new Error('SOURCE_CHANGED_DURING_SNAPSHOT')
    manifest.push({ relative, bytes: bytes.length, sha256 })
  }
  return { sourceRoot, copyRoot, files: manifest }
}

const eventFingerprint = (header, inheritedEventCount, events) => digest(JSON.stringify({ header, inheritedEventCount, events }))

/** Real upstream migration on copies; reports contain no identities, bodies or private paths. */
export async function verifyOfficialMigration({ upstreamRoot, snapshot, reportPath }) {
  const moduleAt = async name => import(pathToFileURL(path.join(upstreamRoot, name, 'lib/index.js')).href)
  const { Context } = await moduleAt('cordis')
  const { default: JsonlSessionPersistence } = await moduleAt('dsh-session-persistence-jsonl')
  const ctx = new Context()
  ctx.provide('logger', { warn() {}, info() {}, error() {}, debug() {} })
  const persistence = new JsonlSessionPersistence(ctx, { root: snapshot.copyRoot, compression: 'zstd' })
  const started = performance.now(), rows = [], held = []
  try {
    const catalog = await persistence.list({ signal: AbortSignal.timeout(60000) })
    // Hold > old cache capacity while opening additional cold sessions.
    for (const item of catalog.slice(0, 10)) {
      try { held.push(await persistence.open(item.header.id, 'read', { signal: AbortSignal.timeout(30000) })) } catch { /* each failure is captured below */ }
    }
    for (let index = 0; index < catalog.length; index++) {
      const { header } = catalog[index]
      const row = { sample: index + 1, status: 'FAIL' }, begin = performance.now()
      let reader, writer, reopened
      try {
        reader = await persistence.open(header.id, 'read', { signal: AbortSignal.timeout(30000) })
        const before = await reader.read(0, undefined, { signal: AbortSignal.timeout(30000) })
        const expected = eventFingerprint(reader.header, reader.inheritedEventCount, before.events)
        writer = await persistence.open(header.id, 'write', { signal: AbortSignal.timeout(30000) })
        await writer.flush({ signal: AbortSignal.timeout(30000) })
        await writer.close(); writer = undefined
        reopened = await persistence.open(header.id, 'read', { signal: AbortSignal.timeout(30000) })
        const after = await reopened.read(0, undefined, { signal: AbortSignal.timeout(30000) })
        const actual = eventFingerprint(reopened.header, reopened.inheritedEventCount, after.events)
        if (expected !== actual) throw Object.assign(new Error(), { code: 'MIGRATED_DATA_CHANGED' })
        if (after.events.some((event, seq) => event.seq !== seq)) throw Object.assign(new Error(), { code: 'NONCONTIGUOUS_EVENTS' })
        Object.assign(row, { status: 'PASS', eventCount: after.events.length, contentFingerprint: actual })
      } catch (error) {
        row.errorClass = error?.name ?? 'Error'
        if (/^[A-Z_]+$/.test(error?.code ?? '')) row.errorCode = error.code
        // Error messages may contain paths/body; retain them only in caller-owned private diagnostics if needed.
      } finally {
        for (const handle of [reader, writer, reopened]) if (handle) await handle.close().catch(() => {})
      }
      row.durationMs = Math.round(performance.now() - begin)
      rows.push(row)
      if (rows.length % 25 === 0) console.log(JSON.stringify({ phase: 'migration', checked: rows.length, total: catalog.length, failed: rows.filter(row => row.status !== 'PASS').length }))
    }
    const sourceChanges = []
    for (const file of snapshot.files) {
      if (digest(await fs.readFile(path.join(snapshot.sourceRoot, file.relative))) !== file.sha256) sourceChanges.push(file)
    }
    const after = await persistence.list({ signal: AbortSignal.timeout(60000) })
    const sameIds = JSON.stringify(catalog.map(row => row.header.id).sort()) === JSON.stringify(after.map(row => row.header.id).sort())
    const report = {
      status: rows.length > 0 && rows.every(row => row.status === 'PASS') && sameIds && sourceChanges.length === 0 ? 'PASS' : 'FAIL',
      runtimeVersion: '0.1.5-rc.2', sampleCount: catalog.length, passed: rows.filter(row => row.status === 'PASS').length,
      failed: rows.filter(row => row.status !== 'PASS').length, sameSessionIdentities: sameIds,
      sourceUnchanged: sourceChanges.length === 0, sourceChangedFileCount: sourceChanges.length,
      heldReadHandles: held.length, durationMs: Math.round(performance.now() - started), rows,
    }
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
    return report
  } finally {
    await Promise.allSettled(held.map(handle => handle.close()))
    await ctx.fiber.dispose()
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [sourceRoot, copyRoot, upstreamRoot, reportPath] = process.argv.slice(2)
  if (!sourceRoot || !copyRoot || !upstreamRoot || !reportPath) throw new Error('USAGE: official-history-migration-gate.mjs <source> <empty-copy> <official-scope-root> <report>')
  const snapshot = await snapshotHistory(sourceRoot, copyRoot)
  console.log(JSON.stringify({ phase: 'snapshot', files: snapshot.files.length, bytes: snapshot.files.reduce((n, row) => n + row.bytes, 0) }))
  const result = await verifyOfficialMigration({ upstreamRoot, snapshot, reportPath })
  console.log(JSON.stringify({ status: result.status, sampleCount: result.sampleCount, passed: result.passed, failed: result.failed, durationMs: result.durationMs }))
  if (result.status !== 'PASS') process.exitCode = 1
}
