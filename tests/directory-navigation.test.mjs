import assert from 'node:assert/strict'
import test from 'node:test'
import { directoryParentPath, displayCrumbs } from '../packages/ui-directory-picker-browse/src/client/directory-path.ts'

function entry(name, path) {
  return { name, path, hidden: false }
}

test('up leaves a POSIX home even when the displayed breadcrumb collapses to Home', () => {
  const listing = {
    path: '/home/example-user',
    home: '/home/example-user',
    roots: [entry('/', '/')],
    crumbs: [entry('/', '/'), entry('home', '/home'), entry('example-user', '/home/example-user')],
    entries: [],
  }

  assert.deepEqual(displayCrumbs(listing, 'Home').map(item => item.path), ['/home/example-user'])
  assert.equal(directoryParentPath(listing), '/home')
})

test('up leaves a Windows home and stops only at the drive root', () => {
  const home = {
    path: 'C:\\Users\\example',
    home: 'C:\\Users\\example',
    roots: [entry('C:', 'C:\\')],
    crumbs: [entry('C:', 'C:\\'), entry('Users', 'C:\\Users'), entry('example', 'C:\\Users\\example')],
    entries: [],
  }
  const root = { ...home, path: 'C:\\', crumbs: [entry('C:', 'C:\\')] }

  assert.equal(directoryParentPath(home), 'C:\\Users')
  assert.equal(directoryParentPath(root), undefined)
})
