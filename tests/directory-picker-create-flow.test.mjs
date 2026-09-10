
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const sourceUrl = new URL(
  '../packages/ui-directory-picker-browse/src/client/DirectoryBrowser.tsx',
  import.meta.url,
)

test('new-folder overlay is independent from the New Project picker', async () => {
  const source = await readFile(sourceUrl, 'utf8')
  const renderStart = source.search(/  return \(\r?\n    <>/)
  assert.notEqual(renderStart, -1, 'DirectoryBrowser should render sibling overlays in a Fragment')

  const pickerOpen = source.indexOf('<Modal', renderStart)
  const pickerClose = source.indexOf('</Modal>', pickerOpen)
  const createOpen = source.indexOf('<Modal', pickerClose)
  assert.ok(pickerOpen < pickerClose, 'the New Project picker should close before the create overlay opens')
  assert.ok(pickerClose < createOpen, 'the create overlay must not be nested inside the picker Modal')

  const successStart = source.indexOf('createDirectory(targetPath, name).then((createdPath) => {')
  const successEnd = source.indexOf('}, (reason: unknown) => {', successStart)
  const successBranch = source.slice(successStart, successEnd)
  assert.match(successBranch, /setFolderDraft\(null\)/, 'success should dismiss only the create overlay')
  assert.match(successBranch, /launchListing\(targetPath\)/, 'success should refresh the previous directory')
  assert.match(successBranch, /select\(\{ name, path: createdPath, hidden: false \}\)/, 'success should select the new folder')
  assert.doesNotMatch(successBranch, /onClose\(/, 'success must not cancel the New Project flow')
})
