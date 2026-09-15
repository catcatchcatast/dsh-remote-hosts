
/** The durable catalog says a child was registered, not that its turn finished. */
export function mobileSubagentEvent(event) {
  if (event?.type !== 'subagent/catalog') return event
  const data = event.data
  const id = data?.childId
  if (data?.version !== 0 || typeof id !== 'string' || id.length === 0 || id.length > 512 || id.includes('\0')) {
    // A malformed registration cannot become a link to its parent or another child.
    return Object.freeze({ ...event, type: 'subagent/update', data: Object.freeze({ status: 'unavailable' }) })
  }
  const label = typeof data.label === 'string' && data.label.trim() ? data.label.slice(0, 512) : 'sub-agent'
  return Object.freeze({ ...event, type: 'subagent/update', data: Object.freeze({
    agentId: id, childSessionId: id, name: label, status: 'created',
  }) })
}
