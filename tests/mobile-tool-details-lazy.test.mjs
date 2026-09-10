import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MobileSessionSyncState,
  convertMobileHistoryEntry,
  convertMobileMuxFrame,
  readMobileV3Details,
  readMobileV3History,
  readMobileV3Delta,
} from '../packages/mobile-stream-compat-rc1/src/index.js'

const entry = (seq, type, data) => ({ event: { seq, time: seq, type, data } })
const argumentsText = JSON.stringify({ command: 'PRIVATE_COMMAND_SENTINEL', password: 'secret' })
const resultText = 'PRIVATE_RESULT_SENTINEL'.repeat(1800)

async function textFor(state, ref, sessionId = 's') {
  let text = '', offset = 0
  do {
    const reply = await readMobileV3Details(state, { sessionId, ...ref, offset }, { maxDetailChunkBytes: 4096 })
    assert.equal(reply.ok, true)
    text += reply.value.text
    if (reply.value.done) return text
    assert.ok(reply.value.nextOffset > offset)
    offset = reply.value.nextOffset
  } while (offset < 1024 * 1024)
  assert.fail('detail page cursor did not terminate')
}

test('evicted detail reload passes the request AbortSignal to rc1 page', async () => {
  const record = entry(299, 'tool/result', { callId: 'c', message: { content: [
    { type: 'tool-result', toolCallId: 'c', content: [{ type: 'text', text: resultText }] },
  ] } })
  const calls = []
  const controller = {
    async *follow(_request, signal) {
      assert.ok(signal instanceof AbortSignal)
      yield { type: 'snapshot', header: { id: 's' }, cursor: 299, records: [
        { type: 'event', event: record.event },
      ], hasMore: false, projections: { asOfSeq: 299, values: {} } }
    },
    page(request, signal) {
      calls.push([request, signal])
      assert.ok(signal instanceof AbortSignal)
      return { records: [{ type: 'event', event: record.event }], hasMore: false }
    },
  }
  const state = new MobileSessionSyncState()
  const requestController = new AbortController()
  try {
    const history = await readMobileV3History(controller, { sessionId: 's' }, state, { maxDetailChunkBytes: 4096 }, requestController.signal)
    const ref = history.value.events[0].body.detailRef
    assert.deepEqual(ref, { seq: 299, version: 1, field: 'tool.result' })
    state.details.clear()
    const details = await readMobileV3Details(state, { sessionId: 's', ...ref, offset: 0 }, { maxDetailChunkBytes: 4096 }, requestController.signal)
    assert.equal(details.ok, true)
    assert.match(details.value.text, /PRIVATE_RESULT_SENTINEL/)
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0][0], {
      address: { kind: 'session', sessionId: 's' },
      throughSeq: 299,
      beforeSeq: 300,
      maxMessages: 24,
    })
    assert.equal(calls[0][1], requestController.signal)
  } finally { state.dispose() }
})

test('aborting an evicted detail reload propagates instead of returning detail unavailable', async () => {
  const record = entry(300, 'tool/result', { callId: 'c', message: { content: [
    { type: 'tool-result', toolCallId: 'c', content: [{ type: 'text', text: resultText }] },
  ] } })
  const controller = {
    async *follow(_request, signal) {
      yield { type: 'snapshot', header: { id: 's' }, cursor: 300, records: [
        { type: 'event', event: record.event },
      ], hasMore: false, projections: { asOfSeq: 300, values: {} } }
    },
    page(_request, signal) {
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    },
  }
  const state = new MobileSessionSyncState()
  const requestController = new AbortController()
  try {
    const history = await readMobileV3History(controller, { sessionId: 's' }, state, { maxDetailChunkBytes: 4096 }, requestController.signal)
    const ref = history.value.events[0].body.detailRef
    state.details.clear()
    const pending = readMobileV3Details(state, { sessionId: 's', ...ref, offset: 0 }, { maxDetailChunkBytes: 4096 }, requestController.signal)
    requestController.abort(new DOMException('request aborted', 'AbortError'))
    await assert.rejects(pending, error => error?.name === 'AbortError')
  } finally { state.dispose() }
})

test('small and large tool arguments are referenced without inline text or preview', async () => {
  const state = new MobileSessionSyncState()
  try {
    for (const [index, args] of [argumentsText, JSON.stringify({ command: 'PRIVATE_COMMAND_SENTINEL'.repeat(2000) })].entries()) {
      const output = convertMobileHistoryEntry(entry(index, 'assistant/chunk', {
        chunk: { type: 'tool-call-delta', index: 0, id: 'c', name: 'Bash', argumentsDelta: args },
      }), 's', state)
      const detail = output.body.chunk.argumentsDelta
      assert.ok(detail.detailRef)
      assert.equal(detail.text, undefined)
      assert.equal(detail.preview, undefined)
      assert.doesNotMatch(JSON.stringify(output), /PRIVATE_COMMAND_SENTINEL|secret/)
      assert.match(await textFor(state, detail.detailRef), /PRIVATE_COMMAND_SENTINEL/)
      assert.doesNotMatch(await textFor(state, detail.detailRef), /secret/)
    }
  } finally { state.dispose() }
})

test('embedded tool calls and results stay lazy while ordinary text remains readable', async () => {
  const state = new MobileSessionSyncState()
  try {
    const output = convertMobileHistoryEntry(entry(10, 'assistant/message', { message: { role: 'assistant', content: [
      { type: 'text', text: 'visible answer' },
      { type: 'tool-call', id: 'c', name: 'Bash', arguments: argumentsText },
      { type: 'tool-result', toolCallId: 'c', content: [{ type: 'text', text: resultText }] },
    ] } }), 's', state)
    const content = output.body.message.content
    assert.equal(content[0].text, 'visible answer')
    assert.ok(content[1].arguments.detailRef)
    assert.ok(content[2].detailRef)
    assert.doesNotMatch(JSON.stringify(output), /PRIVATE_COMMAND_SENTINEL|PRIVATE_RESULT_SENTINEL/)
    assert.match(await textFor(state, content[1].arguments.detailRef), /PRIVATE_COMMAND_SENTINEL/)
    assert.equal(JSON.parse(await textFor(state, content[2].detailRef)).content[0].text, resultText)
  } finally { state.dispose() }
})

test('clicked canonical result contains complete output instead of a second unresolvable reference', async () => {
  const state = new MobileSessionSyncState()
  try {
    const output = convertMobileHistoryEntry(entry(20, 'tool/result', { callId: 'c', message: { content: [
      { type: 'tool-result', toolCallId: 'c', content: [{ type: 'text', text: resultText }] },
    ] } }), 's', state)
    assert.doesNotMatch(JSON.stringify(output), /PRIVATE_RESULT_SENTINEL/)
    const details = JSON.parse(await textFor(state, output.body.detailRef))
    assert.equal(details.content[0].content[0].text, resultText)
    assert.doesNotMatch(JSON.stringify(details), /detailRef/)
  } finally { state.dispose() }
})

test('history and delta use the same lazy tool representation and references survive eviction', async () => {
  const record = entry(1, 'assistant/chunk', { chunk: {
    type: 'tool-call-delta', index: 0, id: 'c', name: 'Bash', argumentsDelta: argumentsText,
  } })
  const controller = {
    async *follow() { yield { type: 'snapshot', header: { id: 's' }, cursor: 1, records: [
      { type: 'event', event: record.event },
    ], hasMore: false, projections: { asOfSeq: 1, values: {} } } },
    page() { return { records: [{ type: 'event', event: record.event }], hasMore: false } },
  }
  const state = new MobileSessionSyncState()
  try {
    const history = await readMobileV3History(controller, { sessionId: 's' }, state)
    const delta = await readMobileV3Delta(controller, { sessionId: 's', afterSeq: 0 }, state)
    assert.equal(history.ok, true)
    assert.equal(delta.ok, true)
    assert.deepEqual(history.value.events[0].body, delta.value.events[0].body)
    const live = convertMobileMuxFrame({ type: 'session/event', sessionId: 's', event: record.event }, state)
    assert.deepEqual(history.value.events[0].body, live.body)
    const ref = history.value.events[0].body.chunk.argumentsDelta.detailRef
    assert.ok(ref)
    state.details.clear()
    assert.match(await textFor(state, ref), /PRIVATE_COMMAND_SENTINEL/)
  } finally { state.dispose() }
})
