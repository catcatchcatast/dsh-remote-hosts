// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                               
const NAMESPACE = 'subscriptions-compat-rc1'
const FIELDS = ['quickQuotaVisible', 'searchProvider']
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function valueOf(result) {
  if (result?.ok !== true) {
    const error = new Error('Subscription preference migration was rejected')
    error.code = result?.error?.code ?? 'runtime-interface/invalid-result'
    throw error
  }
  return result.value
}

/** Copy only old explicit preferences absent from the new native user layer. */
export async function migrateLegacySubscriptionPreferences({ carrier, legacyValues, signal }) {
  if (!record(legacyValues)) throw new TypeError('Legacy preferences must be an object')
  const values = Object.fromEntries(FIELDS.filter(field => Object.hasOwn(legacyValues, field)).map(field => [field, legacyValues[field]]))
  if (Object.hasOwn(values, 'quickQuotaVisible') && typeof values.quickQuotaVisible !== 'boolean') throw new TypeError('Invalid legacy quota visibility')
  if (Object.hasOwn(values, 'searchProvider') && !['auto', 'dsh', 'codex'].includes(values.searchProvider)) throw new TypeError('Invalid legacy search selection')
  signal?.throwIfAborted()
  const description = valueOf(await carrier.call('settings/describe', { args: {} }, signal))
  const namespace = description?.namespaces?.find(row => row.ns === NAMESPACE)
  if (!namespace || !record(namespace.user) || !Number.isSafeInteger(namespace.revision)) throw new Error('Subscription native preferences are unavailable')
  const copiedFields = Object.keys(values).filter(field => !Object.hasOwn(namespace.user, field))
  if (copiedFields.length) {
    signal?.throwIfAborted()
    valueOf(await carrier.call('settings/update', { args: {
      ns: NAMESPACE,
      patch: Object.fromEntries(copiedFields.map(field => [field, values[field]])),
      expectedRevision: namespace.revision,
    } }, signal))
  }
  return Object.freeze({ copiedFields: Object.freeze(copiedFields), preservedFields: Object.freeze(Object.keys(values).filter(field => !copiedFields.includes(field))) })
}
