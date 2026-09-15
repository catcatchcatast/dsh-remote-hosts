import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { RULES, scanInterfaceBoundary } from '../tools/check-interface-boundary.mjs'

function fixtureRoot(source, { includeOwner = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-interface-boundary-'))
  fs.mkdirSync(path.join(root, 'packages', 'fixture', 'src'), { recursive: true })
  fs.writeFileSync(path.join(root, 'packages', 'fixture', 'package.json'), JSON.stringify({ name: 'dsh-fixture', files: ['src'] }))
  fs.writeFileSync(path.join(root, 'packages', 'fixture', 'src', 'index.js'), source)
  if (includeOwner) {
    fs.mkdirSync(path.join(root, 'packages', 'runtime-interface', 'src'), { recursive: true })
    fs.writeFileSync(path.join(root, 'packages', 'runtime-interface', 'package.json'), JSON.stringify({ name: 'dsh-runtime-interface', files: ['src'] }))
    fs.writeFileSync(path.join(root, 'packages', 'runtime-interface', 'src', 'index.js'), `export const inject = ['sessionController']; export function apply(ctx) { return ctx.sessionController }`)
  }
  return root
}

function profile(includeOwner = true) {
  return { profile: 'fixture', packageRoots: includeOwner ? ['runtime-interface', 'fixture'] : ['fixture'] }
}

function cleanup(root) { fs.rmSync(root, { recursive: true, force: true }) }

test('AST boundary scan reports direct context, raw/history fields and legacy chunk rows while ignoring comments', () => {
  const root = fixtureRoot(`
    // ctx.sessionController carrier.raw sourceEventSeqs chunkrow/comment-only
    export function run(ctx, surfaceOp, carrier, raw) {
      const controller = ctx.sessionController
      const rawCall = carrier.raw
      const source = raw.sourceEventSeqs
      const start = surfaceOp.start
      const end = surfaceOp.end
      const row = 'chunkrow/text-chunks'
      return { controller, rawCall, source, start, end, row }
    }
  `)
  try {
    const report = scanInterfaceBoundary({ root, profile: profile(), exceptionsPath: path.join(root, 'missing-exceptions.json') })
    assert.equal(report.passed, false)
    assert.ok(report.unsuppressed.some(item => item.ruleId === RULES.contextServiceAccess && item.expression === 'ctx.sessionController'))
    assert.ok(report.unsuppressed.some(item => item.ruleId === RULES.carrierRaw && item.expression === 'carrier.raw'))
    assert.ok(report.unsuppressed.some(item => item.ruleId === RULES.legacySourceEventSeqs && item.expression === 'raw.sourceEventSeqs'))
    assert.ok(report.unsuppressed.some(item => item.ruleId === RULES.legacyChunkrow && item.expression === "'chunkrow/text-chunks'"))
    assert.equal(report.unsuppressed.filter(item => item.ruleId === RULES.legacySurfaceOpRange).length, 2)
    assert.equal(report.unsuppressed.filter(item => item.expression.includes('comment-only')).length, 0)
  } finally { cleanup(root) }
})

test('inject entries and private require/imports are checked, while the interface owner may bind official services', () => {
  const root = fixtureRoot(`
    import session from '@deepseek-ai/dsh-api-session-controller'
    const connection = require('@deepseek-ai/dsh-client-connection')
    export const inject = ['connection', 'sessionController']
    export { session, connection }
  `)
  try {
    const report = scanInterfaceBoundary({ root, profile: profile(), exceptionsPath: path.join(root, 'none.json') })
    assert.equal(report.unsuppressed.filter(item => item.package === 'fixture').length, 4)
    assert.equal(report.violations.filter(item => item.package === 'runtime-interface').length, 0)
    assert.ok(report.unsuppressed.every(item => [RULES.injectOfficialService, RULES.privateRuntimeImport].includes(item.ruleId)))
  } finally { cleanup(root) }
})

test('ordinary start/end properties are not mistaken for surfaceOp range fields', () => {
  const root = fixtureRoot(`
    export function read(value) {
      return [value.start, value.end, value.surfaceOp?.op]
    }
  `)
  try {
    const report = scanInterfaceBoundary({ root, profile: profile(), exceptionsPath: path.join(root, 'none.json') })
    assert.equal(report.passed, true)
    assert.equal(report.violations.length, 0)
  } finally { cleanup(root) }
})

test('an exact expression exception suppresses only its matching AST expression', () => {
  const root = fixtureRoot('export function read(carrier) { return carrier.raw }')
  const exceptionsPath = path.join(root, 'docs', 'interface-exceptions.json')
  fs.mkdirSync(path.dirname(exceptionsPath), { recursive: true })
  try {
    const first = scanInterfaceBoundary({ root, profile: profile(), exceptionsPath })
    const violation = first.violations.find(item => item.ruleId === RULES.carrierRaw)
    fs.writeFileSync(exceptionsPath, JSON.stringify({ version: 1, exceptions: [{ file: violation.file, ruleId: violation.ruleId, expressionHash: violation.expressionHash }] }))
    const second = scanInterfaceBoundary({ root, profile: profile(), exceptionsPath })
    assert.equal(second.passed, true)
    assert.equal(second.summary.suppressed, 1)
    assert.equal(second.exceptions.applied.length, 1)
  } finally { cleanup(root) }
})

test('stale and duplicate exceptions fail closed after an expression changes', () => {
  const root = fixtureRoot('export function read(carrier) { return carrier.raw }')
  const sourcePath = path.join(root, 'packages', 'fixture', 'src', 'index.js')
  const exceptionsPath = path.join(root, 'docs', 'interface-exceptions.json')
  fs.mkdirSync(path.dirname(exceptionsPath), { recursive: true })
  try {
    const first = scanInterfaceBoundary({ root, profile: profile(), exceptionsPath })
    const violation = first.violations.find(item => item.ruleId === RULES.carrierRaw)
    const exception = { file: violation.file, ruleId: violation.ruleId, expressionHash: violation.expressionHash }
    fs.writeFileSync(exceptionsPath, JSON.stringify({ version: 1, exceptions: [exception, exception] }))
    const duplicate = scanInterfaceBoundary({ root, profile: profile(), exceptionsPath })
    assert.equal(duplicate.passed, false)
    assert.ok(duplicate.exceptions.errors.some(item => item.code === 'DUPLICATE_EXCEPTION'))
    fs.writeFileSync(exceptionsPath, JSON.stringify({ version: 1, exceptions: [exception] }))
    fs.writeFileSync(sourcePath, 'export function read(value) { return value.raw }')
    const stale = scanInterfaceBoundary({ root, profile: profile(), exceptionsPath })
    assert.equal(stale.passed, false)
    assert.ok(stale.exceptions.stale.some(item => item.code === 'STALE_EXCEPTION'))
  } finally { cleanup(root) }
})

test('mobile migration packages cannot be made green with exceptions', () => {
  const root = fixtureRoot('export const inject = [\'sessionController\']')
  const from = path.join(root, 'packages', 'fixture')
  const target = path.join(root, 'packages', 'mobile-controller-compat-rc1')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.renameSync(from, target)
  const exceptionsPath = path.join(root, 'docs', 'interface-exceptions.json')
  fs.mkdirSync(path.dirname(exceptionsPath), { recursive: true })
  fs.writeFileSync(exceptionsPath, JSON.stringify({ version: 1, exceptions: [{ file: 'packages/mobile-controller-compat-rc1/src/index.js', ruleId: RULES.injectOfficialService, expressionHash: '0'.repeat(64) }] }))
  try {
    const report = scanInterfaceBoundary({ root, profile: { profile: 'fixture', packageRoots: ['mobile-controller-compat-rc1'] }, exceptionsPath })
    assert.equal(report.passed, false)
    assert.ok(report.exceptions.errors.some(item => item.code === 'MIGRATION_EXCEPTION_FORBIDDEN'))
  } finally { cleanup(root) }
})
