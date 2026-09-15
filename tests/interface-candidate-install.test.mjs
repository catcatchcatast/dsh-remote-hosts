import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { candidatePackageInputs } from '../tools/install-candidate-packages.mjs'

test('candidate install rejects wrong runtime, tampered archive and replacement of official core', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-candidate-input-'))
  const runtime = path.join(root, 'runtime'), staging = path.join(root, 'staging')
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)) }
  try {
    const official = '@deepseek-ai/dsh'
    write(path.join(runtime, 'node_modules', official, 'package.json'), { version: '0.1.2-rc.1', peerDependencies: { '@deepseek-ai/cordis-plugin-group': '^1.0.2' } })
    write(path.join(runtime, 'node_modules/@deepseek-ai/dsh-session-persistence/package.json'), { version: '0.1.2-rc.1' })
    write(path.join(runtime, 'node_modules/@deepseek-ai/cordis-plugin-group/package.json'), { version: '1.0.2' })
    write(path.join(runtime, 'official-inputs.json'), { runtimeVersion: '0.1.2-rc.1', packages: [{ name: official, version: '0.1.2-rc.1' }, { name: '@deepseek-ai/dsh-session-persistence', version: '0.1.2-rc.1' }] })
    write(path.join(runtime, 'package.json'), { name: 'dsh-official-runtime-candidate', private: true, overrides: { [official]: '0.1.2-rc.1' } })
    fs.mkdirSync(staging, { recursive: true })
    const archive = path.join(staging, 'adapter.tgz')
    fs.writeFileSync(archive, 'synthetic archive bytes')
    const item = { name: 'dsh-test-adapter', version: '0.1.0', artifact: 'adapter.tgz', artifactSha256: createHash('sha256').update(fs.readFileSync(archive)).digest('hex') }
    const releasePath = path.join(staging, 'rc1-release-manifest.json')
    const release = { runtimeVersion: '0.1.2-rc.1', packageCount: 1, packages: [item] }
    write(releasePath, release)
    const prepared = candidatePackageInputs(runtime, staging)
    assert.match(prepared.manifest.dependencies[item.name], /^file:/)
    assert.equal(prepared.manifest.dependencies['@deepseek-ai/dsh-session-persistence'], '0.1.2-rc.1')
    assert.equal(prepared.manifest.dependencies['@deepseek-ai/cordis-plugin-group'], '1.0.2')
    write(releasePath, { ...release, runtimeVersion: '0.1.5-rc.2' })
    assert.throws(() => candidatePackageInputs(runtime, staging), /RELEASE_MISMATCH/)
    write(releasePath, { ...release, packages: [{ ...item, name: official }] })
    assert.throws(() => candidatePackageInputs(runtime, staging), /OFFICIAL_RUNTIME_REPLACEMENT_REFUSED/)
    write(releasePath, release)
    fs.appendFileSync(archive, 'tampered')
    assert.throws(() => candidatePackageInputs(runtime, staging), /HASH_MISMATCH/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
