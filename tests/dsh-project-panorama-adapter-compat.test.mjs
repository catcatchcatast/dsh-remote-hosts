import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

import {
  PACKAGE_NAME,
  PACKAGE_VERSION,
  SOURCE_SHA256,
  applyPatch,
  patchAdapterSource,
  sha256,
} from '../compatibility-patches/dsh-project-panorama-adapter/apply.mjs'

const sourcePath = process.env.PANORAMA_ADAPTER_SOURCE
  ?? fileURLToPath(new URL('../compatibility-patches/dsh-project-panorama-adapter/fixtures/adapter-0.1.0.js', import.meta.url))

class FakeStream extends EventEmitter {
  constructor(onEnd = () => {}) {
    super()
    this.onEnd = onEnd
    this.writes = []
    this.destroyCalls = 0
  }

  end(value) {
    this.writes.push(value)
    this.onEnd()
  }

  destroy() {
    this.destroyCalls++
  }
}

class FakeChild extends EventEmitter {
  constructor(plan) {
    super()
    this.stdin = new FakeStream(() => plan.onEnd?.(this))
    this.stderr = new FakeStream()
    this.killCalls = 0
  }

  kill() {
    this.killCalls++
  }
}

class FakeContext {
  constructor() {
    this.listeners = new Map()
    this.warnings = []
    this.sessions = { list: () => [] }
  }

  on(name, listener) {
    const listeners = this.listeners.get(name) ?? []
    listeners.push(listener)
    this.listeners.set(name, listeners)
    return () => {
      const index = listeners.indexOf(listener)
      if (index >= 0) listeners.splice(index, 1)
    }
  }

  async emit(name, ...args) {
    return Promise.all((this.listeners.get(name) ?? []).map(listener => listener(...args)))
  }

  logger() {
    return { warn: message => this.warnings.push(String(message)) }
  }
}

async function loadPatchedAdapter(source, spawn) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-panorama-adapter-'))
  await writeFile(join(directory, 'package.json'), '{"type":"module"}\n')
  const moduleSource = patchAdapterSource(source)
    .replace("import { spawn } from 'node:child_process'", 'const { spawn } = globalThis.__panoramaTestRuntime')
  const modulePath = join(directory, 'index.js')
  await writeFile(modulePath, moduleSource)
  globalThis.__panoramaTestRuntime = { spawn }
  return import(`${pathToFileURL(modulePath).href}?test=${Date.now()}-${Math.random()}`)
}

function topLevelSession() {
  return { id: 'session-under-test', header: { cwd: 'D:/safe/project' }, events: [] }
}

async function emitTurn(context, session, turn, seq) {
  await context.emit('session/event', session, { type: 'turn/start', data: { turn }, seq })
  await context.emit('session/event', session, {
    type: 'turn/end',
    data: { turn },
    seq: seq + 1,
    body: { text: 'private turn body must stay out of warnings' },
  })
  await context.emit('session/flush', session)
}

test('patch is gated by the third-party adapter identity and allowlisted source hash', async () => {
  const source = await readFile(resolve(sourcePath), 'utf8')
  assert.equal(sha256(source), SOURCE_SHA256)
  const targetRoot = await mkdtemp(join(tmpdir(), 'dsh-panorama-target-'))
  await writeFile(join(targetRoot, 'package.json'), JSON.stringify({ name: PACKAGE_NAME, version: PACKAGE_VERSION, main: 'src/index.js' }))
  await writeFile(join(targetRoot, 'src-index-placeholder'), '')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(join(targetRoot, 'src'))
  await writeFile(join(targetRoot, 'src', 'index.js'), source)
  const applied = await applyPatch({ sourcePath, targetRoot })
  assert.equal(applied.sourceHash, SOURCE_SHA256)
  assert.notEqual(applied.patchedHash, SOURCE_SHA256)
  const patched = await readFile(join(targetRoot, 'src', 'index.js'), 'utf8')
  assert.match(patched, /child\.stdin\?\.on\?\.\('error'/)
  assert.match(patched, /child\.stderr\?\.on\?\.\('error'/)
  assert.match(patched, /child\.once\('close'/)

  await writeFile(join(targetRoot, 'package.json'), JSON.stringify({ name: 'wrong-package', version: PACKAGE_VERSION, main: 'src/index.js' }))
  await assert.rejects(applyPatch({ sourcePath, targetRoot }), /unexpected package identity/)
})

test('adapter contains pipe failures locally, settles each child once, and serial continues', async () => {
  const source = await readFile(resolve(sourcePath), 'utf8')
  const plans = [
    {
      name: 'normal',
      onEnd: child => queueMicrotask(() => { child.emit('exit', 0); child.emit('close', 0) }),
    },
    {
      name: 'pipe-errors',
      onEnd: child => queueMicrotask(() => {
        child.stderr.emit('error', Object.assign(new Error('stderr EOF'), { code: 'EPIPE' }))
        child.stderr.emit('error', Object.assign(new Error('late stderr EOF'), { code: 'EPIPE' }))
        child.stdin.emit('error', Object.assign(new Error('stdin EOF'), { code: 'EPIPE' }))
        child.stdin.emit('error', Object.assign(new Error('late stdin EOF'), { code: 'EPIPE' }))
        child.emit('error', Object.assign(new Error('child EOF'), { code: 'EPIPE' }))
        child.emit('error', Object.assign(new Error('late child EOF'), { code: 'EPIPE' }))
        child.emit('exit', 1)
        child.emit('close', 1)
      }),
    },
    {
      name: 'spawn-error',
      onEnd: child => queueMicrotask(() => {
        child.emit('error', Object.assign(new Error('spawn failed'), { code: 'ENOENT' }))
        child.emit('close', -1)
      }),
    },
    {
      name: 'stdin-error-without-child-exit',
      onEnd: child => queueMicrotask(() => {
        child.stdin.emit('error', Object.assign(new Error('stdin EOF without child exit'), { code: 'EPIPE' }))
      }),
    },
    {
      name: 'sync-spawn-error',
    },
    {
      name: 'exit-error',
      onEnd: child => queueMicrotask(() => { child.emit('exit', 1); child.emit('close', 1) }),
    },
    {
      name: 'normal-after-errors',
      onEnd: child => queueMicrotask(() => { child.emit('exit', 0); child.emit('close', 0) }),
    },
  ]
  const spawnCalls = []
  const spawned = []
  const spawn = (_executable, _args, _options) => {
    const plan = plans[spawnCalls.length]
    assert.ok(plan, 'unexpected extra child')
    spawnCalls.push(plan.name)
    if (plan.name === 'sync-spawn-error') throw Object.assign(new Error('sync spawn failed'), { code: 'EINVAL' })
    const child = new FakeChild(plan)
    spawned.push({ plan: plan.name, child })
    return child
  }
  const adapter = await loadPatchedAdapter(source, spawn)
  const context = new FakeContext()
  const dispose = adapter.createAdapter(context)
  const session = topLevelSession()
  const uncaught = []
  const unhandled = []
  const onUncaught = error => uncaught.push(error?.code ?? String(error))
  const onUnhandled = reason => unhandled.push(reason?.code ?? String(reason))
  process.on('uncaughtException', onUncaught)
  process.on('unhandledRejection', onUnhandled)
  try {
    await emitTurn(context, session, 'turn-1', 1)
    await emitTurn(context, session, 'turn-2', 3)
    await emitTurn(context, session, 'turn-3', 5)
    await emitTurn(context, session, 'turn-4', 7)
    await emitTurn(context, session, 'turn-5', 9)
    await emitTurn(context, session, 'turn-6', 11)
    await emitTurn(context, session, 'turn-7', 13)
    assert.deepEqual(spawnCalls, plans.map(item => item.name))
    assert.deepEqual(spawned.map(item => item.plan), plans.filter(item => item.name !== 'sync-spawn-error').map(item => item.name))
    assert.equal(spawned.every(item => item.child.stdin.writes.length === 1), true)
    assert.equal(spawned[0].child.killCalls, 0)
    assert.equal(spawned[0].child.stdin.destroyCalls, 0)
    assert.equal(spawned[0].child.stderr.destroyCalls, 0)
    assert.equal(spawned[1].child.killCalls, 1)
    assert.equal(spawned[1].child.stdin.destroyCalls, 1)
    assert.equal(spawned[1].child.stderr.destroyCalls, 1)
    assert.equal(spawned[2].child.killCalls, 1)
    assert.equal(spawned[3].child.killCalls, 1)
    assert.equal(spawned[4].child.killCalls, 0)
    assert.equal(spawned[5].child.killCalls, 0)
    assert.deepEqual(uncaught, [])
    assert.deepEqual(unhandled, [])
    assert.equal(context.warnings.some(message => message.includes('private turn body')), false)
    assert.equal(context.warnings.some(message => message.includes('stdin')), true)
    assert.equal(context.warnings.some(message => message.includes('stderr')), true)
    assert.equal(context.warnings.some(message => message.includes('spawn')), true)
    assert.equal(context.warnings.some(message => message.includes('exit-1')), true)
    assert.equal(context.warnings.filter(message => message.includes('stdin')).length, 1)
    assert.equal(context.warnings.filter(message => message.includes('stderr')).length, 1)
    assert.equal(context.warnings.filter(message => message.includes('exit-1')).length, 1)
  } finally {
    dispose()
    process.removeListener('uncaughtException', onUncaught)
    process.removeListener('unhandledRejection', onUnhandled)
    delete globalThis.__panoramaTestRuntime
  }
})
