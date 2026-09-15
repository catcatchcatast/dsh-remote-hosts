import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const registry = 'https://registry.npmjs.org'
const isOfficial = name => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')

/** Resolve only the official runtime closure; npm's lock fixes other dependencies. */
export async function officialClosure(version, roots, metadata) {
  if (!/^\d+\.\d+\.\d+(?:-[a-z]+\.\d+)?$/.test(version)) throw new Error('EXACT_RUNTIME_VERSION_REQUIRED')
  const pending = [...new Set(roots)]
  const manifests = new Map()
  while (pending.length) {
    const batch = pending.splice(0, 6).filter(name => !manifests.has(name))
    const results = await Promise.all(batch.map(name => metadata(name, version)))
    for (let i = 0; i < batch.length; i++) {
      const name = batch[i], manifest = results[i]
      if (!isOfficial(name) || manifest.name !== name || manifest.version !== version || !manifest.dist?.integrity?.startsWith('sha512-')) {
        throw new Error(`UNVERIFIED_OFFICIAL_PACKAGE_${name}`)
      }
      manifests.set(name, manifest)
      const deps = { ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies }
      for (const dependency of Object.keys(deps)) {
        if (isOfficial(dependency) && !manifests.has(dependency) && !pending.includes(dependency) && !batch.includes(dependency)) pending.push(dependency)
      }
    }
  }
  return [...manifests.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export async function prepareOfficialRuntime({ version, directory, roots = ['@deepseek-ai/dsh'], metadata }) {
  const target = path.resolve(directory)
  await fs.mkdir(target, { recursive: true })
  if ((await fs.readdir(target)).length) throw new Error('CANDIDATE_DIRECTORY_NOT_EMPTY')
  const entries = await officialClosure(version, roots, metadata ?? (async (name, selectedVersion) => {
    const response = await fetch(`${registry}/${encodeURIComponent(name)}/${selectedVersion}`, { signal: AbortSignal.timeout(20000) })
    if (!response.ok) throw new Error(`OFFICIAL_METADATA_HTTP_${response.status}_${name}`)
    return response.json()
  }))
  const overrides = Object.fromEntries(entries.map(entry => [entry.name, version]))
  const manifest = {
    name: 'dsh-official-runtime-candidate', private: true, type: 'module',
    dependencies: Object.fromEntries(roots.map(name => [name, version])), overrides,
  }
  const provenance = {
    runtimeVersion: version, status: 'candidate-inputs', registry,
    packages: entries.map(({ name, version, dist }) => ({ name, version, integrity: dist.integrity, tarball: dist.tarball })),
  }
  await fs.writeFile(path.join(target, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await fs.writeFile(path.join(target, 'official-inputs.json'), `${JSON.stringify(provenance, null, 2)}\n`)
  return { runtimeVersion: version, packageCount: entries.length, directory: target }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [version, directory] = process.argv.slice(2)
  if (!version || !directory) throw new Error('USAGE: prepare-official-runtime.mjs <exact-version> <empty-candidate-directory>')
  console.log(JSON.stringify(await prepareOfficialRuntime({ version, directory })))
}
