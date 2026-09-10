import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

export const RC1_PACKAGE_DIRS = Object.freeze([
  'mobile-bootstrap-rc1',
  'mobile-interactions-compat-rc1',
  'mobile-controller-compat-rc1',
  'mobile-session-sync-rc1',
  'mobile-stream-compat-rc1',
  'rc1-host-carriers',
  'browser-host-hub-rc1',
  'ui-directory-picker-browse',
  'subscriptions-compat-rc1',
  'model-menu-filter',
  'ui-workspace-menu-compat-rc1',
])

const DEPENDENCY_FIELDS = Object.freeze(['dependencies', 'optionalDependencies', 'devDependencies', 'peerDependencies'])
const sourceDefault = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

const sha256 = value => createHash('sha256').update(value).digest('hex')
const fileHash = file => sha256(fs.readFileSync(file))
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const safeName = value => typeof value === 'string' && value !== '' && !value.includes('lab-targets')
const pathParts = value => path.resolve(value).split(/[\\/]+/).filter(Boolean).map(part => part.toLowerCase())

function assertReleaseBoundary(value, label) {
  if (pathParts(value).includes('lab-targets')) throw new Error(`${label.toUpperCase()}_LAB_TARGETS_FORBIDDEN`)
}

function inside(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function readPackage(sourceRoot, directory) {
  const packageDir = path.join(sourceRoot, 'packages', directory)
  const manifestPath = path.join(packageDir, 'package.json')
  if (!fs.existsSync(manifestPath)) throw new Error(`PACKAGE_MANIFEST_MISSING_${directory}`)
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (!safeName(manifest.name) || typeof manifest.version !== 'string' || !Array.isArray(manifest.files)) throw new Error(`PACKAGE_MANIFEST_INVALID_${directory}`)
  return { directory, packageDir, manifest }
}

function walkFiles(root, relative = '') {
  const directory = path.join(root, relative)
  const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  const files = []
  for (const entry of entries) {
    const child = path.join(relative, entry.name)
    const source = path.join(root, child)
    if (entry.isSymbolicLink()) throw new Error(`PACKAGE_SYMLINK_FORBIDDEN_${child}`)
    if (entry.isDirectory()) files.push(...walkFiles(root, child))
    else if (entry.isFile()) files.push(child)
    else throw new Error(`PACKAGE_ENTRY_UNSUPPORTED_${child}`)
  }
  return files
}

function declaredSourceFiles(item) {
  const relative = new Set(['package.json'])
  for (const entry of item.manifest.files) {
    if (typeof entry !== 'string' || entry === '' || path.isAbsolute(entry) || entry.split(/[\\/]/).includes('..')) throw new Error(`PACKAGE_FILE_ENTRY_INVALID_${item.directory}`)
    const target = path.resolve(item.packageDir, entry)
    if (!inside(item.packageDir, target) || !fs.existsSync(target)) throw new Error(`PACKAGE_FILE_ENTRY_MISSING_${item.directory}`)
    const stat = fs.lstatSync(target)
    if (stat.isSymbolicLink()) throw new Error(`PACKAGE_SYMLINK_FORBIDDEN_${item.directory}`)
    if (stat.isDirectory()) for (const child of walkFiles(item.packageDir, entry)) relative.add(child)
    else if (stat.isFile()) relative.add(entry)
    else throw new Error(`PACKAGE_FILE_ENTRY_UNSUPPORTED_${item.directory}`)
  }
  return [...relative].sort((a, b) => a.localeCompare(b))
}

function sourceHashEntries(items, sourceRoot) {
  const files = []
  for (const item of items) {
    const inputs = new Set(declaredSourceFiles(item))
    // Compiled UI packages publish lib/, but provenance must also identify the
    // TypeScript and bundler configuration used to produce that artifact.
    if (!inputs.has(path.join('src', 'index.ts')) && fs.existsSync(path.join(item.packageDir, 'src'))) {
      for (const relative of walkFiles(item.packageDir, 'src')) inputs.add(relative)
    }
    for (const relative of ['tsdown.config.mjs', 'tsconfig.json']) {
      if (fs.existsSync(path.join(item.packageDir, relative))) inputs.add(relative)
    }
    for (const relative of inputs) files.push({ path: path.posix.join('packages', item.directory, relative.replaceAll(path.sep, '/')), sha256: fileHash(path.join(item.packageDir, relative)) })
  }
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

function gitFacts(sourceRoot) {
  try {
    const gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8', windowsHide: true }).trim()
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: sourceRoot, encoding: 'utf8', windowsHide: true })
    return { gitHead, gitDirty: status.trim() !== '' }
  } catch {
    return { gitHead: undefined, gitDirty: undefined }
  }
}

function rewriteWorkspaceDependencies(manifest, versions, packageDirectory) {
  const rewrites = []
  const copy = structuredClone(manifest)
  for (const field of DEPENDENCY_FIELDS) {
    if (!isRecord(copy[field])) continue
    for (const [name, value] of Object.entries(copy[field])) {
      if (typeof value !== 'string' || !value.startsWith('workspace:')) continue
      const version = versions.get(name)
      if (version === undefined) throw new Error(`WORKSPACE_DEPENDENCY_NOT_IN_RELEASE_${packageDirectory}_${name}`)
      copy[field][name] = version
      rewrites.push({ field, name, from: value, to: version })
    }
  }
  return { manifest: copy, rewrites }
}

function copyPackage(source, destination, manifest) {
  fs.mkdirSync(destination, { recursive: true })
  fs.writeFileSync(path.join(destination, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  for (const relative of declaredSourceFiles(source).filter(file => file !== 'package.json')) {
    const from = path.join(source.packageDir, relative)
    const to = path.join(destination, relative)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(from, to)
  }
}

function npmPack(cwd, stagingDir) {
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (!fs.existsSync(npmCli)) throw new Error('NPM_CLI_NOT_FOUND')
  const output = execFileSync(process.execPath, [npmCli, 'pack', '--offline', '--ignore-scripts', '--pack-destination', stagingDir, '--json'], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false', npm_config_offline: 'true' },
  })
  const result = JSON.parse(output)
  const entry = Array.isArray(result) ? result[0] : result
  if (!entry || typeof entry.filename !== 'string') throw new Error('NPM_PACK_RESULT_INVALID')
  return path.resolve(stagingDir, entry.filename)
}

export function buildRelease({ sourceRoot = sourceDefault, stagingDir } = {}) {
  sourceRoot = path.resolve(sourceRoot)
  if (typeof stagingDir !== 'string' || stagingDir === '') throw new Error('STAGING_DIRECTORY_REQUIRED')
  stagingDir = path.resolve(stagingDir)
  assertReleaseBoundary(sourceRoot, 'source')
  assertReleaseBoundary(stagingDir, 'staging')
  if (inside(sourceRoot, stagingDir)) throw new Error('STAGING_INSIDE_SOURCE_FORBIDDEN')
  if (fs.existsSync(stagingDir) && fs.readdirSync(stagingDir).length !== 0) throw new Error('STAGING_NOT_EMPTY')
  fs.mkdirSync(stagingDir, { recursive: true })

  const items = RC1_PACKAGE_DIRS.map(directory => readPackage(sourceRoot, directory))
  const names = new Set()
  const versions = new Map()
  for (const item of items) {
    if (names.has(item.manifest.name)) throw new Error(`DUPLICATE_RELEASE_PACKAGE_${item.manifest.name}`)
    names.add(item.manifest.name); versions.set(item.manifest.name, item.manifest.version)
  }
  const sourceFiles = sourceHashEntries(items, sourceRoot)
  const sourceTreeHash = sha256(JSON.stringify(sourceFiles))
  const facts = gitFacts(sourceRoot)
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rc1-release-'))
  const generated = []
  const packages = []
  try {
    for (const item of items) {
      const rewritten = rewriteWorkspaceDependencies(item.manifest, versions, item.directory)
      const temporaryPackage = path.join(temporary, item.directory)
      copyPackage(item, temporaryPackage, rewritten.manifest)
      const artifact = npmPack(temporaryPackage, stagingDir)
      generated.push(artifact)
      const artifactSha256 = fileHash(artifact)
      const sidecar = `${artifact}.sha256`
      fs.writeFileSync(sidecar, `${artifactSha256}  ${path.basename(artifact)}\n`)
      generated.push(sidecar)
      packages.push({ directory: item.directory, name: item.manifest.name, version: item.manifest.version, artifact: path.basename(artifact), artifactSha256, sourceFiles: sourceFiles.filter(file => file.path.startsWith(`packages/${item.directory}/`)), workspaceDependencyRewrites: rewritten.rewrites })
    }
    const manifest = {
      releaseStatus: 'candidate',
      sourceCommitFrozen: false,
      sourceTreeHash,
      ...(facts.gitHead ? { gitHead: facts.gitHead } : {}),
      ...(facts.gitDirty === undefined ? {} : { gitDirty: facts.gitDirty }),
      packageCount: packages.length,
      packages,
    }
    const hashes = { releaseStatus: 'candidate', sourceTreeHash, files: sourceFiles }
    fs.writeFileSync(path.join(stagingDir, 'rc1-release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    fs.writeFileSync(path.join(stagingDir, 'source-content-hashes.json'), `${JSON.stringify(hashes, null, 2)}\n`)
    return { ...manifest, stagingDir, sourceContentHashManifest: 'source-content-hashes.json', releaseManifest: 'rc1-release-manifest.json' }
  } catch (error) {
    for (const file of generated) try { fs.rmSync(file, { force: true }) } catch { /* only remove this run's artifacts */ }
    throw error
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}

function parseArgs(argv) {
  let sourceRoot = sourceDefault
  let stagingDir
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--source') sourceRoot = argv[++index]
    else if (argument === '--staging') stagingDir = argv[++index]
    else if (!argument.startsWith('-') && stagingDir === undefined) stagingDir = argument
    else throw new Error('USAGE: rc1-package-release.mjs --staging <lab/artifacts/staging> [--source <worktree>]')
  }
  return { sourceRoot, stagingDir }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = buildRelease(parseArgs(process.argv.slice(2)))
    console.log(JSON.stringify({ releaseStatus: result.releaseStatus, sourceCommitFrozen: result.sourceCommitFrozen, sourceTreeHash: result.sourceTreeHash, packageCount: result.packageCount, stagingDir: result.stagingDir }))
  } catch (error) {
    const code = typeof error?.message === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.message) ? error.message : 'RELEASE_FAILED'
    console.error(JSON.stringify({ releaseStatus: 'failed', code }))
    process.exitCode = 1
  }
}
