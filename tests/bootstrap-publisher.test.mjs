import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { performance } from 'node:perf_hooks'
import { apply, inject } from '../packages/mobile-bootstrap-rc1/src/index.js'
import { createBootstrapPublisher } from '../packages/mobile-bootstrap-rc1/src/publisher.js'

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

function fixtureStore(directory) {
  const file = path.join(directory, 'fixture-store.cjs')
  fs.writeFileSync(file, `'use strict'
const fs = require('node:fs')
const path = require('node:path')
const delay = Number(process.env.DSH_BOOTSTRAP_FIXTURE_DELAY_MS || 0)
function pause(ms) { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }
function stateFile(home) { return path.join(home, 'fixture-state.json') }
function readState(home) { try { return JSON.parse(fs.readFileSync(stateFile(home), 'utf8')) } catch { return { attempts: 0 } } }
function publishBootstrap(port, authenticatedRootUrl, home) {
  const state = readState(home)
  state.attempts++
  fs.writeFileSync(stateFile(home), JSON.stringify(state))
  pause(delay)
  if (process.env.DSH_BOOTSTRAP_FIXTURE_MODE === 'fail') throw new Error('ETIMEDOUT')
  if (process.env.DSH_BOOTSTRAP_FIXTURE_MODE === 'typed-fail') { const error = new Error('internal'); error.code = 'BOOTSTRAP_STALE_INSTANCE'; throw error }
  const instanceId = 'fixture-' + state.attempts
  fs.writeFileSync(path.join(home, 'bootstrap.json'), JSON.stringify({ port, authenticatedRootUrl, instanceId }))
  return () => {
    try {
      const current = JSON.parse(fs.readFileSync(path.join(home, 'bootstrap.json'), 'utf8'))
      if (current.instanceId === instanceId) fs.unlinkSync(path.join(home, 'bootstrap.json'))
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}
module.exports = { publishBootstrap }
`, 'utf8')
  return file
}

function readState(home) {
  try { return JSON.parse(fs.readFileSync(path.join(home, 'fixture-state.json'), 'utf8')) } catch { return { attempts: 0 } }
}

async function waitUntil(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('timed out waiting for worker state')
}

function testOptions(home, storePath, extra = {}) {
  return {
    home,
    storePath,
    retryBaseMs: 10,
    retryMaxMs: 25,
    ...extra,
  }
}

test('Cordis bootstrap effect starts the worker without waiting for synchronous store work', async () => {
  assert.deepEqual(inject, ['runtimeInterface'])
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bootstrap-publisher-'))
  const storePath = fixtureStore(base)
  const home = path.join(base, 'home')
  fs.mkdirSync(home)
  const port = await freePort()
  const failures = []
  let dispose
  try {
    let endpointCalls = 0
    const started = performance.now()
    dispose = apply({
      runtimeInterface: {
        localBootstrapEndpoint() {
          endpointCalls++
          return { port, authenticatedRootUrl: `http://127.0.0.1:${port}/?token=fixture` }
        },
      },
      effect(effect) { return effect() },
    }, {
      publisherOptions: testOptions(home, storePath, {
        workerEnvironment: { ...process.env, DSH_BOOTSTRAP_FIXTURE_DELAY_MS: '500' },
        onFailure: code => failures.push(code),
      }),
    })
    assert.ok(performance.now() - started < 200, 'effect setup should not wait for publisher')
    assert.equal(endpointCalls, 1)
    await waitUntil(() => fs.existsSync(path.join(home, 'bootstrap.json')))
    assert.deepEqual(failures, [])
  } finally {
    dispose?.()
    await new Promise(resolve => setTimeout(resolve, 40))
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('worker reports controlled failures and cancellation stops exponential retries', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bootstrap-publisher-'))
  const storePath = fixtureStore(base)
  const home = path.join(base, 'home')
  fs.mkdirSync(home)
  const port = await freePort()
  const failures = []
  let dispose
  try {
    dispose = createBootstrapPublisher({ ...testOptions(home, storePath, {
      workerEnvironment: { ...process.env, DSH_BOOTSTRAP_FIXTURE_MODE: 'fail' },
      maxAttempts: 20,
      onFailure: code => failures.push(code),
    }), port, authenticatedRootUrl: `http://127.0.0.1:${port}/?token=fixture` })
    await waitUntil(() => failures.length >= 1)
    dispose()
    const attemptsAfterDispose = readState(home).attempts
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(readState(home).attempts, attemptsAfterDispose)
    assert.ok(failures.length >= 1)
    assert.ok(failures.every(code => code === 'BOOTSTRAP_PUBLISH_FAILED'))
  } finally {
    dispose?.()
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('worker preserves an existing controlled bootstrap failure code', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bootstrap-publisher-'))
  const storePath = fixtureStore(base)
  const home = path.join(base, 'home')
  fs.mkdirSync(home)
  const port = await freePort()
  const failures = []
  let dispose
  try {
    dispose = createBootstrapPublisher({ ...testOptions(home, storePath, {
      workerEnvironment: { ...process.env, DSH_BOOTSTRAP_FIXTURE_MODE: 'typed-fail' },
      maxAttempts: 1,
      onFailure: code => failures.push(code),
    }), port, authenticatedRootUrl: `http://127.0.0.1:${port}/?token=fixture` })
    await waitUntil(() => failures.length > 0)
    assert.deepEqual(failures, ['BOOTSTRAP_STALE_INSTANCE'])
  } finally {
    dispose?.()
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('late worker cleanup only removes its own bootstrap instance', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bootstrap-publisher-'))
  const storePath = fixtureStore(base)
  const home = path.join(base, 'home')
  fs.mkdirSync(home)
  const port = await freePort()
  let firstDispose
  let secondDispose
  try {
    const options = testOptions(home, storePath)
    firstDispose = createBootstrapPublisher({ ...options, port, authenticatedRootUrl: `http://127.0.0.1:${port}/?token=first` })
    await waitUntil(() => fs.existsSync(path.join(home, 'bootstrap.json')))
    secondDispose = createBootstrapPublisher({ ...options, port, authenticatedRootUrl: `http://127.0.0.1:${port}/?token=second` })
    await waitUntil(() => JSON.parse(fs.readFileSync(path.join(home, 'bootstrap.json'), 'utf8')).authenticatedRootUrl.endsWith('token=second'))
    firstDispose()
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'bootstrap.json'), 'utf8')).authenticatedRootUrl.endsWith('token=second'), true)
    secondDispose()
    await waitUntil(() => !fs.existsSync(path.join(home, 'bootstrap.json')))
  } finally {
    firstDispose?.()
    secondDispose?.()
    fs.rmSync(base, { recursive: true, force: true })
  }
})
