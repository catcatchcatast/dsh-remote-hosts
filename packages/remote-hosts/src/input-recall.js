// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                             
import { createElement, useLayoutEffect, useRef } from 'react'
import { DraftRecall, extractHistory, hasActiveTriggerToken, upAtLogicalEdge, downAtLogicalEdge } from './third_party/composer-history/recall.ts'

const bindings = new WeakMap()
const options = { recallWithDraft: 'save', restoreOnEscape: true, edgeMode: 'logical', enableCtrlAlias: false, restoreCaret: false }

/** 只投影已发布的当前Chat人类消息，不拉历史、不保留另一个索引。 */
function historyOf(chat) {
  if (!chat?.nodes?.values) return []
  const nodes = [...chat.nodes.values()].filter(node => ['user', 'steering'].includes(node.kind) && node.data?.source?.kind === 'user')
  nodes.sort((a, b) => a.data.seq - b.data.seq)
  return extractHistory(nodes.map(node => ({ kind: 'user', texts: node.data.content.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text) })))
}

/** 只读原输入的纯文字逻辑位置；Range不是浏览器Selection，生产不写光标。 */
function caretOf(editor, draft) {
  if (draft === '') return { caret: 0, hasSelection: false }
  const selection = editor.ownerDocument.getSelection()
  if (!selection || !editor.contains(selection.anchorNode) || !editor.contains(selection.focusNode)) return { caret: 0, hasSelection: true }
  const range = editor.ownerDocument.createRange()
  range.selectNodeContents(editor)
  range.setEnd(selection.anchorNode, selection.anchorOffset)
  const text = node => {
    if (node.nodeType === 3) return node.data
    if (node.nodeName === 'BR') return '\n'
    // 原编辑器空段落中的单个br是占位；段落间换行由外层join统一计算。
    if (node.nodeName === 'P' && node.childNodes.length === 1 && node.firstChild.nodeName === 'BR') return ''
    return [...node.childNodes].map(text).join('')
  }
  const prefix = [...range.cloneContents().childNodes].map(text).join('\n')
  return { caret: Math.min(prefix.length, draft.length), hasSelection: !selection.isCollapsed }
}

/** 一个原输入卡片只保一个绑定；旧disposer不得撤掉后来的所有者。 */
export function bindInputRecall(card, read) {
  bindings.get(card)?.()
  const recall = new DraftRecall(options)
  let active = true, scope, actions, composing = false, compositionUntil = 0, lastWrite
  const reset = () => { recall.reset(); lastWrite = undefined }
  const input = () => { reset() }
  const start = () => { composing = true }
  const end = () => { composing = false; compositionUntil = Date.now() + 10 }
  const keydown = event => {
    if (!active || event.defaultPrevented || !['ArrowUp', 'ArrowDown', 'Escape'].includes(event.key)) return
    const editor = event.target?.closest?.('[data-composer-input][contenteditable="true"]')
    if (!editor || !card.contains(editor) || event.target.closest('[data-composer-overlay]')) return
    const frame = read()
    if (!frame?.input || !frame.actions || frame.sessionId === undefined) return
    if (scope !== frame.sessionId || actions !== frame.actions) { reset(); scope = frame.sessionId; actions = frame.actions }
    const state = frame.input
    if (state.attachmentIds.length || state.occurrences.length || state.phase !== 'plain') { reset(); return }
    // useSyncExternalStore尚未提交的同栈连续按键，只承认本次同步setter自己的前态。
    const pending = lastWrite && state.draft === lastWrite.before && state.draftRev === lastWrite.rev
    const draft = pending ? lastWrite.text : state.draft
    recall.noteDraftChange(draft)
    if (lastWrite && !pending && state.draft !== lastWrite.text) lastWrite = undefined
    const { caret, hasSelection } = caretOf(editor, draft)
    const key = event.key === 'ArrowUp' ? 'up' : event.key === 'ArrowDown' ? 'down' : 'escape'
    const effect = recall[key]({
      key, ctrlKey: event.ctrlKey, altKey: event.altKey, metaKey: event.metaKey, shiftKey: event.shiftKey,
      isComposing: composing || Date.now() < compositionUntil || event.isComposing || event.keyCode === 229 || editor.hasAttribute('data-composer-composing'),
      hasSelection, phase: state.phase, menuOpen: hasActiveTriggerToken(draft, caret),
      draft, caret, history: historyOf(frame.chat),
      upEdge: upAtLogicalEdge(draft, caret), downEdge: downAtLogicalEdge(draft, caret),
    })
    if (effect.kind === 'pass') return
    event.preventDefault()
    if (effect.kind === 'fill' || effect.kind === 'restore') {
      lastWrite = { before: state.draft, rev: state.draftRev, text: effect.text }
      frame.actions.setDraft(effect.text)
    }
  }
  card.addEventListener('keydown', keydown)
  card.addEventListener('input', input)
  card.addEventListener('compositionstart', start)
  card.addEventListener('compositionend', end)
  const stop = () => {
    if (!active) return
    active = false
    card.removeEventListener('keydown', keydown)
    card.removeEventListener('input', input)
    card.removeEventListener('compositionstart', start)
    card.removeEventListener('compositionend', end)
    reset()
    if (bindings.get(card) === stop) bindings.delete(card)
  }
  bindings.set(card, stop)
  return stop
}

/** 标准session props是唯一数据入口；隐藏锚点只定位原卡片，不替换编辑器。 */
export function InputRecall({ sessionId, useSession, useConversation, useInput, inputActions }) {
  const marker = useRef(null)
  const current = useRef(null)
  const session = useSession(state => state)
  const input = useInput(state => state)
  const chat = useConversation(state => state.views.get('chat'))
  current.current = { sessionId, input, chat, actions: inputActions }
  useLayoutEffect(() => {
    const card = marker.current?.closest('[data-composer-card]')
    if (!card || session.removed) return
    return bindInputRecall(card, () => current.current)
  }, [sessionId, inputActions, session.removed])
  return createElement('span', { hidden: true, ref: marker, 'data-dsh-input-recall': '' })
}

export function installInputRecall(ctx) {
  return ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
    name: 'conversation.input.overlay', id: 'dsh-remote-hosts.input-recall',
  }, InputRecall))
}
