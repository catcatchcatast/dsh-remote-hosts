// Public change history: docs/PUBLIC-CHANGES.md

// This is the shared Cosmokit protocol, including independently bundled copies.
const volatileWrite = Symbol.for('cosmokit.volatile.write')
const defaults = Object.freeze({
  recallWithDraft: 'save', restoreOnEscape: true, edgeMode: 'logical', enableCtrlAlias: true,
  restoreCaret: true, upKey: 'ArrowUp', downKey: 'ArrowDown', escapeKey: 'Escape',
  maxHistory: 500, includeKinds: ['user'], historyScope: 'session', persistHistory: true,
  maxPersisted: 200, enableSearch: true, searchKeys: ['Ctrl+R'], searchCaseSensitive: false,
  includeCompactionSummaries: true, showCompactionNotice: true, compactCommandText: '/compact',
  enableSnippets: true, maxSnippets: 200, enableTemplates: true, enableInsights: true,
  insightMinUses: 2, enableCompactionHighlight: true,
})
const enums = { recallWithDraft: ['save', 'gate'], edgeMode: ['logical', 'visual'], historyScope: ['session', 'workspace'] }
const failure = () => new TypeError('composer history configuration is invalid')

/** Decode only this plugin's published config, never exposing live references. */
export function resolveComposerHistoryBootConfig(input = {}) {
  if (input === null) input = {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure()
  const output = {}
  try {
    for (const [key, fallback] of Object.entries(defaults)) {
      let value = input[key]
      if (value && typeof value === 'object' && volatileWrite in value) {
        if (typeof value.get !== 'function') throw failure()
        value = value.get()
      }
      if (value === undefined || value === null) value = fallback
      if (enums[key]) {
        if (!enums[key].includes(value)) throw failure()
      } else if (Array.isArray(fallback)) {
        if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw failure()
        value = Object.freeze([...value])
      } else if (typeof value !== typeof fallback) throw failure()
      else if (typeof fallback === 'number' && (!Number.isInteger(value) || value < (key === 'insightMinUses' ? 1 : 0))) throw failure()
      output[key] = value
    }
  } catch { throw failure() }
  return Object.freeze(output)
}
