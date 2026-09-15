import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  LEGACY_SOURCE_SHA256,
  MIGRATED_SOURCE_SHA256,
  SUPPORTED_RUNTIME_VERSION,
  applyPatch,
  migratePersonaConfig,
  sha256,
} from '../compatibility-patches/preset-persona-config/apply.mjs'

const fixture = new URL('../compatibility-patches/preset-persona-config/fixtures/standard-depth-1.agent.cordis.yml', import.meta.url)
const oldSample = `- id: persona\n  name: '@deepseek-ai/dsh-persona'\n  config:\n    text: >-\n      You are a coding agent powered by the {{model}} model.\n\n- id: keep\n  name: keep\n  config:\n    value: unchanged\n`
const newSample = oldSample.replace('    text:', '    prefix:')

test('legacy text maps to prefix while every other preset line stays byte-identical', () => {
  const migrated = migratePersonaConfig(oldSample, { runtimeVersion: SUPPORTED_RUNTIME_VERSION })
  assert.equal(migrated, oldSample.replace('    text:', '    prefix:'))
  assert.equal(migrated.replace('    prefix:', '    text:'), oldSample)
})

test('rc2 prefix shape is accepted idempotently and unsupported versions are rejected', () => {
  assert.equal(migratePersonaConfig(newSample, { runtimeVersion: SUPPORTED_RUNTIME_VERSION }), newSample)
  assert.throws(() => migratePersonaConfig(oldSample, { runtimeVersion: '0.1.2-rc.1' }), /unsupported/)
})

test('conflicting, missing, and non-scalar persona shapes are rejected', () => {
  assert.throws(() => migratePersonaConfig(newSample.replace('    prefix:', '    text:\n    prefix:'), { runtimeVersion: SUPPORTED_RUNTIME_VERSION }), /both text and prefix|duplicate/)
  assert.throws(() => migratePersonaConfig(oldSample.replace(/    text: >-[\s\S]*?\n      You[^\n]*\n\n/u, '    other: value\n'), { runtimeVersion: SUPPORTED_RUNTIME_VERSION }), /requires prefix or legacy text/)
  assert.throws(() => migratePersonaConfig(oldSample.replace('    text: >-', '    text: [bad]'), { runtimeVersion: SUPPORTED_RUNTIME_VERSION }), /non-null scalar/)
  assert.throws(() => migratePersonaConfig(oldSample.replace('    text: >-', '    text: true'), { runtimeVersion: SUPPORTED_RUNTIME_VERSION }), /YAML string scalar/)
})

test('allowlisted full legacy preset applies once with an immutable backup and is idempotent', async () => {
  const source = await readFile(fixture, 'utf8')
  assert.equal(sha256(source), LEGACY_SOURCE_SHA256)
  const root = await mkdtemp(join(tmpdir(), 'dsh-preset-persona-'))
  const sourcePath = join(root, 'legacy.yml')
  const targetPath = join(root, 'candidate.yml')
  const backupPath = join(root, 'candidate.legacy.yml')
  await writeFile(sourcePath, source)
  await writeFile(targetPath, source)
  const applied = await applyPatch({ sourcePath, targetPath, backupPath, runtimeVersion: SUPPORTED_RUNTIME_VERSION })
  assert.equal(applied.status, 'migrated')
  assert.equal(applied.sourceHash, LEGACY_SOURCE_SHA256)
  assert.equal(applied.migratedHash, MIGRATED_SOURCE_SHA256)
  assert.equal(await readFile(backupPath, 'utf8'), source)
  assert.equal(sha256(await readFile(targetPath, 'utf8')), MIGRATED_SOURCE_SHA256)

  const again = await applyPatch({ sourcePath: targetPath, targetPath, backupPath: join(root, 'unused-backup.yml'), runtimeVersion: SUPPORTED_RUNTIME_VERSION })
  assert.equal(again.status, 'already-migrated')
  assert.equal(await readFile(targetPath, 'utf8'), await readFile(fixture, 'utf8').then(value => migratePersonaConfig(value, { runtimeVersion: SUPPORTED_RUNTIME_VERSION })))
})
