import { createHash } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_NAME = 'dsh-chat-import'
export const PACKAGE_VERSION = '0.11.0'
export const SOURCE_SHA256 = Object.freeze({
  'index.mjs': 'a8ec3c0aa2b06d79631b598e47ea5f3b2a18517727d2dc978a7477b1a0d11517',
  'lib/backfill.mjs': 'c3c9ded5e2d13e5e59b7efce7213f2fbd7cc94d18ee84e5ac283de9f9f538c82',
  'lib/doctor.mjs': '9868317f3629f2bd50dde970ad801bd2cce3250924f3690f7cc3cc9f67b99042',
  'lib/export-tool.mjs': 'dfe56305530b941ad3be4bf6c6c967b6c3b6ef4769049f8795b09cf1b28f3853',
  'lib/imports.mjs': 'f052dc848bbb561036ef565e3b7fd89a5eb022dbd65d7ba8a766a1f8de1f8253',
  'lib/import-core.mjs': '39da7cf316d70c1cb34158633d06c56ed0568a396d09c36f8efcec7d4d1c766d',
  'lib/purge.mjs': 'f29b9a1decdc42615dc273dcc642a1cde3deecf470992bdb5ae0be75dac9ba9b',
  'lib/retract.mjs': 'e065a6307b787bbce0621973e109513ae1bb650ea885ed0e451d611734631afd',
  'lib/sync-loop.mjs': '7e66a85d85c45ce5d0223bf180e150fa7a111c41df94a2cdbb15d6931ee4f54a',
  'lib/verify.mjs': '4b555e47eaebf2edc844bdece44c6e36c0ab61122addca33333996e74cc5b807',
})

const OLD_LIST_PERSISTED_IDS = `export async function listPersistedIds(ctx) {
  const sp = ctx.get('sessionPersistence')
  if (!sp || typeof sp.list !== 'function') return new Set()
  try {
    return new Set((await sp.list()).map((h) => h.id))
  } catch {
    return new Set()
  }
}`

const NEW_LIST_PERSISTED_IDS = `export async function listPersistedIds(ctx) {
  const persistence = ctx.runtimeInterface?.sessionPersistence
  if (!persistence || typeof persistence.listIds !== 'function') return new Set()
  try {
    return new Set(await persistence.listIds())
  } catch {
    return new Set()
  }
}`

const OLD_STORED_EVENT_COUNT = `export async function storedEventCount(ctx, dshId) {
  const sp = ctx.get('sessionPersistence')
  if (!sp || typeof sp.inspect !== 'function') return null
  try {
    const info = await sp.inspect(dshId)
    return Array.isArray(info && info.events) ? info.events.length : null
  } catch {
    return null
  }
}`

const NEW_STORED_EVENT_COUNT = `export async function storedEventCount(ctx, dshId) {
  const persistence = ctx.runtimeInterface?.sessionPersistence
  if (!persistence || typeof persistence.inspect !== 'function') return null
  try {
    const info = await persistence.inspect(dshId)
    return Number.isSafeInteger(info?.eventCount) && info.eventCount >= 0 ? info.eventCount : null
  } catch {
    return null
  }
}`

const OLD_SESSION_OWNER_PATH = `async function sessionOwnerPath(ctx, dshId) {
  const sp = ctx.get('sessionPersistence')
  let owner = findSourcePathByDshId(lastRegistrySnapshot.imports, dshId)
  if (!sp || typeof sp.inspect !== 'function') return { owner: owner ?? null, readable: null }
  try {
    const info = await sp.inspect(dshId)
    const first = Array.isArray(info && info.events) ? info.events[0] : undefined
    if (!owner && first && first.type === 'session/imported' && first.data && typeof first.data.sourcePath === 'string') {
      owner = first.data.sourcePath
    }
    return { owner: owner ?? null, readable: true }
  } catch {
    // 读不到日志（工件已删 / 后端瞬断）：归属以 registry 反查为准，按不可读处理
    return { owner: owner ?? null, readable: false }
  }
}`

const NEW_SESSION_OWNER_PATH = `async function sessionOwnerPath(ctx, dshId) {
  const persistence = ctx.runtimeInterface?.sessionPersistence
  let owner = findSourcePathByDshId(lastRegistrySnapshot.imports, dshId)
  if (!persistence || typeof persistence.inspect !== 'function') return { owner: owner ?? null, readable: null }
  try {
    const info = await persistence.inspect(dshId)
    if (!owner && typeof info?.legacySourcePath === 'string') owner = info.legacySourcePath
    return { owner: owner ?? null, readable: info?.readable === true }
  } catch {
    // 读不到日志（工件已删 / 后端瞬断）：归属以 registry 反查为准，按不可读处理
    return { owner: owner ?? null, readable: false }
  }
}`

const OLD_CREATE_FALLBACK = `  await ctx.sessionPersistence.create(meta)
  await ctx.sessionPersistence.append(meta.id, events)`
const NEW_CREATE_FALLBACK = `  await ctx.runtimeInterface.sessionPersistence.create(meta, events)`

const OLD_SINGLE_APPEND = `    await ctx.sessionPersistence.append(decision.__targetId, decision.__tailEvents)`
const NEW_SINGLE_APPEND = `    await ctx.runtimeInterface.sessionPersistence.append(decision.__targetId, decision.__tailEvents)`

const OLD_MULTI_APPEND = `      await ctx.sessionPersistence.append(a.targetId, a.events)`
const NEW_MULTI_APPEND = `      await ctx.runtimeInterface.sessionPersistence.append(a.targetId, a.events)`

const OLD_INJECT = `const inject = ['sessionPersistence', 'fs', 'tools']`
const NEW_INJECT = `const inject = ['runtimeInterface', 'fs', 'tools']`

function normalized(value) {
  return String(value).replaceAll('\r\n', '\n')
}

export function sha256(value) {
  let source = normalized(value)
  if (source.startsWith(`${TRACE_POINTER}\n`)) source = source.slice(TRACE_POINTER.length + 1)
  return createHash('sha256').update(source).digest('hex')
}

function withTrace(source) {
  const normalizedSource = normalized(source)
  return normalizedSource.startsWith(`${TRACE_POINTER}\n`) ? normalizedSource : `${TRACE_POINTER}\n${normalizedSource}`
}

function replaceOnce(source, oldBlock, newBlock, label) {
  const occurrences = source.split(oldBlock).length - 1
  if (occurrences !== 1) throw new Error(`${label} anchor count ${occurrences}, expected 1`)
  return source.replace(oldBlock, newBlock)
}

export function patchImportsSource(source) {
  if (typeof source !== 'string') throw new TypeError('imports source must be text')
  let patched = normalized(source)
  patched = replaceOnce(patched, OLD_LIST_PERSISTED_IDS, NEW_LIST_PERSISTED_IDS, 'imports listPersistedIds')
  patched = replaceOnce(patched, OLD_STORED_EVENT_COUNT, NEW_STORED_EVENT_COUNT, 'imports storedEventCount')
  patched = replaceOnce(patched, OLD_SESSION_OWNER_PATH, NEW_SESSION_OWNER_PATH, 'imports sessionOwnerPath')
  return withTrace(patched)
}

export function patchImportCoreSource(source) {
  if (typeof source !== 'string') throw new TypeError('import-core source must be text')
  let patched = normalized(source)
  patched = replaceOnce(patched, OLD_CREATE_FALLBACK, NEW_CREATE_FALLBACK, 'import-core create')
  patched = replaceOnce(patched, OLD_SINGLE_APPEND, NEW_SINGLE_APPEND, 'import-core single append')
  patched = replaceOnce(patched, OLD_MULTI_APPEND, NEW_MULTI_APPEND, 'import-core multi append')
  return withTrace(patched)
}

export function patchIndexSource(source) {
  if (typeof source !== 'string') throw new TypeError('index source must be text')
  return withTrace(replaceOnce(normalized(source), OLD_INJECT, NEW_INJECT, 'index inject'))
}

// The importer package contains read-only export/diagnostic/sync paths in
// addition to the import core.  They all consume the same detached reader;
// patch every one of their old context lookups under the same source SHA
// allowlist so a newly changed upstream file cannot be silently rewritten.
export function patchPersistenceConsumerSource(source, relative) {
  if (typeof source !== 'string') throw new TypeError(`${relative} source must be text`)
  const normalizedSource = normalized(source)
  const oldBlock = `ctx.get('sessionPersistence')`
  const occurrences = normalizedSource.split(oldBlock).length - 1
  if (occurrences < 1) throw new Error(`${relative} persistence lookup count ${occurrences}, expected at least 1`)
  return withTrace(normalizedSource.replaceAll(oldBlock, `ctx.runtimeInterface?.sessionPersistence`))
}

const PATCHERS = Object.freeze({
  'index.mjs': patchIndexSource,
  'lib/backfill.mjs': source => patchPersistenceConsumerSource(source, 'lib/backfill.mjs'),
  'lib/doctor.mjs': source => patchPersistenceConsumerSource(source, 'lib/doctor.mjs'),
  'lib/export-tool.mjs': source => patchPersistenceConsumerSource(source, 'lib/export-tool.mjs'),
  'lib/imports.mjs': patchImportsSource,
  'lib/import-core.mjs': patchImportCoreSource,
  'lib/purge.mjs': source => patchPersistenceConsumerSource(source, 'lib/purge.mjs'),
  'lib/retract.mjs': source => patchPersistenceConsumerSource(source, 'lib/retract.mjs'),
  'lib/sync-loop.mjs': source => patchPersistenceConsumerSource(source, 'lib/sync-loop.mjs'),
  'lib/verify.mjs': source => patchPersistenceConsumerSource(source, 'lib/verify.mjs'),
})

async function readPackageIdentity(packageRoot) {
  const packagePath = join(packageRoot, 'package.json')
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'))
  if (packageJson.name !== PACKAGE_NAME || packageJson.version !== PACKAGE_VERSION || packageJson.main !== './index.mjs') {
    throw new Error(`unexpected package identity: ${packageJson.name}@${packageJson.version}`)
  }
  return packageJson
}

async function atomicReplace(filePath, data) {
  const temporaryPath = `${filePath}.compat-${process.pid}-${Date.now()}.tmp`
  try {
    await writeFile(temporaryPath, data, 'utf8')
    await rename(temporaryPath, filePath)
  } catch (error) {
    await rm(temporaryPath, { force: true })
    throw error
  }
}

/** Apply the allowlisted patch from a read-only source package to a target copy. */
export async function applyPatch({ sourceRoot, targetRoot }) {
  if (typeof sourceRoot !== 'string' || sourceRoot === '') throw new TypeError('sourceRoot is required')
  if (typeof targetRoot !== 'string' || targetRoot === '') throw new TypeError('targetRoot is required')
  sourceRoot = resolve(sourceRoot)
  targetRoot = resolve(targetRoot)
  if (sourceRoot === targetRoot) throw new Error('SOURCE_TARGET_MUST_DIFFER')
  await readPackageIdentity(sourceRoot)
  await readPackageIdentity(targetRoot)

  const targets = new Map()
  for (const relative of Object.keys(PATCHERS)) {
    const sourcePath = join(sourceRoot, relative)
    const targetPath = join(targetRoot, relative)
    const source = normalized(await readFile(sourcePath, 'utf8'))
    const target = normalized(await readFile(targetPath, 'utf8'))
    const sourceHash = sha256(source)
    const targetHash = sha256(target)
    if (sourceHash !== SOURCE_SHA256[relative]) throw new Error(`${relative} source SHA-256 is not allowlisted: ${sourceHash}`)
    if (targetHash !== SOURCE_SHA256[relative]) throw new Error(`${relative} target SHA-256 does not match allowlist: ${targetHash}`)
    targets.set(relative, { path: targetPath, target, sourceHash, targetHash })
  }

  const result = { package: PACKAGE_NAME, version: PACKAGE_VERSION, sourceHashes: {}, targetHashes: {}, patchedHashes: {}, targetPaths: {} }
  const patched = new Map()
  for (const [relative, patcher] of Object.entries(PATCHERS)) {
    const target = targets.get(relative)
    const value = patcher(target.target)
    patched.set(relative, value)
    result.sourceHashes[relative] = SOURCE_SHA256[relative]
    result.targetHashes[relative] = target.targetHash
    result.patchedHashes[relative] = sha256(value)
    result.targetPaths[relative] = target.path
  }
  for (const [relative, value] of patched) await atomicReplace(targets.get(relative).path, value)
  return result
}

function usage() {
  return 'usage: node apply.mjs --source <dsh-chat-import-package-root> --target <dsh-chat-import-package-root>'
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sourceIndex = process.argv.indexOf('--source')
  const targetIndex = process.argv.indexOf('--target')
  if (sourceIndex < 0 || targetIndex < 0 || !process.argv[sourceIndex + 1] || !process.argv[targetIndex + 1]) throw new Error(usage())
  const result = await applyPatch({ sourceRoot: process.argv[sourceIndex + 1], targetRoot: process.argv[targetIndex + 1] })
  console.log(JSON.stringify(result))
}
