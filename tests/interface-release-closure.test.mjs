import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { releasePackageDirectories } from '../tools/release-profile.mjs'

test('release follows transitive workspace runtime dependencies and excludes unrelated legacy packages', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-release-closure-'))
  try {
    for (const [directory, name, dependencies] of [
      ['entry', 'dsh-entry', { 'dsh-middle': 'workspace:*' }],
      ['middle', 'dsh-middle', { 'dsh-boundary': 'workspace:*' }],
      ['boundary', 'dsh-boundary', { 'dsh-entry': 'workspace:*' }],
      ['legacy', 'dsh-legacy', { 'dsh-obsolete': 'link:../../dsh-core' }],
    ]) {
      fs.mkdirSync(path.join(root, 'packages', directory), { recursive: true })
      fs.writeFileSync(path.join(root, 'packages', directory, 'package.json'), JSON.stringify({ name, dependencies }))
    }
    assert.deepEqual(releasePackageDirectories(root, { packageRoots: ['entry'] }), ['boundary', 'middle', 'entry'])
    assert.throws(() => releasePackageDirectories(root, { packageRoots: ['legacy'] }), /UNRESOLVED_RELEASE_DEPENDENCY/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
