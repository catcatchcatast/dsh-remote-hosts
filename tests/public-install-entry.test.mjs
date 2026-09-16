import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const packageRoot = path.join(root, 'packages/public-install-rc2')
const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
const patch = fs.readFileSync(path.join(packageRoot, 'cordis.patch.yml'), 'utf8')
const profilePatch = fs.readFileSync(path.join(packageRoot, 'profile.patch.example.yml'), 'utf8')
test('public entry embeds its complete project-owned runtime closure', () => {
  assert.equal(manifest.name, 'dsh-remote-hosts')
  assert.equal(manifest.version, '0.1.5-rc.2')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh'], '0.1.5-rc.2')
  assert.equal(Object.keys(manifest.dependencies).length, 12)
  assert.equal(Object.keys(manifest.exports).length, 12)
  assert.deepEqual([...manifest.bundledDependencies].sort(), Object.keys(manifest.dependencies).sort())
  for (const [name, specifier] of Object.entries(manifest.dependencies)) assert.equal(specifier, 'workspace:*', name)
  assert.ok(manifest.files.includes('profile.patch.example.yml'))
  for (const [specifier, bridge] of Object.entries(manifest.exports)) {
    assert.ok(specifier.startsWith('./'), specifier)
    assert.match(bridge, /^\.\/bridges\/[a-z-]+\.mjs$/)
    const source = fs.readFileSync(path.join(packageRoot, bridge), 'utf8')
    assert.match(source, /^export \* from '[^']+'\r?\n/)
  }
})

test('public entry composes each activated plugin once for rc2', () => {
  const ids = [
    'runtime-interface',
    'mobile-bootstrap-rc1',
    'mobile-interactions-compat-rc1',
    'directory-picker-browse',
    'ui-directory-picker-browse',
    'mobile-controller-compat-rc1',
    'mobile-session-sync-rc1',
    'mobile-stream-compat-rc1',
    'rc1-host-carriers',
    'browser-host-hub-rc1',
    'remote-hosts-settings-rc1',
    'subscriptions-compat-rc1',
    'model-menu-filter',
  ]
  for (const id of ids) assert.equal(patch.match(new RegExp('id: ' + id + '\\b', 'g'))?.length, 1, id)
  assert.match(patch, /upstreamVersion: '0\.1\.5-rc\.2'/)
  assert.match(profilePatch, /datasetId: replace-with-a-stable-host-history-id/)
  assert.match(profilePatch, /sequenceFormatGeneration: 3/)
  assert.match(profilePatch, /generation: 1/)
  for (const specifier of Object.keys(manifest.exports)) {
    assert.equal(patch.match(new RegExp("name: dsh-remote-hosts/" + specifier.slice(2) + "\\b", 'g'))?.length, 1, specifier)
  }
})

// 变更追溯：CHG-20260916-145608-public-install-entry-aeb49531；记录：.codex/doc/change-history/CHG-20260916-145608-public-install-entry-aeb49531.md
