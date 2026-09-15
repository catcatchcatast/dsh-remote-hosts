import { createHash } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PRESET_ID = 'standard-depth-1'
export const SUPPORTED_RUNTIME_VERSION = '0.1.5-rc.2'
export const LEGACY_SOURCE_SHA256 = 'a6cdb4ddbe29e1f35c4f1ad6f7d36956922dbcc606fe04afc0549865d0ddde5b'
export const MIGRATED_SOURCE_SHA256 = '6d244cd9ee48f4604ac4bf73d437397b97a2e8e9b09446393deB9aa6323b9905'.toLowerCase()

export function sha256(value) {
  return createHash('sha256').update(String(value).replaceAll('\r\n', '\n')).digest('hex')
}

function fail(message) {
  throw new Error(`preset-persona-config: ${message}`)
}

function lineIndent(line) {
  return line.match(/^\s*/u)?.[0].length ?? 0
}

function validateScalar(lines, index, field) {
  const match = lines[index].match(/^    (prefix|text):(?:[ \t]+(.*))?$/u)
  if (match === null || match[1] !== field) fail(`${field} must be a scalar`)
  const value = match[2]?.trim() ?? ''
  if (value === '' || value === 'null' || value === '~' || value.startsWith('[') || value.startsWith('{')) {
    fail(`${field} must be a non-null scalar`)
  }
  if (/^[>|][-+]?$/u.test(value)) {
    const next = lines[index + 1]
    if (next === undefined || next.trim() === '' || lineIndent(next) <= 4) fail(`${field} block scalar has no content`)
    return
  }
  if (value === '>' || value === '|' || /^(?:true|false|yes|no|null|~|[-+]?\d+(?:\.\d+)?)$/iu.test(value)) {
    fail(`${field} must be a YAML string scalar`)
  }
  if ((value.startsWith("'") && !value.endsWith("'")) || (value.startsWith('"') && !value.endsWith('"'))) {
    fail(`${field} has an unterminated quoted scalar`)
  }
}

function personaRow(lines) {
  const rows = []
  for (let index = 0; index < lines.length; index += 1) {
    if (/^- id: persona$/u.test(lines[index])) rows.push(index)
  }
  if (rows.length !== 1) fail(`expected exactly one ${PRESET_ID} persona row`)
  const start = rows[0]
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^- id: /u.test(lines[index])) {
      end = index
      break
    }
  }
  const row = lines.slice(start, end)
  if (!row.some(line => /^  name: ['"]@deepseek-ai\/dsh-persona['"]$/u.test(line))) {
    fail(`${PRESET_ID} persona row must name @deepseek-ai/dsh-persona`)
  }
  if (row.filter(line => /^  config:$/u.test(line)).length !== 1) fail(`${PRESET_ID} persona row must have one config mapping`)
  return { start, end }
}

export function migratePersonaConfig(source, { runtimeVersion } = {}) {
  if (typeof source !== 'string') throw new TypeError('preset-persona-config: source must be text')
  if (runtimeVersion !== SUPPORTED_RUNTIME_VERSION) fail(`runtime version ${JSON.stringify(runtimeVersion)} is unsupported`)
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  const lines = source.replaceAll('\r\n', '\n').split('\n')
  const { start, end } = personaRow(lines)
  const fields = []
  for (let index = start + 1; index < end; index += 1) {
    const match = lines[index].match(/^    (prefix|text):(?:[ \t]+(.*))?$/u)
    if (match !== null) fields.push({ field: match[1], index })
  }
  const prefixes = fields.filter(item => item.field === 'prefix')
  const texts = fields.filter(item => item.field === 'text')
  if (prefixes.length > 1 || texts.length > 1) fail('persona config has duplicate prefix/text fields')
  if (prefixes.length > 0 && texts.length > 0) fail('persona config cannot contain both text and prefix')
  if (prefixes.length > 0) {
    validateScalar(lines, prefixes[0].index, 'prefix')
    return source
  }
  if (texts.length === 0) fail('persona config requires prefix or legacy text')
  validateScalar(lines, texts[0].index, 'text')
  lines[texts[0].index] = lines[texts[0].index].replace(/^    text:/u, '    prefix:')
  return lines.join('\n').replaceAll('\n', newline)
}

export async function applyPatch({ sourcePath, targetPath = sourcePath, backupPath, runtimeVersion }) {
  if (!sourcePath || !targetPath) throw new TypeError('preset-persona-config: sourcePath and targetPath are required')
  if (!backupPath) fail('backupPath is required for an applying migration')
  const source = await readFile(resolve(sourcePath), 'utf8')
  const sourceHash = sha256(source)
  if (sourceHash !== LEGACY_SOURCE_SHA256 && sourceHash !== MIGRATED_SOURCE_SHA256) fail(`source SHA-256 is not allowlisted: ${sourceHash}`)
  const target = await readFile(resolve(targetPath), 'utf8')
  const targetHash = sha256(target)
  const migrated = migratePersonaConfig(source, { runtimeVersion })
  const migratedHash = sha256(migrated)
  if (targetHash === MIGRATED_SOURCE_SHA256 && target === migrated) return { status: 'already-migrated', sourceHash, targetHash, targetPath: resolve(targetPath) }
  if (targetHash !== LEGACY_SOURCE_SHA256 || target !== source) fail(`target does not match allowlisted legacy source: ${targetHash}`)
  await writeFile(resolve(backupPath), target, { encoding: 'utf8', flag: 'wx' })
  const temporaryPath = `${resolve(targetPath)}.compat-${process.pid}-${Date.now()}.tmp`
  await writeFile(temporaryPath, migrated, 'utf8')
  await rename(temporaryPath, resolve(targetPath))
  return { status: 'migrated', sourceHash, targetHash, migratedHash, targetPath: resolve(targetPath) }
}

function usage() {
  return 'usage: node apply.mjs --source <legacy-preset.yml> --target <candidate-preset.yml> --backup <backup-path> --runtime-version 0.1.5-rc.2'
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const value = flag => {
    const index = process.argv.indexOf(flag)
    return index < 0 ? undefined : process.argv[index + 1]
  }
  const sourcePath = value('--source')
  const targetPath = value('--target')
  const backupPath = value('--backup')
  const runtimeVersion = value('--runtime-version')
  if (!sourcePath || !targetPath || !backupPath || !runtimeVersion) throw new Error(usage())
  console.log(JSON.stringify(await applyPatch({ sourcePath, targetPath, backupPath, runtimeVersion })))
}
