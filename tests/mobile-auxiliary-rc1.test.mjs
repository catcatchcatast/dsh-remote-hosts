/**
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createAgentOperations } from '../packages/runtime-interface/src/agent-operations.js'
import { dispatchAuxiliary, MOBILE_AUXILIARY_COMPAT_METHODS } from '../packages/mobile-controller-compat-rc1/src/auxiliary.js'


function context(calls, overrides = {}) {
  const agent = { id: 'session-1' }
  const sessionController = {
    async resolveAgent(sessionId) {
      calls.push(['resolveAgent', sessionId])
      return { agent }
    },
  }
  return {
    agentOperations: createAgentOperations({
      sessionController,
      commands: overrides.commands,
      goals: overrides.goals,
      agentPresets: overrides.agentPresets,
    }),
    ...overrides,
  }
}

test('commands/execute resolves the exact session and forwards official arguments', async () => {
  const calls = []
  const signal = new AbortController().signal
  const value = await dispatchAuxiliary(context(calls, {
    commands: {
      execute(agent, line, images, receivedSignal) {
        calls.push(['execute', agent, line, images, receivedSignal])
        return { commandId: 'command-1', result: { kind: 'success', text: 'done', sourceEventSeq: 4 } }
      },
    },
  }), 'commands/execute', {
    args: {
      agentId: 'session-1',
      line: '/permission read-only',
      images: [{ mediaType: 'image/png', data: 'encoded', name: 'screen.png' }],
    },
  }, signal)

  assert.equal(value.result.kind, 'success')
  assert.equal(calls[0][0], 'resolveAgent')
  assert.equal(calls[1][0], 'execute')
  assert.equal(calls[1][1].id, 'session-1')
  assert.equal(calls[1][4], signal)
  await assert.rejects(
    dispatchAuxiliary(context([], { commands: { execute() {} } }), 'commands/execute', {
      agentId: 'session-1', line: 'not-a-command', images: [],
    }),
    error => error.code === 'gateway/bad-request',
  )
})

test('goal create uses official remoteExportCreate and preserves its ref', async () => {
  const calls = []
  const value = await dispatchAuxiliary(context(calls, {
    goals: {
      remoteExportCreate(agent, request) {
        calls.push([agent, request])
        return { ref: { id: 'goal-1', revision: 1 } }
      },
    },
  }), 'goal.create', {
    sessionId: 'session-1', objective: 'Ship Android', maxGoalRounds: 12,
  })
  assert.deepEqual(value, { ref: { id: 'goal-1', revision: 1 } })
  const create = calls.find(call => Array.isArray(call) && call[1]?.objective === 'Ship Android')
  assert.equal(create[0].id, 'session-1')
  assert.deepEqual(create[1], { objective: 'Ship Android', maxGoalRounds: 12 })
})

test('goal pause and resume adapt official GoalView to the Android ref shape', async () => {
  const calls = []
  const goals = {
    pause(agent, ref) {
      calls.push(['pause', agent, ref])
      return { id: 'goal-1', revision: 2, phase: 'paused' }
    },
    resume(agent, ref) {
      calls.push(['resume', agent, ref])
      return { id: 'goal-1', revision: 3, phase: 'active' }
    },
  }
  const pause = await dispatchAuxiliary(context(calls, { goals }), 'goal.pause', {
    sessionId: 'session-1', ref: { id: 'goal-1', revision: 1 },
  })
  const resume = await dispatchAuxiliary(context(calls, { goals }), 'goal.resume', {
    sessionId: 'session-1', ref: pause.ref,
  })
  assert.deepEqual(pause, { ref: { id: 'goal-1', revision: 2 } })
  assert.deepEqual(resume, { ref: { id: 'goal-1', revision: 3 } })
  assert.deepEqual(calls.filter(call => call[0] === 'pause')[0][2], { id: 'goal-1', revision: 1 })
  assert.deepEqual(calls.filter(call => call[0] === 'resume')[0][2], { id: 'goal-1', revision: 2 })
})

test('goal clear invokes the official clear method and returns the legacy receipt', async () => {
  const calls = []
  const value = await dispatchAuxiliary(context(calls, {
    goals: {
      clear(agent, ref) { calls.push([agent, ref]); return { id: 'goal-1', revision: 4 } },
    },
  }), 'goal.clear', { sessionId: 'session-1', ref: { id: 'goal-1', revision: 3 } })
  assert.deepEqual(value, { cleared: true })
  assert.deepEqual(calls.find(call => Array.isArray(call) && call[1]?.revision === 3)[1], { id: 'goal-1', revision: 3 })
})

test('unsupported or unavailable services fail explicitly instead of reporting success', async () => {
  await assert.rejects(
    dispatchAuxiliary({ agentOperations: createAgentOperations({ sessionController: { resolveAgent: async () => ({ id: 'session-1' }) } }) }, 'goal.create', {
      sessionId: 'session-1', objective: 'x',
    }),
    error => error.code === 'gateway/capability-unavailable',
  )
  await assert.rejects(
    dispatchAuxiliary({}, 'session.openWorkspacePath', { sessionId: 'session-1', path: '/tmp' }),
    error => error.code === 'gateway/capability-unavailable',
  )
})

test('composite session ids are rejected before resolving an Agent', async () => {
  await assert.rejects(
    dispatchAuxiliary({ agentOperations: createAgentOperations({ sessionController: { resolveAgent() { throw new Error('must not resolve') } }, goals: { clear() {} } }) }, 'goal.clear', {
      sessionId: 'rh1.ubuntu.session-1', ref: { id: 'goal-1', revision: 1 },
    }),
    error => error.code === 'gateway/bad-request',
  )
})

assert.deepEqual(MOBILE_AUXILIARY_COMPAT_METHODS, [
  'commands/execute', 'goal.create', 'goal.pause', 'goal.resume', 'goal.clear',
])
