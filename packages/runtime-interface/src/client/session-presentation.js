// Public change history: docs/PUBLIC-CHANGES.md
/** Stateless presentation of the SAME public root source consumed by project rows. */
export function createSessionPresentationClient({ uiSession, sessions, locale }) {
  const t = locale.bind('workspace')
  const pending = {
    approval: ['status.waitingApproval', 'status.compact.approval'],
    'plan-review': ['status.planReview', 'status.compact.planReview'],
    question: ['status.waitingAnswer', 'status.compact.answer'],
  }
  return Object.freeze({
    get(id) {
      const list = sessions.list.getSnapshot(), row = list.byId[id]
      if (!row) return undefined
      const statuses = uiSession.sessionStatus.getSnapshot(), status = statuses.get(id)
      const kind = status?.pendingInteraction?.kind
      const waiting = Object.hasOwn(pending, kind) ? pending[kind] : undefined
      const children = list.projectionsBySession?.[id]?.values.subagentCatalog ?? []
      const count = children.filter(child => (statuses.get(child.id)?.running ?? list.byId[child.id]?.running) === true).length
      const childLabel = count ? t(count === 1 ? 'status.subagentsRunning.one' : 'status.subagentsRunning.other', { n: count }) : undefined
      // Unknown pending kinds and tool failures are not terminal session states.
      if (waiting) return Object.freeze({ state: 'warning', label: t(waiting[0]), trailingLabel: t(waiting[1]), childLabel })
      if (status?.running ?? row.running) return Object.freeze({ state: 'ongoing', label: t('status.running'), childLabel })
      if (count) return Object.freeze({ state: 'ongoing', label: childLabel })
      if (status?.completionUnread === true) return Object.freeze({ state: 'done', label: t('status.completed') })
      return Object.freeze({ state: 'idle', label: t('status.idle') })
    },
    subscribe(listener) { return uiSession.sessionStatus.subscribe(listener) },
  })
}
