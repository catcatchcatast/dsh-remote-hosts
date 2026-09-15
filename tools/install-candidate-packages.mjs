import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const inside = (root, child) => { const relative = path.relative(root, child); return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) }

/** Prepare only a fresh, explicitly marked candidate. Never discover or write a production profile. */
export function candidatePackageInputs(runtimeRoot, stagingDir) {
  runtimeRoot = path.resolve(runtimeRoot)
  stagingDir = path.resolve(stagingDir)
  if (fs.lstatSync(runtimeRoot).isSymbolicLink() || fs.lstatSync(path.join(runtimeRoot, 'node_modules')).isSymbolicLink()) throw new Error('CANDIDATE_LINKED_RUNTIME_REFUSED')
  const packagePath = path.join(runtimeRoot, 'package.json')
  const manifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
  if (manifest.name !== 'dsh-official-runtime-candidate' || manifest.private !== true) throw new Error('CANDIDATE_MARKER_REQUIRED')
  const official = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8'))
  const officialInputs = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'official-inputs.json'), 'utf8'))
  if (officialInputs.runtimeVersion !== official.version || !Array.isArray(officialInputs.packages) || officialInputs.packages.length === 0) throw new Error('CANDIDATE_OFFICIAL_INPUTS_MISMATCH')
  const release = JSON.parse(fs.readFileSync(path.join(stagingDir, 'rc1-release-manifest.json'), 'utf8'))
  if (release.runtimeVersion !== official.version || !Array.isArray(release.packages) || release.packageCount !== release.packages.length) throw new Error('CANDIDATE_RELEASE_MISMATCH')
  const inputs = []
  for (const item of release.packages) {
    const artifact = path.resolve(stagingDir, item.artifact)
    if (!inside(stagingDir, artifact) || fs.lstatSync(artifact).isSymbolicLink() || hash(artifact) !== item.artifactSha256) throw new Error('CANDIDATE_ARTIFACT_HASH_MISMATCH')
    const specifier = `file:${path.relative(runtimeRoot, artifact).replaceAll(path.sep, '/')}`
    inputs.push({ name: item.name, version: item.version, sha256: item.artifactSha256, specifier })
  }
  const dependencies = { ...manifest.dependencies }
  const overrides = { ...manifest.overrides }
  // Keep verified peer-only official modules explicit. Normal peer resolution also
  // retains non-DSH requirements (for example cordis-plugin-group) at their lock versions.
  for (const item of officialInputs.packages) {
    if (!/^@deepseek-ai\/dsh(?:-[a-z0-9-]+)?$/.test(item.name) || item.version !== official.version) throw new Error('CANDIDATE_OFFICIAL_INPUTS_MISMATCH')
    dependencies[item.name] = official.version
    overrides[item.name] = official.version
  }
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
  const semver = createRequire(npmCli)('semver')
  // Cordis plugins are runtime peers too. Pin the already installed, compatible
  // versions explicitly so adding archives cannot prune a boot requirement.
  for (const item of officialInputs.packages) {
    const owner = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'node_modules', item.name, 'package.json'), 'utf8'))
    for (const [name, range] of Object.entries(owner.peerDependencies ?? {})) {
      if (/^@deepseek-ai\/dsh(?:-[a-z0-9-]+)?$/.test(name)) continue
      const file = path.join(runtimeRoot, 'node_modules', name, 'package.json')
      if (!fs.existsSync(file)) {
        if (owner.peerDependenciesMeta?.[name]?.optional === true) continue
        throw new Error('CANDIDATE_REQUIRED_PEER_MISSING')
      }
      const version = JSON.parse(fs.readFileSync(file, 'utf8')).version
      if (!semver.satisfies(version, range)) throw new Error('CANDIDATE_REQUIRED_PEER_INCOMPATIBLE')
      dependencies[name] = version
      overrides[name] = version
    }
  }
  for (const item of inputs) {
    dependencies[item.name] = item.specifier
    // The directory picker is explicitly plugin-owned despite its official scoped name.
    // Other official runtime packages remain under the verified exact-version overrides.
    if (Object.hasOwn(overrides, item.name)) {
      if (item.name !== '@deepseek-ai/dsh-client-ui-directory-picker-browse') throw new Error('OFFICIAL_RUNTIME_REPLACEMENT_REFUSED')
      overrides[item.name] = item.specifier
    }
  }
  return { packagePath, manifest: { ...manifest, dependencies, overrides }, inputs, officialInputs: officialInputs.packages, runtimeVersion: official.version }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [runtimeRoot, stagingDir] = process.argv.slice(2)
  if (!runtimeRoot || !stagingDir) throw new Error('USAGE: install-candidate-packages.mjs <isolated-runtime> <verified-staging>')
  const prepared = candidatePackageInputs(runtimeRoot, stagingDir)
  fs.writeFileSync(prepared.packagePath, `${JSON.stringify(prepared.manifest, null, 2)}\n`)
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
  execFileSync(process.execPath, [npmCli, 'install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: runtimeRoot, stdio: 'inherit', windowsHide: true })
  for (const input of prepared.inputs) {
    const actual = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'node_modules', input.name, 'package.json'), 'utf8'))
    if (actual.version !== input.version) throw new Error('CANDIDATE_INSTALLED_VERSION_MISMATCH')
  }
  for (const input of prepared.officialInputs) {
    if (input.name === '@deepseek-ai/dsh-client-ui-directory-picker-browse') continue
    const actual = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'node_modules', input.name, 'package.json'), 'utf8'))
    if (actual.version !== prepared.runtimeVersion) throw new Error('CANDIDATE_INSTALLED_OFFICIAL_VERSION_MISMATCH')
  }
  fs.writeFileSync(path.join(runtimeRoot, 'plugin-install-inputs.json'), `${JSON.stringify({ status: 'installed-candidate-not-accepted', runtimeVersion: prepared.runtimeVersion, packages: prepared.inputs }, null, 2)}\n`)
  console.log(JSON.stringify({ status: 'installed-candidate-not-accepted', packageCount: prepared.inputs.length, runtimeVersion: prepared.runtimeVersion }))
}
