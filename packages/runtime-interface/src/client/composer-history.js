// Public change history: docs/PUBLIC-CHANGES.md
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const empty = Object.freeze([])
const nodesCache = new WeakMap(), sourcesCache = new WeakMap()
const invalid = () => new TypeError('composer history source is invalid')

export function composerHistorySessionId(list) {
  const snapshot = list.getSnapshot()
  if (snapshot.current !== undefined) return String(snapshot.current)
  for (const [id, entry] of Object.entries(snapshot.byId ?? {})) if ((entry?.retainedBy?.mainView ?? 0) > 0) return id
  return undefined
}

/** Detach exactly the recall/compaction facts; official Chat render envelopes stay here. */
export function composerHistoryNodes(snapshot) {
  if (snapshot === undefined) return empty
  if (!record(snapshot)) throw invalid()
  const rows = snapshot.nodes === undefined ? snapshot.legacy?.nodes : snapshot.nodes.values()
  if (rows === undefined) return empty
  if (!Array.isArray(rows)) throw invalid()
  const cached = nodesCache.get(rows)
  if (cached) return cached
  const result = []
  for (const row of rows) {
    if (!record(row) || !['user', 'steering', 'compaction'].includes(row.kind)) continue
    const node = row.target === 'chat' ? row.data : row
    if (!record(node) || node.kind !== row.kind || !Number.isInteger(node.seq) || node.seq < 0) continue
    if (row.kind === 'compaction') {
      if (node.summary !== null && typeof node.summary !== 'string') continue
      const count = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
      result.push(Object.freeze({ kind: row.kind, seq: node.seq, summary: node.summary,
        shadowedItemCount: count(node.shadowedItemCount), shadowedTokenCount: count(node.shadowedTokenCount) }))
    } else {
      if (!Array.isArray(node.content)) continue
      const content = node.content.filter(block => record(block) && block.type === 'text' && typeof block.text === 'string').map(block => {
        return Object.freeze({ type: 'text', text: block.text })
      })
      result.push(Object.freeze({ kind: row.kind, seq: node.seq, content: Object.freeze(content) }))
    }
  }
  result.sort((a, b) => a.seq - b.seq)
  const value = Object.freeze(result)
  nodesCache.set(rows, value)
  return value
}

/** Own native binding, target activation and subscription; return a stable history port. */
export function composerHistorySource(uiConversation, id) {
  if (uiConversation === undefined) return undefined
  if (typeof id !== 'string' || !id || id.includes('\0')) throw invalid()
  let source
  try { source = uiConversation.binding(id).target('chat') } catch { return undefined }
  if (!record(source) || typeof source.getSnapshot !== 'function' || typeof source.subscribe !== 'function') throw invalid()
  const cached = sourcesCache.get(source)
  if (cached) return cached
  const port = Object.freeze({ getSnapshot: () => composerHistoryNodes(source.getSnapshot()), subscribe: listener => source.subscribe(listener) })
  sourcesCache.set(source, port)
  return port
}
