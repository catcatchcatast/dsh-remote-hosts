
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const read = file => readFile(new URL(file, root), 'utf8')

test('rc1 picker adapts the official workspace service and keeps Host choice inside the dialog', async () => {
  const index = await read('packages/ui-directory-picker-browse/src/client/index.ts')
  const flow = await read('packages/ui-directory-picker-browse/src/client/flow.ts')
  const picker = await read('packages/ui-directory-picker-browse/src/client/HostPicker.tsx')
  const patch = await read('packages/mobile-controller-compat-rc1/cordis.patch.yml')
  assert.match(index, /Context as ClientContext.*@deepseek-ai\/cordis/)
  assert.match(index, /export const inject = \['slots', 'uiWorkspace', 'locale'\]/)
  assert.match(index, /ctx\.uiWorkspace\.listDirectory/)
  assert.match(index, /ctx\.uiWorkspace\.createDirectory/)
  assert.match(flow, /DirectoryFlowOwnerProps/)
  assert.match(flow, /HostPicker/)
  assert.match(flow, /targetKey: selectedHost/)
  assert.doesNotMatch(flow, /key: selectedHost/)
  assert.match(picker, /getHosts/)
  assert.doesNotMatch(picker, /fetch\s*\(/)
  assert.match(picker, /setSelectedHost/)
  assert.doesNotMatch(picker, /Target Host|dsh-browser-host-selector/)
  assert.match(patch, /id: directory-picker[\s\S]*disabled: true/)
  assert.match(patch, /name: '@deepseek-ai\/dsh-host-directory-picker-browse'/)
  assert.match(patch, /name: '@deepseek-ai\/dsh-client-ui-directory-picker-browse'/)
})

test('new-folder creation remains within the picker flow rather than closing it', async () => {
  const source = await read('packages/ui-directory-picker-browse/src/client/DirectoryBrowser.tsx')
  assert.match(source, /return \(\s*\n\s*<>/)
  assert.match(source, /createDirectory\(targetPath, name\)[\s\S]*launchListing\(targetPath\)/)
  assert.match(source, /select\(\{ name, path: createdPath, hidden: false \}\)/)
  assert.doesNotMatch(source, /onClose\(\)\s*\/\/.*create|onClose\(\)\s*;\s*\/\/.*create/)
})

test('combined rc1 bundles register the shared directory components once', async () => {
  const patches = await Promise.all(['browser-host-hub-rc1', 'mobile-controller-compat-rc1'].map(name => read('packages/' + name + '/cordis.patch.yml')))
  const ids = patches.flatMap(patch => [...patch.matchAll(/^    - id: (.+)$/gm)].map(match => match[1].trim()))
  for (const id of ['directory-picker-browse', 'ui-directory-picker-browse', 'browser-host-hub-rc1', 'mobile-controller-compat-rc1']) {
    assert.equal(ids.filter(value => value === id).length, 1, id + ' must be registered once in the formal bundle set')
  }
})
