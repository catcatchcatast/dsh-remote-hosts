
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  createLocalRuntimeRestart,
  descriptorFingerprint,
  forkManagedRuntimeBroker,
  launchManagedRuntime,
  ManagedRuntimeError,
  normalizeManagedRuntimeDescriptor,
  normalizeRuntimeInterfaceConfig,
  parsePortOwnerPid,
  waitForProcessExit,
  runManagedRuntimeBroker,
} from '../packages/runtime-interface/src/index.js'

function identityFor(root, overrides = {}) {
  const nodePath = process.execPath
  const cwd = root
  const dshHome = join(root, 'dsh-home')
  return {
    execPath: nodePath,
    argv: [nodePath, 'dsh-web.js'],
    cwd: () => cwd,
    env: { DSH_HOME: dshHome },
    pid: 41123,
    ...overrides,
  }
}

function descriptorFor(root, overrides = {}) {
  const processLike = identityFor(root)
  return {
    formatVersion: 1,
    profileId: 'test-3182',
    hostId: 'local',
    nodePath: processLike.execPath,
    argv: [...processLike.argv],
    cwd: processLike.cwd(),
    dshHome: processLike.env.DSH_HOME,
    port: 3182,
    launcherId: 'managed-runtime/test-3182',
    mutexPath: join(root, 'managed-runtime.lock'),
    instancePath: join(root, 'managed-runtime.instance.json'),
    readyTimeoutMs: 1000,
    exitWaitMs: 1000,
    ...overrides,
  }
}

async function unusedPort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

async function waitForPidExit(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (error?.code === 'ESRCH') return
      throw error
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`child process ${pid} did not exit before cleanup`)
}

async function removeTemp(root) {
  let lastError
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true })
      return
    } catch (error) {
      lastError = error
      if (error?.code !== 'EBUSY') throw error
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  throw lastError
}

async function waitForFile(path, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { return await readFile(path, 'utf8') } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`file ${path} did not appear before cleanup`)
}

test('missing appExit leaves the old runtime restart capability unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-restart-'))
  try {
    const processLike = identityFor(root)
    const runtime = createLocalRuntimeRestart({ descriptor: descriptorFor(root), processLike, webServer: { port: 3182 } })
    assert.deepEqual(runtime.status(), { available: false, busy: false, state: 'unavailable' })
    await assert.rejects(runtime.restart(), error => error.code === 'LOCAL_RESTART_UNAVAILABLE')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('wrong process identity is rejected before broker spawn or appExit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-restart-'))
  try {
    const descriptor = descriptorFor(root)
    const processLike = identityFor(root, { argv: [process.execPath, 'wrong-profile.js'] })
    let forks = 0
    let exits = 0
    const runtime = createLocalRuntimeRestart({
      descriptor,
      processLike,
      webServer: { port: 3182 },
      appExit: () => { exits += 1 },
      forkBroker: () => { forks += 1; return { ready: Promise.resolve({ type: 'ready', fingerprint: descriptorFingerprint(descriptor) }) } },
    })
    await assert.rejects(runtime.restart(), error => error.code === 'LOCAL_RESTART_IDENTITY')
    assert.equal(forks, 0)
    assert.equal(exits, 0)
    assert.equal(runtime.status().state, 'failed')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('broker spawn failure never calls appExit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-restart-'))
  try {
    let exits = 0
    const runtime = createLocalRuntimeRestart({
      descriptor: descriptorFor(root),
      processLike: identityFor(root),
      webServer: { port: 3182 },
      appExit: () => { exits += 1 },
      forkBroker: () => { throw new ManagedRuntimeError('LOCAL_RESTART_BROKER_FAILED', 'spawn failed') },
    })
    await assert.rejects(runtime.restart(), error => error.code === 'LOCAL_RESTART_BROKER_FAILED')
    assert.equal(exits, 0)
    assert.equal(runtime.status().lastError, 'LOCAL_RESTART_BROKER_FAILED')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('concurrent restart requests share one broker and one appExit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-restart-'))
  try {
    let forks = 0
    let exits = 0
    let resolveReady
    const ready = new Promise(resolve => { resolveReady = resolve })
    const descriptor = descriptorFor(root)
    const runtime = createLocalRuntimeRestart({
      descriptor,
      processLike: identityFor(root),
      webServer: { port: 3182 },
      appExit: () => { exits += 1 },
      forkBroker: () => { forks += 1; return { ready } },
    })
    const first = runtime.restart()
    const second = runtime.restart()
    assert.strictEqual(first, second)
    assert.equal(runtime.status().busy, true)
    resolveReady({ type: 'ready', fingerprint: descriptorFingerprint(descriptor) })
    assert.deepEqual(await first, { accepted: true, state: 'requested' })
    assert.deepEqual(await second, { accepted: true, state: 'requested' })
    assert.equal(forks, 1)
    assert.equal(exits, 0)
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(exits, 1)
    assert.equal(runtime.status().busy, true)
    assert.strictEqual(runtime.restart(), first)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('management restart waits for the HTTP response finish before appExit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-restart-'))
  try {
    const server = new EventEmitter()
    const response = new EventEmitter()
    let exits = 0
    let closes = 0
    const descriptor = descriptorFor(root)
    const runtime = createLocalRuntimeRestart({
      descriptor,
      processLike: identityFor(root),
      webServer: { port: descriptor.port, server },
      appExit: () => { exits += 1 },
      forkBroker: () => ({
        ready: Promise.resolve({ type: 'ready', fingerprint: descriptorFingerprint(descriptor) }),
        close: () => { closes += 1 },
      }),
    })

    // This is the same request/response lifecycle the official node:http
    // bridge exposes; the response is deliberately held after the handler
    // has accepted the restart.
    server.emit('request', { method: 'POST', url: '/remote-hosts/restart' }, response)
    assert.deepEqual(await runtime.restart(), { accepted: true, state: 'requested' })
    assert.equal(exits, 0)
    assert.equal(closes, 0)
    response.emit('finish')
    assert.equal(exits, 1)
    assert.equal(closes, 1)
    response.emit('close')
    assert.equal(exits, 1)
    assert.equal(closes, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('management restart keeps a real HTTP response readable before appExit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-restart-'))
  const server = createHttpServer()
  let runtime
  let exits = 0
  try {
    server.on('request', async (request, response) => {
      try {
        const accepted = await runtime.restart()
        await new Promise(resolve => setTimeout(resolve, 25))
        assert.equal(exits, 0)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(accepted))
      } catch (error) {
        response.writeHead(500)
        response.end(String(error?.code ?? error))
      }
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const port = server.address().port
    const descriptor = descriptorFor(root, { port })
    runtime = createLocalRuntimeRestart({
      descriptor,
      processLike: identityFor(root),
      webServer: { host: '127.0.0.1', port, server },
      appExit: () => { exits += 1 },
      forkBroker: () => ({ ready: Promise.resolve({ type: 'ready', fingerprint: descriptorFingerprint(descriptor) }) }),
    })
    const response = await fetch(`http://127.0.0.1:${port}/remote-hosts/restart`, { method: 'POST' })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { accepted: true, state: 'requested' })
    assert.equal(exits, 1)
  } finally {
    await new Promise(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

test('management restart uses the request-local response when requests interleave', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-restart-'))
  const server = createHttpServer()
  let runtime
  let exits = 0
  let firstArrivedResolve
  const firstArrived = new Promise(resolve => { firstArrivedResolve = resolve })
  let firstCompleted = false
  try {
    server.on('request', async (request, response) => {
      const slot = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('slot')
      try {
        if (slot === '1') {
          firstArrivedResolve()
          await new Promise(resolve => setTimeout(resolve, 60))
        }
        const accepted = await runtime.restart()
        if (slot === '1') await new Promise(resolve => setTimeout(resolve, 180))
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(accepted))
        if (slot === '1') firstCompleted = true
      } catch (error) {
        response.writeHead(500)
        response.end(String(error?.code ?? error))
      }
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const port = server.address().port
    const descriptor = descriptorFor(root, { port })
    runtime = createLocalRuntimeRestart({
      descriptor,
      processLike: identityFor(root),
      webServer: { host: '127.0.0.1', port, server },
      appExit: () => { exits += 1 },
      forkBroker: () => ({ ready: Promise.resolve({ type: 'ready', fingerprint: descriptorFingerprint(descriptor) }) }),
    })

    const first = fetch(`http://127.0.0.1:${port}/remote-hosts/restart?slot=1`, { method: 'POST' }).then(async response => {
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { accepted: true, state: 'requested' })
      firstCompleted = true
    })
    await firstArrived
    const secondResponse = await fetch(`http://127.0.0.1:${port}/remote-hosts/restart?slot=2`, { method: 'POST' })
    assert.equal(secondResponse.status, 200)
    assert.deepEqual(await secondResponse.json(), { accepted: true, state: 'requested' })
    assert.equal(exits, 1)
    assert.equal(firstCompleted, false)
    await first
    assert.equal(exits, 1)
  } finally {
    await new Promise(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

test('broker waits for the original pid and launches once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-restart-'))
  try {
    const descriptor = normalizeManagedRuntimeDescriptor(descriptorFor(root))
    const alive = [true, true, false]
    const messages = []
    let launches = 0
    await runManagedRuntimeBroker({
      descriptor,
      parentPid: 41123,
      send: message => messages.push(message),
      wait: async (pid, { isAlive }) => {
        assert.equal(pid, 41123)
        while (await isAlive(pid)) {}
      },
      isAlive: async () => alive.shift() ?? false,
      launch: async value => {
        launches += 1
        assert.equal(value.profileId, descriptor.profileId)
        return { launched: true }
      },
    })
    assert.equal(launches, 1)
    assert.equal(messages[0].type, 'ready')
    assert.equal(messages[0].fingerprint, descriptorFingerprint(descriptor))
    assert.equal(messages[1].type, 'launched')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('broker treats a recycled original PID as already exited', async () => {
  let aliveChecks = 0
  const stamps = ['original-stamp', 'recycled-stamp']
  await waitForProcessExit(41123, {
    birthStamp: 'original-stamp',
    isAlive: async () => { aliveChecks += 1; return true },
    getProcessBirthStamp: async () => stamps.shift(),
    timeoutMs: 1000,
    pollMs: 1,
    identityCheckMs: 1,
  })
  assert.equal(aliveChecks >= 2, true)
})

test('managed launcher does not attach to a recycled PID in an old instance record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-restart-'))
  try {
    const descriptor = descriptorFor(root)
    const fingerprint = descriptorFingerprint(descriptor)
    await writeFile(descriptor.instancePath, JSON.stringify({
      pid: 53123,
      birthStamp: 'original-stamp',
      fingerprint,
      profileId: descriptor.profileId,
      port: descriptor.port,
    }), 'utf8')
    let probes = 0
    let spawned = 0
    const result = await launchManagedRuntime(descriptor, {
      isPidAlive: async () => true,
      getProcessBirthStamp: async () => 'recycled-stamp',
      inspectPort: async () => {
        probes += 1
        return probes < 3 ? 'free' : { state: 'occupied', pid: 53123 }
      },
      spawnProcess: () => { spawned += 1; return { pid: 53123, spawned: true } },
      log: async () => {},
    })
    assert.equal(result.attached, false)
    assert.equal(result.launched, true)
    assert.equal(spawned, 1)
    assert.equal(JSON.parse(await readFile(descriptor.instancePath, 'utf8')).birthStamp, 'recycled-stamp')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('managed launcher fails closed when a live instance birth stamp is unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-restart-'))
  try {
    const descriptor = descriptorFor(root)
    await writeFile(descriptor.instancePath, JSON.stringify({
      pid: 53123,
      birthStamp: 'original-stamp',
      fingerprint: descriptorFingerprint(descriptor),
      profileId: descriptor.profileId,
      port: descriptor.port,
    }), 'utf8')
    let spawned = 0
    await assert.rejects(launchManagedRuntime(descriptor, {
      isPidAlive: async () => true,
      getProcessBirthStamp: async pid => pid === process.pid ? 'launcher-stamp' : undefined,
      inspectPort: async () => 'free',
      spawnProcess: () => { spawned += 1; return { pid: 53123, spawned: true } },
      log: async () => {},
    }), error => error.code === 'LOCAL_RESTART_PORT_UNKNOWN')
    assert.equal(spawned, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('managed launcher keeps a legacy instance record without a birth stamp busy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-restart-'))
  try {
    const descriptor = descriptorFor(root)
    await writeFile(descriptor.instancePath, JSON.stringify({
      pid: 53123,
      fingerprint: descriptorFingerprint(descriptor),
      profileId: descriptor.profileId,
      port: descriptor.port,
    }), 'utf8')
    let spawned = 0
    await assert.rejects(launchManagedRuntime(descriptor, {
      getProcessBirthStamp: async pid => pid === process.pid ? 'launcher-stamp' : 'recycled-stamp',
      inspectPort: async () => 'free',
      spawnProcess: () => { spawned += 1; return { pid: 53123, spawned: true } },
      log: async () => {},
    }), error => error.code === 'LOCAL_RESTART_PORT_UNKNOWN')
    assert.equal(spawned, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('managed launcher fails closed for a malformed instance record even on a free port', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-restart-'))
  try {
    const descriptor = descriptorFor(root)
    await writeFile(descriptor.instancePath, '{malformed', 'utf8')
    let spawned = 0
    await assert.rejects(launchManagedRuntime(descriptor, {
      inspectPort: async () => 'free',
      spawnProcess: () => { spawned += 1; return { pid: 53123, spawned: true } },
      getProcessBirthStamp: async () => 'launcher-stamp',
      log: async () => {},
    }), error => error.code === 'LOCAL_RESTART_PORT_UNKNOWN')
    assert.equal(spawned, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('concurrent recycled-lock recovery has one reclaimer and one launcher', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-restart-'))
  try {
    const descriptor = descriptorFor(root)
    await writeFile(descriptor.mutexPath, JSON.stringify({
      pid: 99999999,
      birthStamp: 'dead-stamp',
      launcherVersion: 1,
      lockId: 'dead-lock',
    }), 'utf8')
    let staleChecks = 0
    let releaseStale
    const bothStale = new Promise(resolve => { releaseStale = resolve })
    const isPidAlive = async pid => {
      if (pid === 99999999) {
        staleChecks += 1
        if (staleChecks === 2) releaseStale()
        await bothStale
        return true
      }
      return true
    }
    const getProcessBirthStamp = async pid => pid === 99999999 ? 'recycled-stamp' : pid === 53123 ? 'runtime-stamp' : 'launcher-stamp'
    let probes = 0
    let spawned = 0
    const options = {
      isPidAlive,
      getProcessBirthStamp,
      inspectPort: async () => probes++ === 0 ? 'free' : { state: 'occupied', pid: 53123 },
      spawnProcess: () => { spawned += 1; return { pid: 53123, spawned: true } },
      log: async () => {},
    }
    const results = await Promise.allSettled([launchManagedRuntime(descriptor, options), launchManagedRuntime(descriptor, options)])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal(results.filter(result => result.status === 'rejected' && result.reason?.code === 'MANAGED_RUNTIME_BUSY').length, 1)
    assert.equal(spawned, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('managed launcher keeps an unknown lock owner busy even when its port is free', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-restart-'))
  try {
    const descriptor = descriptorFor(root)
    await writeFile(descriptor.mutexPath, JSON.stringify({
      pid: 99999999,
      birthStamp: 'original-stamp',
      launcherVersion: 1,
      lockId: 'unknown-lock',
    }), 'utf8')
    let spawned = 0
    await assert.rejects(launchManagedRuntime(descriptor, {
      isPidAlive: async () => true,
      getProcessBirthStamp: async pid => pid === process.pid ? 'launcher-stamp' : undefined,
      inspectPort: async () => 'free',
      spawnProcess: () => { spawned += 1; return { pid: 53123, spawned: true } },
      log: async () => {},
    }), error => error.code === 'MANAGED_RUNTIME_BUSY')
    assert.equal(spawned, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('managed launcher keeps a legacy lock without a birth stamp busy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-restart-'))
  try {
    const descriptor = descriptorFor(root)
    await writeFile(descriptor.mutexPath, JSON.stringify({ pid: 99999999, launcherVersion: 1, lockId: 'legacy-lock' }), 'utf8')
    let spawned = 0
    await assert.rejects(launchManagedRuntime(descriptor, {
      isPidAlive: async () => false,
      getProcessBirthStamp: async () => 'launcher-stamp',
      inspectPort: async () => 'free',
      spawnProcess: () => { spawned += 1; return { pid: 53123, spawned: true } },
      log: async () => {},
    }), error => error.code === 'MANAGED_RUNTIME_BUSY')
    assert.equal(spawned, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('managed launcher rejects unknown occupied ports and does not spawn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-restart-'))
  try {
    let spawned = 0
    let released = 0
    await assert.rejects(
      launchManagedRuntime(descriptorFor(root), {
        acquire: async () => async () => { released += 1 },
        inspectPort: async () => 'occupied',
        getProcessBirthStamp: async () => 'launcher-stamp',
        spawnProcess: () => { spawned += 1 },
      }),
      error => error.code === 'LOCAL_RESTART_PORT_OCCUPIED',
    )
    assert.equal(spawned, 0)
    assert.equal(released, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('managed launcher failure log keeps owner and spawned PIDs for ready-owner diagnosis', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-restart-'))
  try {
    const entries = []
    let probes = 0
    await assert.rejects(
      launchManagedRuntime(descriptorFor(root), {
        inspectPort: async () => probes++ === 0 ? 'free' : { state: 'occupied', pid: 9876 },
        spawnProcess: () => ({ pid: 1234, spawned: true }),
        getProcessBirthStamp: async () => 'spawned-stamp',
        log: async (_descriptor, event, details) => entries.push({ event, details }),
      }),
      error => error.code === 'LOCAL_RESTART_PORT_OCCUPIED',
    )
    assert.deepEqual(entries.at(-1), {
      event: 'failed',
      details: { code: 'LOCAL_RESTART_PORT_OCCUPIED', stage: 'ready-owner', ownerPid: 9876, spawnedPid: 1234, spawnedBirthStamp: 'spawned-stamp' },
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('managed launcher uses platform-specific runtime spawn flags and preserves ownership handoff', async () => {
  for (const [platform, expectedDetached] of [['win32', false], ['linux', true]]) {
    const root = await mkdtemp(join(tmpdir(), 'dsh-local-restart-'))
    try {
      const descriptor = descriptorFor(root, { logPath: join(root, 'managed-runtime.log') })
      let probes = 0
      let spawnArgs
      let unrefs = 0
      const child = {
        pid: 53123,
        spawned: true,
        unref() { unrefs += 1 },
      }
      const result = await launchManagedRuntime(descriptor, {
        platform,
        supervise: true,
        inspectPort: async () => probes++ === 0 ? 'free' : { state: 'occupied', pid: 53123 },
        spawnProcess: (...args) => {
          spawnArgs = args
          return child
        },
        getProcessBirthStamp: async () => 'test-stamp',
      })
      assert.equal(spawnArgs[2].detached, expectedDetached)
      assert.equal(spawnArgs[2].windowsHide, true)
      assert.deepEqual(JSON.parse(await readFile(descriptor.instancePath, 'utf8')), {
        pid: 53123,
        birthStamp: 'test-stamp',
        fingerprint: descriptorFingerprint(descriptor),
        profileId: descriptor.profileId,
        port: descriptor.port,
      })
      assert.equal(unrefs, platform === 'win32' ? 0 : 1)
      assert.match(await readFile(descriptor.logPath, 'utf8'), /"event":"launched"/)
      await rm(descriptor.logPath)
      assert.deepEqual(result, { attached: false, launched: true, pid: 53123, profileId: descriptor.profileId })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

test('port owner parsing requires one local LISTENING owner and ignores remote or stale rows', () => {
  const windows = [
    '  TCP    10.0.0.8:41234      127.0.0.1:3182      ESTABLISHED     777',
    '  TCP    127.0.0.1:3182      0.0.0.0:0          LISTENING       123',
    '  TCP    127.0.0.1:3182      0.0.0.0:0          TIME_WAIT       999',
  ].join('\n')
  assert.equal(parsePortOwnerPid(windows, 3182, 'win32'), 123)
  assert.equal(parsePortOwnerPid('TCP 10.0.0.8:3182 0.0.0.0:0 LISTENING 456', 3182, 'win32'), undefined)
  assert.equal(parsePortOwnerPid([
    'TCP 0.0.0.0:3182 0.0.0.0:0 LISTENING 123',
    'TCP [::]:3182 [::]:0 LISTENING 123',
  ].join('\n'), 3182, 'win32'), 123)
  assert.equal(parsePortOwnerPid([
    'LISTEN 0 128 127.0.0.1:3182 0.0.0.0:* users:(("node",pid=123,fd=3))',
    'ESTAB 0 0 10.0.0.8:41234 127.0.0.1:3182 users:(("node",pid=777,fd=4))',
  ].join('\n'), 3182, 'linux'), 123)
  assert.equal(parsePortOwnerPid([
    'LISTEN 0 128 127.0.0.1:3182 0.0.0.0:* users:(("node",pid=123,fd=3))',
    'LISTEN 0 128 0.0.0.0:3182 0.0.0.0:* users:(("node",pid=456,fd=4))',
  ].join('\n'), 3182, 'linux'), undefined)
})

test('real fork broker handshakes and launches a short-lived listener on a dynamic port', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-restart-'))
  const port = await unusedPort()
  const stopPath = join(root, 'stop-runtime')
  let launchedPid
  const runtimeCode = [
    "const fs = require('node:fs')",
    "const net = require('node:net')",
    "process.stdout.write('managed-stdout\\n'); process.stderr.write('managed-stderr\\n')",
    'const server = net.createServer()',
    `server.listen(${port}, '127.0.0.1', () => { const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(stopPath)})) { clearInterval(timer); server.close(() => process.exit(0)) } }, 20) })`,
  ].join(';')
  const fixture = spawn(process.execPath, ['-e', "process.stdin.once('data', () => process.exit(0)); process.stdin.resume()"], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
  let broker
  try {
    const descriptor = descriptorFor(root, {
      profileId: `fork-${port}`,
      launcherId: `managed-runtime/fork-${port}`,
      port,
      argv: [process.execPath, '-e', runtimeCode],
      readyTimeoutMs: 30000,
      exitWaitMs: 3000,
      logPath: join(root, 'runtime.log'),
    })
    broker = forkManagedRuntimeBroker({ descriptor, parentPid: fixture.pid })
    const launched = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('broker launch timeout')), 30000)
      const finish = message => { clearTimeout(timer); resolve(message) }
      const fail = error => { clearTimeout(timer); reject(error) }
      const child = broker.child
      child.on('message', message => {
        if (message?.type === 'launched') finish(message)
        else if (message?.type === 'error') fail(new Error(`broker error ${message.code ?? 'unknown'}`))
      })
      child.once('error', fail)
      child.once('exit', code => { if (code !== 0) fail(new Error(`broker exited ${code}`)) })
    })
    await broker.ready
    const fixtureExit = new Promise((resolve, reject) => {
      fixture.once('exit', resolve)
      fixture.once('error', reject)
    })
    fixture.stdin.write('stop')
    await fixtureExit
    const message = await launched
    assert.equal(message.type, 'launched')
    assert.equal(message.fingerprint, descriptorFingerprint(descriptor))
    launchedPid = message.result.pid
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.doesNotThrow(() => process.kill(launchedPid, 0))
    if (process.platform === 'win32') assert.doesNotThrow(() => process.kill(broker.child.pid, 0))
    await writeFile(stopPath, 'stop')
    await waitForPidExit(launchedPid)
    await waitForPidExit(broker.child.pid)
    const runtimeLog = await readFile(descriptor.logPath, 'utf8')
    assert.match(runtimeLog, /managed-stdout/)
    assert.match(runtimeLog, /managed-stderr/)
  } finally {
    broker?.disconnect?.()
    try { fixture.stdin?.write('stop') } catch {}
    fixture.stdin?.end()
    await writeFile(stopPath, 'stop').catch(() => {})
    if (launchedPid !== undefined) await waitForPidExit(launchedPid).catch(() => {})
    await removeTemp(root)
  }
})

test('broker survives the real IPC parent exit after the ready handshake', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-restart-'))
  const port = await unusedPort()
  const readyPath = join(root, 'controller-ready')
  const controllerErrorPath = join(root, 'controller-error')
  const brokerPidPath = join(root, 'broker-pid')
  const runtimeReadyPath = join(root, 'runtime-ready')
  const stopPath = join(root, 'stop-runtime')
  let controller
  let launchedPid
  let controllerExited = false
  let controllerWaitTimer
  const runtimeCode = [
    "const fs = require('node:fs')",
    "const net = require('node:net')",
    `const readyPath = ${JSON.stringify(runtimeReadyPath)}`,
    `const stopPath = ${JSON.stringify(stopPath)}`,
    'const server = net.createServer()',
    `server.listen(${port}, '127.0.0.1', () => { fs.writeFileSync(readyPath, String(process.pid)); const timer = setInterval(() => { if (fs.existsSync(stopPath)) { clearInterval(timer); server.close(() => process.exit(0)) } }, 20) })`,
  ].join(';')
  try {
    const descriptor = descriptorFor(root, {
      profileId: `ipc-parent-${port}`,
      launcherId: `managed-runtime/ipc-parent-${port}`,
      port,
      argv: [process.execPath, '-e', runtimeCode],
      readyTimeoutMs: 30000,
      exitWaitMs: 30000,
      logPath: join(root, 'runtime.log'),
    })
    const descriptorPath = join(root, 'descriptor.json')
    await writeFile(descriptorPath, `${JSON.stringify(descriptor)}\n`, 'utf8')
    const runtimeModuleUrl = new URL('../packages/runtime-interface/src/index.js', import.meta.url).href
    const controllerCode = [
      "const fs = require('node:fs')",
      `const descriptor = JSON.parse(fs.readFileSync(${JSON.stringify(descriptorPath)}, 'utf8'))`,
      `const readyPath = ${JSON.stringify(readyPath)}`,
      `const errorPath = ${JSON.stringify(controllerErrorPath)}`,
      `const brokerPidPath = ${JSON.stringify(brokerPidPath)}`,
      'const timeout = setTimeout(() => process.exit(3), 60000)',
      "process.stdin.on('data', () => { clearTimeout(timeout); process.exit(2) })",
      `import(${JSON.stringify(runtimeModuleUrl)}).then(({ forkManagedRuntimeBroker }) => { const broker = forkManagedRuntimeBroker({ descriptor, parentPid: process.pid }); fs.writeFileSync(brokerPidPath, String(broker.child.pid)); broker.ready.then(() => { fs.writeFileSync(readyPath, 'ready'); clearTimeout(timeout); process.exit(0) }).catch(error => { fs.writeFileSync(errorPath, String(error?.code ?? error)); clearTimeout(timeout); process.exit(1) }) }).catch(error => { fs.writeFileSync(errorPath, String(error?.stack ?? error)); clearTimeout(timeout); process.exit(1) })`,
    ].join(';')
    controller = spawn(process.execPath, ['-e', controllerCode], {
      cwd: root,
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true,
    })
    let controllerStderr = ''
    controller.stderr?.on('data', chunk => { controllerStderr += chunk.toString() })
    const controllerExit = new Promise((resolve, reject) => {
      controller.once('error', reject)
      controller.once('exit', (code, signal) => { controllerExited = true; resolve({ code, signal }) })
    })
    const exit = await Promise.race([
      controllerExit,
      new Promise((_, reject) => { controllerWaitTimer = setTimeout(() => reject(new Error('real IPC parent did not exit after ready')), 60000) }),
    ])
    clearTimeout(controllerWaitTimer)
    let controllerError = ''
    try { controllerError = await readFile(controllerErrorPath, 'utf8') } catch {}
    assert.equal(exit.code, 0, `controller exited ${exit.code}: ${controllerError}`)
    assert.equal(controllerStderr, '', `controller stderr: ${controllerStderr}`)
    assert.equal(await readFile(readyPath, 'utf8'), 'ready')
    const brokerPid = Number(await waitForFile(brokerPidPath))
    assert.equal(Number.isSafeInteger(brokerPid) && brokerPid > 0, true)
    launchedPid = Number(await waitForFile(runtimeReadyPath))
    assert.equal(Number.isSafeInteger(launchedPid) && launchedPid > 0, true)
    await waitForFile(descriptor.instancePath)
    const instance = JSON.parse(await readFile(descriptor.instancePath, 'utf8'))
    assert.equal(instance.pid, launchedPid)
    // An instance file alone does not prove that its supervised service
    // survived the IPC parent. Wait for readiness and assert both lifetimes.
    const logDeadline = Date.now() + 10000
    while (!(await readFile(descriptor.logPath, 'utf8')).includes('"event":"launched"')) {
      assert.ok(Date.now() < logDeadline, 'broker did not record readiness')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.doesNotThrow(() => process.kill(launchedPid, 0))
    if (process.platform === 'win32') assert.doesNotThrow(() => process.kill(brokerPid, 0))
    const launchLog = (await readFile(join(root, 'runtime.log'), 'utf8')).trim().split(/\r?\n/).filter(line => line.trimStart().startsWith('{')).map(line => JSON.parse(line))
    assert.equal(launchLog.filter(entry => entry.event === 'launched').length, 1)
    await writeFile(stopPath, 'stop', 'utf8')
    await waitForPidExit(launchedPid)
    await waitForPidExit(brokerPid)
  } finally {
    clearTimeout(controllerWaitTimer)
    if (!controllerExited) {
      try { controller?.stdin?.write('stop') } catch {}
      controller?.stdin?.end()
      await new Promise(resolve => controller?.once('exit', resolve) ?? resolve()).catch(() => {})
    }
    if (launchedPid !== undefined) {
      await writeFile(stopPath, 'stop').catch(() => {})
      await waitForPidExit(launchedPid).catch(() => {})
    }
    await removeTemp(root)
  }
})

test('management restart exits only after an initially unset exitCode becomes zero', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-restart-'))
  try {
    const server = new EventEmitter()
    const response = new EventEmitter()
    const processLike = identityFor(root, { exitCode: undefined })
    const exits = []
    processLike.exit = code => exits.push(code)
    let resolveExitCode
    const exitCodeChanged = new Promise(resolve => { resolveExitCode = resolve })
    const descriptor = descriptorFor(root, { exitWaitMs: 1000 })
    const runtime = createLocalRuntimeRestart({
      descriptor,
      processLike,
      webServer: { port: descriptor.port, server },
      appExit: () => {
        setTimeout(() => {
          processLike.exitCode = 0
          resolveExitCode()
        }, 10)
      },
      forkBroker: () => ({ ready: Promise.resolve({ type: 'ready', fingerprint: descriptorFingerprint(descriptor) }), close: () => {} }),
    })
    server.emit('request', { method: 'POST', url: '/remote-hosts/restart' }, response)
    assert.deepEqual(await runtime.restart(), { accepted: true, state: 'requested' })
    assert.deepEqual(exits, [])
    response.emit('finish')
    await exitCodeChanged
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.deepEqual(exits, [0])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('management restart does not treat an existing exitCode as this shutdown completion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-restart-'))
  try {
    const server = new EventEmitter()
    const response = new EventEmitter()
    const processLike = identityFor(root, { exitCode: 0 })
    const exits = []
    processLike.exit = code => exits.push(code)
    const descriptor = descriptorFor(root, { exitWaitMs: 1000 })
    const runtime = createLocalRuntimeRestart({
      descriptor,
      processLike,
      webServer: { port: descriptor.port, server },
      appExit: () => {},
      forkBroker: () => ({ ready: Promise.resolve({ type: 'ready', fingerprint: descriptorFingerprint(descriptor) }), close: () => {} }),
    })
    server.emit('request', { method: 'POST', url: '/remote-hosts/restart' }, response)
    assert.deepEqual(await runtime.restart(), { accepted: true, state: 'requested' })
    response.emit('finish')
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.deepEqual(exits, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('broker ready timeout sends cancellation and disconnects before parent exit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-restart-'))
  try {
    const descriptor = descriptorFor(root, { readyTimeoutMs: 250 })
    const child = new EventEmitter()
    child.connected = true
    const sent = []
    let disconnects = 0
    child.send = (message, callback) => {
      sent.push(message)
      if (message.type === 'cancel') {
        callback?.()
      }
    }
    child.disconnect = () => {
      disconnects += 1
      child.connected = false
      child.emit('disconnect')
    }
    child.unref = () => {}
    const broker = forkManagedRuntimeBroker({ descriptor }, { forkProcess: () => child })
    await assert.rejects(broker.ready, error => error.code === 'LOCAL_RESTART_READY_TIMEOUT')
    assert.equal(sent.some(message => message.type === 'cancel'), true)
    assert.equal(disconnects, 1)
    assert.equal(child.connected, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('start broker waits for a matching launched result and rejects lost or invalid confirmation', async () => {
  for (const outcome of ['success', 'wrong-fingerprint', 'disconnect', 'error']) {
    const root = await mkdtemp(join(tmpdir(), 'dsh-local-restart-'))
    try {
      const descriptor = descriptorFor(root)
      const fingerprint = descriptorFingerprint(descriptor)
      const child = new EventEmitter()
      child.connected = true
      let channelUnrefs = 0
      child.channel = { unref() { channelUnrefs += 1 } }
      child.unref = () => {}
      child.disconnect = () => { child.connected = false; child.emit('disconnect') }
      child.send = (message, callback) => {
        callback?.()
        if (message.type === 'prepare') {
          assert.equal(message.mode, 'start')
          queueMicrotask(() => child.emit('message', { type: 'ready', fingerprint, launcherVersion: 1 }))
        } else if (message.type === 'commit') {
          queueMicrotask(() => child.emit('message', { type: 'committed', fingerprint }))
        }
      }
      const broker = forkManagedRuntimeBroker({ descriptor, mode: 'start', parentBirthStamp: 'test-stamp' }, { forkProcess: () => child })
      await broker.ready
      let completed = false
      broker.launched.then(() => { completed = true }, () => {})
      await Promise.resolve()
      assert.equal(completed, false)
      assert.equal(channelUnrefs, 0)
      const result = { pid: 1234, profileId: descriptor.profileId, attached: false, launched: true }
      if (outcome === 'success') {
        child.emit('message', { type: 'launched', fingerprint, result })
        assert.deepEqual(await broker.launched, result)
        assert.equal(channelUnrefs, 1)
        broker.close()
      } else {
        if (outcome === 'disconnect') child.disconnect()
        else if (outcome === 'error') child.emit('message', { type: 'error', code: 'LOCAL_RESTART_PORT_OCCUPIED' })
        else child.emit('message', { type: 'launched', fingerprint: 'wrong', result })
        await assert.rejects(broker.launched, error => error instanceof ManagedRuntimeError)
      }
    } finally {
      await removeTemp(root)
    }
  }
})

test('start mode waits for commit without waiting for its living CLI parent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-restart-'))
  try {
    let committed = false
    let waitedForExit = false
    const result = { pid: 1234 }
    await runManagedRuntimeBroker({
      descriptor: descriptorFor(root), mode: 'start', parentPid: process.pid,
      send: () => {},
      waitForCommit: async () => { committed = true },
      wait: async () => { waitedForExit = true },
      launch: async (_descriptor, options) => {
        assert.equal(committed, true)
        assert.equal(options.supervise, true)
        return result
      },
    })
    assert.equal(waitedForExit, false)
    assert.throws(() => forkManagedRuntimeBroker({ descriptor: descriptorFor(root), mode: 'invalid' }), /mode is invalid/)
  } finally {
    await removeTemp(root)
  }
})

test('real descriptor CLI exits after ready and repeated invocation attaches to the same surviving runtime', { timeout: 90000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-restart-'))
  const port = await unusedPort()
  const stopPath = join(root, 'stop-runtime')
  let runtimePid
  try {
    const code = `const fs=require('node:fs'); const s=require('node:net').createServer(); s.listen(${port},'127.0.0.1'); const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(stopPath)})){clearInterval(t);s.close()}},20)`
    const descriptor = descriptorFor(root, { port, argv: [process.execPath, '-e', code], readyTimeoutMs: 30000, logPath: join(root, 'runtime.log') })
    const path = join(root, 'descriptor.json')
    await writeFile(path, JSON.stringify(descriptor))
    const launcher = fileURLToPath(new URL('../packages/runtime-interface/src/managed-runtime-launcher.mjs', import.meta.url))
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const cli = spawn(process.execPath, [launcher, '--descriptor', path], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      cli.stderr.on('data', chunk => { stderr += chunk })
      const exit = await new Promise((resolve, reject) => { cli.once('error', reject); cli.once('exit', resolve) })
      assert.equal(exit, 0, stderr)
      const instance = JSON.parse(await readFile(descriptor.instancePath, 'utf8'))
      if (attempt === 0) runtimePid = instance.pid
      assert.equal(instance.pid, runtimePid)
      await new Promise(resolve => setTimeout(resolve, 200))
      assert.doesNotThrow(() => process.kill(runtimePid, 0))
    }
  } finally {
    await writeFile(stopPath, 'stop').catch(() => {})
    if (runtimePid) await waitForPidExit(runtimePid)
    await removeTemp(root)
  }
})

test('start broker rejects failed launch delivery and cancellation during the send callback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-restart-'))
  try {
    for (const failure of ['callback-error', 'throw', 'disconnect']) {
      let cancelled = false
      await assert.rejects(runManagedRuntimeBroker({
        descriptor: descriptorFor(root), mode: 'start', parentPid: process.pid,
        isCancelled: () => cancelled,
        launch: async () => ({ pid: 1234 }),
        send: async message => {
          if (message.type !== 'launched') return true
          if (failure === 'throw') throw new Error('IPC closed')
          if (failure === 'callback-error') return false
          cancelled = true
          return true
        },
      }), error => error.code === (failure === 'disconnect' ? 'LOCAL_RESTART_BROKER_CANCELLED' : 'LOCAL_RESTART_BROKER_FAILED'))
    }
  } finally {
    await removeTemp(root)
  }
})

test('cancelled broker never launches after the original runtime exits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-restart-'))
  try {
    const descriptor = normalizeManagedRuntimeDescriptor(descriptorFor(root))
    let cancelled = false
    let launches = 0
    const messages = []
    await assert.rejects(runManagedRuntimeBroker({
      descriptor,
      parentPid: 41123,
      send: message => messages.push(message),
      isCancelled: () => cancelled,
      wait: async () => { cancelled = true },
      launch: async () => { launches += 1 },
    }), error => error.code === 'LOCAL_RESTART_BROKER_CANCELLED')
    assert.equal(messages[0].type, 'ready')
    assert.equal(launches, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('managed launcher spawn failure releases mutex without killing a process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-restart-'))
  try {
    let released = 0
    await assert.rejects(
      launchManagedRuntime(descriptorFor(root), {
        acquire: async () => async () => { released += 1 },
        inspectPort: async () => 'free',
        spawnProcess: () => { throw new Error('spawn failed') },
      }),
      error => error.code === 'LOCAL_RESTART_LAUNCH_FAILED',
    )
    assert.equal(released, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('managed launcher reclaims a complete lock owned by a dead process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-restart-'))
  try {
    const descriptor = descriptorFor(root)
    await writeFile(descriptor.mutexPath, JSON.stringify({ pid: 99999999, birthStamp: 'dead-stamp', launcherVersion: 1, lockId: 'dead-lock' }), 'utf8')
    let probes = 0
    const result = await launchManagedRuntime(descriptor, {
      inspectPort: async () => probes++ === 0 ? 'free' : { state: 'occupied', pid: 53123 },
      spawnProcess: () => ({ pid: 53123, spawned: true }),
      getProcessBirthStamp: async () => 'test-stamp',
      log: async () => {},
    })
    assert.equal(result.launched, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('managed launcher publishes a complete mutex record before it is observable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-restart-'))
  try {
    const descriptor = descriptorFor(root)
    let probes = 0
    const result = await launchManagedRuntime(descriptor, {
      inspectPort: async () => {
        probes += 1
        if (probes === 1) {
          const lock = JSON.parse(await readFile(descriptor.mutexPath, 'utf8'))
          assert.equal(Number.isSafeInteger(lock.pid), true)
          assert.equal(typeof lock.birthStamp, 'string')
          assert.equal(lock.launcherVersion, 1)
          assert.equal(typeof lock.lockId, 'string')
          return 'free'
        }
        return { state: 'occupied', pid: 53123 }
      },
      spawnProcess: () => ({ pid: 53123, spawned: true }),
      getProcessBirthStamp: async () => 'test-stamp',
      log: async () => {},
    })
    assert.equal(result.launched, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('descriptor rejects RPC-shaped unknown launch fields', () => {
  assert.throws(() => normalizeManagedRuntimeDescriptor({ command: 'node', port: 3182 }), error => error.code === 'LOCAL_RESTART_DESCRIPTOR_FIELDS')
})

test('runtime config reads only the trusted descriptor path form', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-restart-'))
  try {
    const path = join(root, 'descriptor.json')
    await writeFile(path, JSON.stringify(descriptorFor(root)), 'utf8')
    const config = normalizeRuntimeInterfaceConfig({ localRestart: { descriptorPath: path } })
    assert.equal(config.localRestart.profileId, 'test-3182')
    assert.equal(config.localRestart.port, 3182)
    assert.equal(config.localRestart.hostId, 'local')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
