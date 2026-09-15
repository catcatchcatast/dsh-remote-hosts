import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildRelease, RC1_PACKAGE_DIRS } from '../tools/rc1-package-release.mjs'

const worktree = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

test('release includes the directory picker used by the browser bundle', () => {
  assert.ok(RC1_PACKAGE_DIRS.includes('ui-directory-picker-browse'))
})

test('packs every rc1 adapter and browser picker offline with candidate source hashes', () => {
  const staging = mkdtempSync(path.join(tmpdir(), 'dsh-rc1-package-release-'))
  try {
    const result = buildRelease({ sourceRoot: worktree, stagingDir: staging, runtimeVersion: '0.1.2-rc.1' })
    assert.equal(result.runtimeVersion, '0.1.2-rc.1')
    assert.equal(result.releaseStatus, 'candidate')
    assert.equal(result.sourceCommitFrozen, false)
    assert.match(result.sourceTreeHash, /^[a-f0-9]{64}$/)
    assert.deepEqual(result.packages.map(item => item.directory), RC1_PACKAGE_DIRS)
    assert.equal(result.packageCount, RC1_PACKAGE_DIRS.length)
    const picker = result.packages.find(item => item.directory === 'ui-directory-picker-browse')
    assert.ok(picker.sourceFiles.some(file => file.path.endsWith('/src/client/HostPicker.tsx')))
    assert.ok(picker.sourceFiles.some(file => file.path.endsWith('/lib/client.js')))
    assert.ok(result.packages.some(item => item.workspaceDependencyRewrites.some(rewrite => rewrite.from === 'workspace:*' && rewrite.to === '0.1.0-rc.1')))
    for (const item of result.packages) {
      const artifact = path.join(staging, item.artifact)
      assert.equal(statSync(artifact).isFile(), true)
      assert.equal(readFileSync(`${artifact}.sha256`, 'utf8'), `${item.artifactSha256}  ${item.artifact}\n`)
      const packedManifest = JSON.parse(execFileSync('tar', ['-xOf', artifact, 'package/package.json'], { encoding: 'utf8', windowsHide: true }))
      for (const field of ['dependencies', 'optionalDependencies', 'devDependencies', 'peerDependencies']) {
        for (const value of Object.values(packedManifest[field] ?? {})) assert.equal(String(value).startsWith('workspace:'), false)
      }
    }
    assert.equal(JSON.parse(readFileSync(path.join(staging, 'rc1-release-manifest.json'), 'utf8')).sourceCommitFrozen, false)
    assert.equal(JSON.parse(readFileSync(path.join(staging, 'source-content-hashes.json'), 'utf8')).sourceTreeHash, result.sourceTreeHash)
    const inputs = JSON.parse(readFileSync(path.join(staging, 'source-content-hashes.json'), 'utf8')).files
    for (const name of ['release-profile.json', 'pnpm-lock.yaml', 'tools/release-profile.mjs']) assert.ok(inputs.some(file => file.path === name && /^[a-f0-9]{64}$/.test(file.sha256)))
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
})

test('does not modify source manifests and rejects lab-targets staging', () => {
  const sourceManifest = path.join(worktree, 'packages', 'rc1-host-carriers', 'package.json')
  const before = readFileSync(sourceManifest, 'utf8')
  const staging = mkdtempSync(path.join(tmpdir(), 'dsh-rc1-package-release-boundary-'))
  try {
    assert.throws(() => buildRelease({ sourceRoot: worktree, stagingDir: path.join(staging, 'lab-targets') }), /STAGING_LAB_TARGETS_FORBIDDEN/)
    assert.equal(readFileSync(sourceManifest, 'utf8'), before)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
})
