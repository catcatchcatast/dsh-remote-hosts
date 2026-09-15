import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

export const workspaceRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
export const releaseProfile = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'release-profile.json'), 'utf8'))

/** Include transitive plugin dependencies, never legacy packages by directory glob. */
export function releasePackageDirectories(root = workspaceRoot, profile = releaseProfile) {
  const packages = new Map()
  for (const directory of fs.readdirSync(path.join(root, 'packages'), { withFileTypes: true })) {
    if (!directory.isDirectory() || directory.isSymbolicLink()) continue
    const file = path.join(root, 'packages', directory.name, 'package.json')
    if (fs.existsSync(file)) {
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
      packages.set(manifest.name, { directory: directory.name, manifest })
    }
  }
  const result = [], seen = new Set()
  const visit = directory => {
    if (seen.has(directory)) return
    const item = [...packages.values()].find(item => item.directory === directory)
    if (!item) throw new Error(`RELEASE_PACKAGE_MISSING_${directory}`)
    seen.add(directory)
    for (const [name, version] of Object.entries({ ...item.manifest.dependencies, ...item.manifest.optionalDependencies })) {
      const dependency = packages.get(name)
      if (dependency && (version.startsWith('workspace:') || name.startsWith('dsh-'))) visit(dependency.directory)
      else if (/^(?:workspace:|link:|file:)/.test(version)) throw new Error(`UNRESOLVED_RELEASE_DEPENDENCY_${name}`)
    }
    result.push(directory)
  }
  for (const directory of profile.packageRoots) visit(directory)
  return result
}

export function releaseTestFiles(root = workspaceRoot, profile = releaseProfile) {
  const patterns = profile.testPatterns.map(pattern => new RegExp(`^${pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`))
  return fs.readdirSync(path.join(root, 'tests')).filter(file => patterns.some(pattern => pattern.test(file))).sort().map(file => path.join('tests', file))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2]
  if (command === 'build') {
    for (const directory of releasePackageDirectories()) {
      const cwd = path.join(workspaceRoot, 'packages', directory)
      const manifest = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'))
      if (!manifest.scripts?.build) continue
      // Only package-defined builds run; npm executes on the explicit package cwd.
      const npmCli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
      const result = spawnSync(process.execPath, [npmCli, 'run', 'build'], { cwd, stdio: 'inherit', windowsHide: true })
      if (result.error) throw result.error
      if (result.status !== 0) process.exit(result.status ?? 1)
    }
  } else if (command === 'test') {
    const result = spawnSync(process.execPath, ['--test', ...releaseTestFiles()], { cwd: workspaceRoot, stdio: 'inherit', windowsHide: true })
    if (result.error) throw result.error
    process.exit(result.status ?? 1)
  } else throw new Error('USAGE: release-profile.mjs build|test')
}
