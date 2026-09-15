import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AGENT_OPERATION_METHODS,
  CURRENT_AGENT_OPERATIONS_VERSION,
  LEGACY_AGENT_OPERATIONS_VERSION,
  AgentOperationError,
  createAgentOperations,
} from '../packages/runtime-interface/src/agent-operations.js'

const versions = [LEGACY_AGENT_OPERATIONS_VERSION, CURRENT_AGENT_OPERATIONS_VERSION]

function fixture(version, overrides = {}) {
  const calls = []
  const agent = { id: 'agent-1', privateContext: { secret: true } }
  const sessionController = overrides.sessionController ?? {
    resolveAgent(sessionId) {
      calls.push(['resolveAgent', sessionId])
      return { agent }
    },
  }
  const operations = createAgentOperations({
    sessionController,
    commands: overrides.commands,
    goals: overrides.goals,
    agentPresets: overrides.agentPresets,
    upstreamVersion: version,
  })
  return { agent, calls, operations }
}

test('both runtime versions expose the same frozen narrow operation surface', async () => {
  assert.deepEqual(AGENT_OPERATION_METHODS, [
    'commands.execute', 'goal.create', 'goal.pause', 'goal.resume', 'goal.clear',
    'agentPresets.select',
  ])

  for (const version of versions) {
    const signal = new AbortController().signal
    const { agent, calls, operations } = fixture(version, {
      commands: {
        execute(receivedAgent, line, images, receivedSignal) {
          calls.push(['commands.execute', receivedAgent, line, images, receivedSignal])
          return { ok: true, value: { commandId: 'command-1', result: { text: 'done' } } }
        },
      },
      goals: {
        remoteExportCreate(receivedAgent, request) {
          calls.push(['goal.create', receivedAgent, request])
          return { ok: true, value: { ref: { id: 'goal-1', revision: 1 } } }
        },
        pause(receivedAgent, ref) { calls.push(['goal.pause', receivedAgent, ref]); return { id: 'goal-1', revision: 2 } },
        resume(receivedAgent, ref) { calls.push(['goal.resume', receivedAgent, ref]); return { id: 'goal-1', revision: 3 } },
        clear(receivedAgent, ref) { calls.push(['goal.clear', receivedAgent, ref]); return { id: 'goal-1', revision: 4 } },
      },
      agentPresets: {
        select(receivedAgent, preset) { calls.push(['agentPresets.select', receivedAgent, preset]); return { ok: true, value: preset } },
      },
    })

    assert.ok(Object.isFrozen(operations))
    assert.ok(Object.isFrozen(operations.commands))
    assert.ok(Object.isFrozen(operations.goal))
    assert.ok(Object.isFrozen(operations.agentPresets))
    assert.equal(operations.sessionController, undefined)

    const image = { mediaType: 'image/png', data: 'encoded', name: 'screen.png' }
    const command = await operations.commands.execute({
      sessionId: 'session-1', line: '/permission read-only', images: [image],
    }, signal)
    assert.deepEqual(command, { commandId: 'command-1', result: { text: 'done' } })
    const commandCall = calls.find(call => call[0] === 'commands.execute')
    assert.equal(commandCall[1], agent)
    assert.equal(commandCall[2], '/permission read-only')
    assert.deepEqual(commandCall[3], version === CURRENT_AGENT_OPERATIONS_VERSION
      ? [{ type: 'image', ...image }]
      : [image])
    assert.equal(commandCall[4], signal)

    assert.deepEqual(await operations.goal.create({ sessionId: 'session-1', objective: 'Ship', maxGoalRounds: 4 }), { ref: { id: 'goal-1', revision: 1 } })
    assert.deepEqual(await operations.goal.pause({ sessionId: 'session-1', ref: { id: 'goal-1', revision: 1 } }), { id: 'goal-1', revision: 2 })
    assert.deepEqual(await operations.goal.resume({ sessionId: 'session-1', ref: { id: 'goal-1', revision: 2 } }), { id: 'goal-1', revision: 3 })
    assert.deepEqual(await operations.goal.clear({ sessionId: 'session-1', ref: { id: 'goal-1', revision: 3 } }), { id: 'goal-1', revision: 4 })
    assert.equal(await operations.agentPresets.select({ sessionId: 'session-1', agentPreset: 'fast' }), 'fast')

    for (const [, receivedAgent] of calls.filter(call => call[0] !== 'resolveAgent')) {
      assert.equal(receivedAgent, agent)
      assert.equal(receivedAgent.privateContext.secret, true)
    }
  }
})

test('operation envelopes unwrap success and preserve official failures', async () => {
  const failure = Object.assign(new Error('official operation failed'), { code: 'agent/failed' })
  const { operations } = fixture(LEGACY_AGENT_OPERATIONS_VERSION, {
    commands: { execute: async () => ({ result: { ok: false, error: failure } }) },
  })

  await assert.rejects(
    operations.commands.execute({ sessionId: 'session-1', line: '/status', images: [] }),
    error => error === failure,
  )
  await assert.rejects(
    operations.goal.create({ sessionId: 'session-1', objective: 'x' }),
    error => error.code === 'runtime-interface/capability-unavailable',
  )
})

test('command cancellation is passed to the official operation and preserves its reason', async () => {
  const controller = new AbortController()
  let started
  const startedPromise = new Promise(resolve => { started = resolve })
  let calls = 0
  const { operations } = fixture(LEGACY_AGENT_OPERATIONS_VERSION, {
    commands: {
      execute(_agent, _line, _images, signal) {
        calls += 1
        started(signal)
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      },
    },
  })
  const pending = operations.commands.execute({ sessionId: 'session-1', line: '/status', images: [] }, controller.signal)
  const receivedSignal = await startedPromise
  assert.equal(receivedSignal, controller.signal)
  const reason = new Error('caller-cancelled')
  controller.abort(reason)
  await assert.rejects(pending, error => error === reason)
  assert.equal(calls, 1)
})

test('invalid requests, unsupported versions, and unavailable Agent resolution fail explicitly', async () => {
  assert.throws(
    () => createAgentOperations({ upstreamVersion: '0.0.0' }),
    error => error instanceof AgentOperationError && error.code === 'runtime-interface/unsupported-version',
  )

  const { operations } = fixture(LEGACY_AGENT_OPERATIONS_VERSION, {
    sessionController: { resolveAgent: async () => undefined },
    commands: { execute() {} },
  })
  await assert.rejects(
    operations.commands.execute({ sessionId: 'session-1', line: '', images: [] }),
    error => error.code === 'runtime-interface/invalid-request',
  )
  await assert.rejects(
    operations.commands.execute({ sessionId: 'session-1', line: '/status', images: [] }),
    error => error.code === 'runtime-interface/capability-unavailable',
  )
})
