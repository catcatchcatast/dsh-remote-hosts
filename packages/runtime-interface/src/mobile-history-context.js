// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                                           
const CONTEXT_LABELS = Object.freeze({
  'runtime-context': 'Runtime context',
  'skill-catalog': 'Skill catalog',
  'time-context': 'Time context',
})

/** Project known official context sources as mobile metadata, never human input. */
export function mobileContextHistoryEvent(event) {
  if (event?.type !== 'user/message') return event
  const kind = event.data?.source?.kind
  if (typeof kind !== 'string' || !Object.hasOwn(CONTEXT_LABELS, kind)) return event
  return Object.freeze({
    ...event,
    type: 'system/message',
    data: Object.freeze({
      mobileActivity: 'context',
      summary: CONTEXT_LABELS[kind],
      message: event.data,
    }),
  })
}
