import { createHash } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_NAME = 'dsh-project-panorama-adapter'
export const PACKAGE_VERSION = '0.1.0'
export const SOURCE_SHA256 = 'f84eefb618396361488266b41f788647e31e6953d409428ee15e40037b4d706c'

const OLD_BLOCK = `    serial = serial.then(() => new Promise((resolve) => {
      const child = spawn(pythonExecutable(), [runtime, 'ingest'], {
        windowsHide: true,
        stdio: ['pipe', 'ignore', 'pipe'],
        env: { ...process.env, PROJECT_PANORAMA_RUNTIME: 'dsh', PROJECT_PANORAMA_HOST_ID: hostId },
      })
      let errorBytes = 0
      child.stderr.on('data', (chunk) => { errorBytes += chunk.length })
      child.once('error', () => { safeWarn(ctx, 'spawn'); resolve() })
      child.once('exit', (code) => { if (code) safeWarn(ctx, \`exit-\${code}-\${Math.min(errorBytes, 9999)}\`); resolve() })
      child.stdin.end(encoded)
    })).catch(() => { safeWarn(ctx, 'queue') })`

const NEW_BLOCK = `    serial = serial.then(() => new Promise((resolve) => {
      let child
      try {
        child = spawn(pythonExecutable(), [runtime, 'ingest'], {
          windowsHide: true,
          stdio: ['pipe', 'ignore', 'pipe'],
          env: { ...process.env, PROJECT_PANORAMA_RUNTIME: 'dsh', PROJECT_PANORAMA_HOST_ID: hostId },
        })
      } catch {
        safeWarn(ctx, 'spawn')
        resolve()
        return
      }
      let errorBytes = 0
      let settled = false
      let exitSeen = false
      const finish = (category) => {
        if (settled) return false
        settled = true
        if (category) safeWarn(ctx, category)
        resolve()
        return true
      }
      const failChild = (category) => {
        if (!finish(category)) return
        for (const stream of [child.stdin, child.stderr]) {
          try { stream?.destroy?.() } catch { /* best-effort failed-child cleanup */ }
        }
        try { child.kill?.() } catch { /* best-effort failed-child cleanup */ }
      }
      child.stderr?.on?.('data', (chunk) => { errorBytes += chunk.length })
      child.stderr?.on?.('error', () => { failChild('stderr') })
      child.stdin?.on?.('error', () => { failChild('stdin') })
      child.on('error', () => { failChild('spawn') })
      child.once('exit', (code) => {
        exitSeen = true
        if (!settled && code) safeWarn(ctx, \`exit-\${code}-\${Math.min(errorBytes, 9999)}\`)
        finish()
      })
      child.once('close', (code) => {
        if (!settled && code && !exitSeen) safeWarn(ctx, \`close-\${code}-\${Math.min(errorBytes, 9999)}\`)
        finish()
      })
      try { child.stdin?.end(encoded) } catch { failChild('stdin') }
    })).catch(() => { safeWarn(ctx, 'queue') })`

export function sha256(value) {
  const normalized = String(value).replaceAll('\r\n', '\n')
  const source = normalized.startsWith(`${TRACE_POINTER}\n`) ? normalized.slice(TRACE_POINTER.length + 1) : normalized
  return createHash('sha256').update(source).digest('hex')
}

export function patchAdapterSource(source) {
  if (typeof source !== 'string') throw new TypeError('adapter source must be text')
  const occurrences = source.split(OLD_BLOCK).length - 1
  if (occurrences !== 1) throw new Error(`adapter source anchor count ${occurrences}, expected 1`)
  return source.replace(OLD_BLOCK, NEW_BLOCK)
}

async function readPackageIdentity(packageRoot) {
  const packagePath = join(packageRoot, 'package.json')
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'))
  if (packageJson.name !== PACKAGE_NAME || packageJson.version !== PACKAGE_VERSION || packageJson.main !== 'src/index.js') {
    throw new Error(`unexpected package identity: ${packageJson.name}@${packageJson.version}`)
  }
  return packageJson
}

export async function applyPatch({ sourcePath, targetRoot }) {
  const source = await readFile(resolve(sourcePath), 'utf8')
  const sourceHash = sha256(source)
  if (sourceHash !== SOURCE_SHA256) throw new Error(`source SHA-256 is not allowlisted: ${sourceHash}`)
  await readPackageIdentity(resolve(targetRoot))
  const targetPath = join(resolve(targetRoot), 'src', 'index.js')
  const target = await readFile(targetPath, 'utf8')
  const targetHash = sha256(target)
  if (targetHash !== SOURCE_SHA256) throw new Error(`target source SHA-256 does not match allowlist: ${targetHash}`)
  const patched = patchAdapterSource(target)
  const temporaryPath = `${targetPath}.compat-${process.pid}-${Date.now()}.tmp`
  await writeFile(temporaryPath, patched, 'utf8')
  await rename(temporaryPath, targetPath)
  return { package: PACKAGE_NAME, version: PACKAGE_VERSION, sourceHash, targetHash, patchedHash: sha256(patched), targetPath }
}

function usage() {
  return 'usage: node apply.mjs --source <adapter-src/index.js> --target <adapter-package-root>'
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sourceIndex = process.argv.indexOf('--source')
  const targetIndex = process.argv.indexOf('--target')
  if (sourceIndex < 0 || targetIndex < 0 || !process.argv[sourceIndex + 1] || !process.argv[targetIndex + 1]) throw new Error(usage())
  const result = await applyPatch({ sourcePath: process.argv[sourceIndex + 1], targetRoot: process.argv[targetIndex + 1] })
  console.log(JSON.stringify(result))
}
