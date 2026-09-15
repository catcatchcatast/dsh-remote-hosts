import { test } from 'node:test'
import assert from 'node:assert/strict'
import { officialClosure } from '../tools/prepare-official-runtime.mjs'

test('official dependency and peer closure is pinned to one verified version', async () => {
  const calls = []
  const packages = {
    '@deepseek-ai/dsh': { dependencies: { '@deepseek-ai/dsh-a': '^0.1.5-rc.2', react: '^18' } },
    '@deepseek-ai/dsh-a': { peerDependencies: { '@deepseek-ai/dsh-b': '*' } },
    '@deepseek-ai/dsh-b': { dependencies: { '@deepseek-ai/dsh-a': '*' } },
  }
  const result = await officialClosure('0.1.5-rc.2', ['@deepseek-ai/dsh'], async (name, version) => {
    calls.push(name)
    return { name, version, ...packages[name], dist: { integrity: 'sha512-test' } }
  })
  assert.equal(result.length, 3)
  assert.equal(new Set(calls).size, calls.length)
  assert.ok(result.every(entry => entry.version === '0.1.5-rc.2'))
  assert.ok(!calls.includes('react'))
})

test('a registry response for a different runtime fails closed', async () => {
  await assert.rejects(officialClosure('0.1.5-rc.2', ['@deepseek-ai/dsh'], async name => ({ name, version: '0.1.2-rc.1', dist: { integrity: 'sha512-test' } })), /UNVERIFIED_OFFICIAL_PACKAGE/)
  await assert.rejects(officialClosure('latest', [], async () => ({})), /EXACT_RUNTIME_VERSION_REQUIRED/)
})
