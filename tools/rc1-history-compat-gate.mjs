import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const EXPECTED_HASH = /^[a-f0-9]{64}$/i

/**
 * Keep persistence failures machine-readable without exposing the official
 * error message, which may contain a session identity or a raw-log path.
 */
export function classifyPersistenceError(error) {
  const name = String(error?.name ?? error?.constructor?.name ?? '')
  if (name === 'SessionPersistenceCorruptionError') return 'persistence-corruption'
  if (name === 'SessionFormatUnsupportedError') return 'format-unsupported'
  if (name === 'SessionPersistenceNotFoundError') return 'not-found'
  if (name === 'AbortError') return 'cancelled'
  if (error?.code === 'ENOENT') return 'missing'
  if (name === 'TypeError' || name === 'RangeError') return 'validation'
  if (name === 'Error' || name.length === 0) return 'runtime-error'
  return 'runtime-error'
}

/** Summarize only the official decoder's returned sequence values. */
export function summarizeOfficialEvents(events) {
  if (!Array.isArray(events)) return { eventCount: 0, invalidSeqCount: 1, gapCount: 0, duplicateCount: 0, firstSeq: null, lastSeq: null, sequenceSha256: null, contiguous: false }
  const digest = createHash('sha256')
  let invalidSeqCount = 0
  let gapCount = 0
  let duplicateCount = 0
  let firstSeq = null
  let lastSeq = null
  let previous
  for (const event of events) {
    const seq = event?.seq
    if (!Number.isSafeInteger(seq) || seq < 0) {
      invalidSeqCount += 1
      continue
    }
    if (firstSeq === null) firstSeq = seq
    if (previous !== undefined) {
      if (seq === previous) duplicateCount += 1
      else if (seq !== previous + 1) gapCount += 1
    }
    previous = seq
    lastSeq = seq
    digest.update(`${seq}\n`)
  }
  return {
    eventCount: events.length,
    invalidSeqCount,
    gapCount,
    duplicateCount,
    firstSeq,
    lastSeq,
    sequenceSha256: digest.digest('hex'),
    contiguous: invalidSeqCount === 0 && gapCount === 0 && duplicateCount === 0,
  }
}

/**
 * Summarize event vocabulary rejected by the official persistence coordinator.
 * The input is the official `readFrom()` result; no raw JSONL parsing is used.
 * Keep only the type, sequence positions, and envelope/data field names.
 */
export function summarizeUnsupportedEvents(events, knownTypes) {
  const known = knownTypes instanceof Set ? knownTypes : new Set()
  if (!Array.isArray(events)) return []
  const groups = new Map()
  for (const event of events) {
    if (event && known.has(event.type)) continue
    if (event?.ignorable === true) continue
    const type = typeof event?.type === 'string' && event.type.length > 0 ? event.type : '<missing>'
    let group = groups.get(type)
    if (!group) {
      group = {
        type,
        count: 0,
        seqs: [],
        eventFields: new Set(),
        dataFields: new Set(),
      }
      groups.set(type, group)
    }
    group.count += 1
    if (Number.isSafeInteger(event?.seq) && event.seq >= 0) group.seqs.push(event.seq)
    for (const field of Object.keys(event ?? {})) group.eventFields.add(field)
    if (event?.data && typeof event.data === 'object' && !Array.isArray(event.data)) {
      for (const field of Object.keys(event.data)) group.dataFields.add(field)
    }
  }
  return [...groups.values()].map((group) => ({
    type: group.type,
    count: group.count,
    seqs: group.seqs,
    eventFields: [...group.eventFields].sort(),
    dataFields: [...group.dataFields].sort(),
  }))
}

/** Compatibility is true only when BOTH official logical reads succeed. */
export function isSessionLoadCompatible(operations, headerCount) {
  return Number.isSafeInteger(headerCount) && headerCount > 0 && operations?.inspect?.succeeded === headerCount && operations?.load?.succeeded === headerCount
}

async function hashFile(filePath) {
  const bytes = await fs.readFile(filePath)
  return { bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') }
}

function isWithin(parent, target) {
  const relative = path.relative(path.resolve(parent), path.resolve(target))
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function asManifestEntries(value) {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError('manifest must contain samples')
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('manifest sample must be an object')
    if (typeof item.source !== 'string' || typeof item.copy !== 'string' || typeof item.root !== 'string') throw new TypeError('manifest sample paths are required')
    if (!Number.isSafeInteger(item.bytes) || item.bytes < 0 || typeof item.sha256 !== 'string' || !EXPECTED_HASH.test(item.sha256)) throw new TypeError('manifest sample digest is invalid')
    return item
  })
}

async function loadManifest(manifestPath) {
  try {
    return asManifestEntries(JSON.parse(await fs.readFile(manifestPath, 'utf8')))
  } catch (error) {
    const wrapped = new Error('history compatibility manifest is unavailable', { cause: error })
    wrapped.code = 'MANIFEST_INVALID'
    throw wrapped
  }
}

async function loadOfficialRuntime(upstreamRoot) {
  const { Context } = await import(pathToFileURL(path.join(upstreamRoot, 'cordis', 'lib', 'index.js')).href)
  const { KNOWN_SESSION_EVENT_TYPES, SessionStore } = await import(pathToFileURL(path.join(upstreamRoot, 'dsh-session', 'lib', 'index.js')).href)
  const { JsonlSessionPersistence } = await import(pathToFileURL(path.join(upstreamRoot, 'dsh-session-persistence-jsonl', 'lib', 'index.js')).href)
  return { Context, JsonlSessionPersistence, KNOWN_SESSION_EVENT_TYPES, SessionStore }
}

function makeOfficialContext(Context, SessionStore) {
  const ctx = new Context()
  // PersistenceCoordinator.prepareCore() calls the official SessionStore.prepare()
  // path. A list/get stub makes every otherwise-valid history look corrupt by
  // wrapping `sessions.prepare is not a function` in persistence-corruption.
  // The gate must exercise the same official service dependency as rc1.
  new SessionStore(ctx)
  ctx.provide('logger', { warn: () => {} })
  return ctx
}

async function disposeOfficialContext(ctx) {
  try { await ctx?.fiber?.dispose?.() } catch { /* keep the read result */ }
}

async function withPersistence(runtime, root, operation) {
  const ctx = makeOfficialContext(runtime.Context, runtime.SessionStore)
  try {
    const persistence = new runtime.JsonlSessionPersistence(ctx, {
      root,
      compression: 'zstd',
      packChunks: true,
    })
    return await operation(persistence)
  } finally {
    await disposeOfficialContext(ctx)
  }
}

async function readOfficialStage(runtime, root, id, stage) {
  try {
    const value = await withPersistence(runtime, root, async (persistence) => {
      if (stage === 'readRaw') return persistence.readRaw(id)
      if (stage === 'inspect') return persistence.inspect(id)
      if (stage === 'readFrom') return persistence.readFrom(id, 0)
      if (stage === 'load') return persistence.load(id)
      throw new TypeError('unknown persistence stage')
    })
    if (stage === 'readRaw') {
      if (!value || typeof value.content !== 'string') throw new TypeError('official raw read returned no content')
      return {
        ok: true,
        contentBytes: Buffer.byteLength(value.content, 'utf8'),
        headerReadable: !!value.meta,
        inheritedEventCount: Number.isSafeInteger(value.inheritedEventCount) ? value.inheritedEventCount : null,
        projectionReadable: false,
        unsupportedEvents: [],
      }
    }
    const summary = summarizeOfficialEvents(value?.events)
    return {
      ok: true,
      ...summary,
      headerReadable: !!value?.meta,
      inheritedEventCount: Number.isSafeInteger(value?.inheritedEventCount) ? value.inheritedEventCount : null,
      projectionReadable: false,
      unsupportedEvents: summarizeUnsupportedEvents(value?.events, runtime.KNOWN_SESSION_EVENT_TYPES),
    }
  } catch (error) {
    return { ok: false, errorCategory: classifyPersistenceError(error), unsupportedEvents: [] }
  }
}

function mergeUnsupportedEvents(results) {
  const merged = new Map()
  for (const result of results) {
    for (const item of result.unsupportedEvents ?? []) {
      let group = merged.get(item.type)
      if (!group) {
        group = {
          type: item.type,
          count: 0,
          seqs: [],
          eventFields: new Set(),
          dataFields: new Set(),
        }
        merged.set(item.type, group)
      }
      group.count += item.count
      group.seqs.push(...item.seqs)
      for (const field of item.eventFields) group.eventFields.add(field)
      for (const field of item.dataFields) group.dataFields.add(field)
    }
  }
  return [...merged.values()].map((group) => ({
    type: group.type,
    count: group.count,
    seqs: group.seqs,
    eventFields: [...group.eventFields].sort(),
    dataFields: [...group.dataFields].sort(),
  }))
}

function countErrors(operationResults) {
  const categories = {}
  for (const result of operationResults) {
    for (const item of result) {
      if (!item.ok) categories[item.errorCategory] = (categories[item.errorCategory] ?? 0) + 1
    }
  }
  return Object.fromEntries(Object.entries(categories).sort(([left], [right]) => left.localeCompare(right)))
}

function operationSummary(results) {
  const successful = results.filter((item) => item.ok)
  const failed = results.filter((item) => !item.ok)
  const summary = {
    attempted: results.length,
    succeeded: successful.length,
    failed: failed.length,
    errorCategories: Object.fromEntries(Object.entries(failed.reduce((map, item) => {
      map[item.errorCategory] = (map[item.errorCategory] ?? 0) + 1
      return map
    }, {})).sort(([left], [right]) => left.localeCompare(right))),
  }
  const eventResults = successful.filter((item) => Object.hasOwn(item, 'eventCount'))
  if (eventResults.length > 0) {
    summary.eventCount = eventResults.reduce((total, item) => total + item.eventCount, 0)
    summary.firstSeq = eventResults.map((item) => item.firstSeq).filter((value) => value !== null).sort((left, right) => left - right)[0] ?? null
    summary.lastSeq = eventResults.map((item) => item.lastSeq).filter((value) => value !== null).sort((left, right) => right - left)[0] ?? null
    summary.contiguous = eventResults.every((item) => item.contiguous === true)
    summary.invalidSeqCount = eventResults.reduce((total, item) => total + (item.invalidSeqCount ?? 0), 0)
    summary.gapCount = eventResults.reduce((total, item) => total + (item.gapCount ?? 0), 0)
    summary.duplicateCount = eventResults.reduce((total, item) => total + (item.duplicateCount ?? 0), 0)
  }
  const rawResults = successful.filter((item) => Object.hasOwn(item, 'contentBytes'))
  if (rawResults.length > 0) summary.contentBytes = rawResults.reduce((total, item) => total + item.contentBytes, 0)
  if (successful.length > 0) {
    summary.headerReadable = successful.some((item) => item.headerReadable === true)
    summary.projectionReadable = successful.some((item) => item.projectionReadable === true)
  }
  return summary
}

async function inspectSample(runtime, item, index, manifestDir) {
  const sample = {
    sample: index + 1,
    expectedBytes: item.bytes,
    expectedSha256: item.sha256.toLowerCase(),
    sourceBytes: null,
    sourceSha256Before: null,
    sourceSha256After: null,
    sourceMatchesManifest: false,
    sourceUnchanged: false,
    copyBytesBefore: null,
    copySha256Before: null,
    copyBytesAfter: null,
    copySha256After: null,
    copyChangedByOfficialLoad: false,
    copyMatchesManifest: false,
    headerCount: 0,
    headerVersions: {},
    seededHeaderCount: 0,
    operations: {},
    rawReadable: false,
    sessionLoadCompatible: false,
    incompatibleEvents: [],
    compatibilityReason: 'not-tested',
    projection: { readable: false, reason: 'isolated gate has no domain projection registrations; persistence contract exposes no projection' },
    contextServices: { sessionStore: true, knownEventCatalog: runtime.KNOWN_SESSION_EVENT_TYPES.size },
    status: 'FAIL',
  }
  const source = path.resolve(manifestDir, item.source)
  const copy = path.resolve(manifestDir, item.copy)
  const root = path.resolve(manifestDir, item.root)
  if (!isWithin(manifestDir, root) || !isWithin(root, copy)) {
    sample.errorCategories = { 'artifact-boundary': 1 }
    return sample
  }
  try {
    const [sourceBefore, copyBefore] = await Promise.all([hashFile(source), hashFile(copy)])
    sample.sourceBytes = sourceBefore.bytes
    sample.sourceSha256Before = sourceBefore.sha256
    sample.copyBytesBefore = copyBefore.bytes
    sample.copySha256Before = copyBefore.sha256
    sample.sourceMatchesManifest = sourceBefore.bytes === item.bytes && sourceBefore.sha256 === item.sha256.toLowerCase()
    sample.copyMatchesManifest = copyBefore.bytes === item.bytes && copyBefore.sha256 === item.sha256.toLowerCase()
  } catch (error) {
    sample.errorCategories = { [error?.code === 'ENOENT' ? 'missing' : 'artifact-read']: 1 }
    return sample
  }

  try {
    const listed = await withPersistence(runtime, root, (persistence) => persistence.list())
    if (!Array.isArray(listed)) throw new TypeError('official list returned a non-array')
    sample.headerCount = listed.length
    for (const header of listed) {
      const version = String(header?.version ?? 'unknown')
      sample.headerVersions[version] = (sample.headerVersions[version] ?? 0) + 1
      if (header?.isSeeded === true) sample.seededHeaderCount += 1
    }
    const ids = listed.map((header) => header?.id).filter((id) => typeof id === 'string' && id.length > 0)
    if (ids.length !== listed.length || listed.length === 0) throw new TypeError('official list returned an invalid header')
    const stages = ['readRaw', 'inspect', 'readFrom', 'load']
    const stageResults = Object.fromEntries(stages.map((stage) => [stage, []]))
    for (const id of ids) {
      for (const stage of stages) stageResults[stage].push(await readOfficialStage(runtime, root, id, stage))
    }
    for (const [stage, results] of Object.entries(stageResults)) sample.operations[stage] = operationSummary(results)
    sample.errorCategories = countErrors(Object.values(stageResults))
    sample.headerReadable = sample.operations.readRaw.succeeded === sample.headerCount
    sample.eventReadable = sample.operations.readFrom.succeeded === sample.headerCount && sample.operations.readFrom.contiguous === true
    sample.rawReadable = sample.headerReadable === true && sample.eventReadable === true
    sample.sessionLoadCompatible = isSessionLoadCompatible(sample.operations, sample.headerCount)
    sample.incompatibleEvents = mergeUnsupportedEvents(stageResults.readFrom)
    if (sample.sessionLoadCompatible) sample.compatibilityReason = 'official-inspect-and-load-succeeded'
    else if (sample.incompatibleEvents.length > 0) sample.compatibilityReason = 'unsupported-event-type'
    else if (!sample.rawReadable) sample.compatibilityReason = 'raw-read-failed'
    else sample.compatibilityReason = 'official-session-prepare-rejected'
  } catch (error) {
    sample.errorCategories = { [classifyPersistenceError(error)]: 1 }
    sample.compatibilityReason = 'gate-runtime-error'
  }

  try {
    const sourceAfter = await hashFile(source)
    const copyAfter = await hashFile(copy)
    sample.sourceSha256After = sourceAfter.sha256
    sample.copyBytesAfter = copyAfter.bytes
    sample.copySha256After = copyAfter.sha256
    sample.sourceUnchanged = sourceAfter.bytes === sample.sourceBytes && sourceAfter.sha256 === sample.sourceSha256Before
    sample.copyChangedByOfficialLoad = copyAfter.bytes !== sample.copyBytesBefore || copyAfter.sha256 !== sample.copySha256Before
  } catch (error) {
    sample.errorCategories = { ...(sample.errorCategories ?? {}), [error?.code === 'ENOENT' ? 'missing' : 'artifact-read']: 1 }
  }
  sample.status = sample.headerCount > 0 && sample.sourceMatchesManifest && sample.copyMatchesManifest && sample.sourceUnchanged && sample.rawReadable === true && sample.sessionLoadCompatible === true ? 'PASS' : 'FAIL'
  return sample
}

function defaultUpstreamRoot(manifestPath) {
  return path.resolve(path.dirname(manifestPath), '..', '..', 'runtime', 'upstream', 'node_modules', '@deepseek-ai')
}

function emptyGateResult(errorCategory) {
  return {
    status: 'FAIL',
    sampleCount: 0,
    sourceUnchanged: false,
    copyMutationCount: 0,
    rawReadable: false,
    sessionLoadCompatible: false,
    errorCategories: { [errorCategory]: 1 },
    samples: [],
    officialRuntime: 'unavailable',
    contextServices: { sessionStore: false, knownEventCatalog: 0 },
  }
}

/** Run the real rc1 JSONL persistence gate against manifest copies only. */
export async function runHistoryCompatGate(options = {}) {
  const manifestPath = options && typeof options === 'object' ? options.manifestPath : undefined
  const reportPath = options && typeof options === 'object' ? options.reportPath : undefined
  if (typeof manifestPath !== 'string' || manifestPath.length === 0) return emptyGateResult('manifest-invalid')
  const upstreamRoot = options && typeof options === 'object' ? options.upstreamRoot ?? defaultUpstreamRoot(manifestPath) : defaultUpstreamRoot(manifestPath)
  let entries
  try {
    entries = await loadManifest(manifestPath)
  } catch (error) {
    const result = emptyGateResult(error?.code === 'MANIFEST_INVALID' ? 'manifest-invalid' : 'manifest-read')
    if (reportPath) await fs.writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
    return result
  }
  let runtime
  try {
    runtime = await loadOfficialRuntime(path.resolve(upstreamRoot))
  } catch {
    const result = emptyGateResult('runtime-unavailable')
    if (reportPath) await fs.writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
    return result
  }
  const manifestDir = path.dirname(path.resolve(manifestPath))
  const samples = []
  for (const [index, item] of entries.entries()) samples.push(await inspectSample(runtime, item, index, manifestDir))
  const errorCategories = {}
  for (const sample of samples) for (const [category, count] of Object.entries(sample.errorCategories ?? {})) errorCategories[category] = (errorCategories[category] ?? 0) + count
  const result = {
    status: samples.every((sample) => sample.status === 'PASS') ? 'PASS' : 'FAIL',
    sampleCount: samples.length,
    sourceUnchanged: samples.every((sample) => sample.sourceUnchanged === true),
    copyMutationCount: samples.filter((sample) => sample.copyChangedByOfficialLoad === true).length,
    rawReadable: samples.length > 0 && samples.every((sample) => sample.rawReadable === true),
    sessionLoadCompatible: samples.length > 0 && samples.every((sample) => sample.sessionLoadCompatible === true),
    errorCategories: Object.fromEntries(Object.entries(errorCategories).sort(([left], [right]) => left.localeCompare(right))),
    officialRuntime: 'dsh-session-persistence-jsonl',
    contextServices: { sessionStore: true, knownEventCatalog: runtime.KNOWN_SESSION_EVENT_TYPES.size },
    samples,
  }
  if (reportPath) await fs.writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  return result
}

function consoleResult(result) {
  return {
    status: result.status,
    sampleCount: result.sampleCount,
    sourceUnchanged: result.sourceUnchanged,
    copyMutationCount: result.copyMutationCount,
    rawReadable: result.rawReadable,
    sessionLoadCompatible: result.sessionLoadCompatible,
    errorCategories: result.errorCategories,
  }
}

async function main() {
  const manifestPath = process.argv[2]
  if (!manifestPath) {
    console.error(JSON.stringify(consoleResult(emptyGateResult('manifest-invalid'))))
    process.exitCode = 1
    return
  }
  const reportPath = process.argv[3] ?? path.join(path.dirname(path.resolve(manifestPath)), 'rc1-history-compat-report.json')
  try {
    const result = await runHistoryCompatGate({ manifestPath, reportPath })
    console.log(JSON.stringify(consoleResult(result)))
    process.exitCode = result.status === 'PASS' ? 0 : 1
  } catch (error) {
    console.error(JSON.stringify(consoleResult(emptyGateResult(error?.code === 'ENOENT' ? 'missing' : 'gate-runtime'))))
    process.exitCode = 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
