import test from 'node:test'
import assert from 'node:assert/strict'
import { dispatchSubagent, MOBILE_SUBAGENT_COMPAT_METHODS } from '../packages/mobile-controller-compat-rc1/src/subagents.js'


function event(seq, text = `event-${seq}`) {
  return {
    type: 'event',
    event: { type: 'message/user', seq, time: seq + 100, data: { text } },
  }
}

test('subagent list calls official remoteExportList and preserves the catalog contract', async () => {
  const signal = new AbortController().signal
  const calls = []
  const value = await dispatchSubagent({
    subagents: {
      remoteExportList(parent, receivedSignal) {
        calls.push([parent, receivedSignal])
        return { entries: [{
          kind: 'child', id: 'child-1', activity: 'running', hasChildren: false,
          mode: 'continuable', label: 'review',
        }], parentAvailable: true }
      },
    },
  }, 'subagent.list', { parentSessionId: 'parent-1' }, signal, 'rpc-1')

  assert.equal(calls[0][0], 'parent-1')
  assert.equal(calls[0][1], signal)
  assert.deepEqual(value.entries[0], {
    kind: 'child', id: 'child-1', activity: 'running', hasChildren: false,
    mode: 'continuable', label: 'review',
  })
  assert.equal(value.parentAvailable, true)
})

test('subagent history uses one child address and the follow cursor for paging, then closes it', async () => {
  const calls = []
  let returned = false
  const iterator = {
    [Symbol.asyncIterator]() { return this },
    async next() {
      if (returned) return { done: true }
      returned = true
      return {
        done: false,
        value: { type: 'snapshot', cursor: 12, records: [event(10)], hasMore: true,
          projections: { values: { title: 'child' } } },
      }
    },
    async return() { calls.push(['return']); return { done: true } },
  }
  const value = await dispatchSubagent({
    mobileHistoryMapper(records, options) {
      calls.push(['map', records, options])
      return records.map(record => ({ event: record.event, view: 'mapped' }))
    },
    session: {
      follow(request, signal) {
        calls.push(['follow', request, signal])
        return iterator
      },
      page(request, signal) {
        calls.push(['page', request, signal])
        return { records: [event(3)], hasMore: false }
      },
    },
  }, 'subagent.history', {
    parentSessionId: 'parent-1', childSessionId: 'child-1', mode: 'continuable', beforeSeq: 10, maxMessages: 8,
  }, undefined, 'rpc-1')

  const follow = calls.find(call => call[0] === 'follow')
  const page = calls.find(call => call[0] === 'page')
  assert.deepEqual(follow[1], {
    address: { kind: 'subagent', parentSessionId: 'parent-1', childSessionId: 'child-1', mode: 'continuable' },
    maxMessages: 8,
  })
  assert.deepEqual(page[1], {
    address: follow[1].address,
    throughSeq: 12,
    beforeSeq: 10,
    maxMessages: 8,
  })
  assert.equal(page[2], undefined)
  assert.deepEqual(calls.find(call => call[0] === 'map')[2], { throughSeq: 12, beforeSeq: 10 })
  assert.deepEqual(value.events, [{ event: event(3).event, view: 'mapped' }])
  assert.deepEqual(value.projections, { values: { title: 'child' } })
  assert.equal(value.hasMore, false)
  assert.deepEqual(calls.at(-1), ['return'])
})

test('subagent history preserves a one-shot address for follow and page', async () => {
  const calls = []
  const source = (async function * follow() {
    yield { type: 'snapshot', cursor: 4, records: [event(3)], hasMore: false }
  })()
  const value = await dispatchSubagent({
    mobileHistoryMapper: records => records.map(record => record.event),
    session: {
      follow(request) { calls.push(['follow', request]); return source },
      page(request) { calls.push(['page', request]); return { records: [], hasMore: false } },
    },
  }, 'subagent.history', {
    parentSessionId: 'parent-1', childSessionId: 'oneshot-1', mode: 'one-shot', beforeSeq: 2,
  })
  assert.deepEqual(calls.map(([kind, request]) => [kind, request.address]), [
    ['follow', { kind: 'subagent', parentSessionId: 'parent-1', childSessionId: 'oneshot-1', mode: 'one-shot' }],
    ['page', { kind: 'subagent', parentSessionId: 'parent-1', childSessionId: 'oneshot-1', mode: 'one-shot' }],
  ])
  assert.deepEqual(value.events, [])
})

test('subagent prompt preserves the envelope rpcId and only admits continuable mode', async () => {
  const calls = []
  const value = await dispatchSubagent({
    subagents: {
      prompt(request, signal) {
        calls.push([request, signal])
        return { messageId: 'message-1' }
      },
    },
  }, 'subagent.prompt', {
    parentSessionId: 'parent-1', childSessionId: 'child-1', mode: 'continuable',
    content: [{ type: 'text', text: 'continue' }], clientTimeZone: 'UTC',
  }, undefined, 'envelope-rpc-9')

  assert.deepEqual(calls[0][0], {
    requestId: 'envelope-rpc-9', parentSessionId: 'parent-1', childSessionId: 'child-1',
    mode: 'continuable', content: [{ type: 'text', text: 'continue' }], clientTimeZone: 'UTC',
  })
  assert.equal(value.messageId, 'message-1')
  await assert.rejects(
    dispatchSubagent({ subagents: { prompt() {} } }, 'subagent.prompt', {
      parentSessionId: 'parent-1', childSessionId: 'child-1', mode: 'queue', content: [],
    }, undefined, 'rpc-1'),
    error => error.code === 'gateway/bad-request',
  )
})

test('subagent interrupt routes exact durable parent and child identity', async () => {
  const calls = []
  const value = await dispatchSubagent({
    subagents: {
      interruptByParent(...args) { calls.push(args); return { accepted: true } },
    },
  }, 'subagent.interrupt', {
    parentSessionId: 'parent-1', childSessionId: 'child-1', mode: 'continuable',
  }, undefined, 'rpc-1')
  assert.deepEqual(calls, [['child-1', 'parent-1', 'continuable']])
  assert.deepEqual(value, { accepted: true })
  await assert.rejects(
    dispatchSubagent({ subagents: { interruptByParent() {} } }, 'subagent.interrupt', {
      parentSessionId: 'parent-1', childSessionId: 'child-1', mode: 'one-shot',
    }),
    error => error.code === 'gateway/bad-request',
  )
})

test('subagent identity rejects hub composite ids instead of falling back locally', async () => {
  await assert.rejects(
    dispatchSubagent({ subagents: { remoteExportList() {} } }, 'subagent.list', {
      parentSessionId: 'rh1.ubuntu.parent-1',
    }),
    error => error.code === 'gateway/bad-request',
  )
})

test('subagent history requires an injected shared mapper', async () => {
  await assert.rejects(
    dispatchSubagent({ sessionController: { follow() {}, page() {} } }, 'subagent.history', {
      parentSessionId: 'parent-1', childSessionId: 'child-1', mode: 'continuable',
    }),
    error => error.code === 'gateway/capability-unavailable',
  )
})

assert.deepEqual(MOBILE_SUBAGENT_COMPAT_METHODS, [
  'subagent.list', 'subagent.history', 'subagent.prompt', 'subagent.interrupt',
])
