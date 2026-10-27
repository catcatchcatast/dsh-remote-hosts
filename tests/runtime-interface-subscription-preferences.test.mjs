// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                               
import assert from 'node:assert/strict'
import test from 'node:test'
import { migrateLegacySubscriptionPreferences } from '../packages/runtime-interface/src/subscription-preferences.js'

test('legacy migration preserves explicit new preferences and is idempotent', async () => {
  let revision = 7
  const user = { quickQuotaVisible: false }
  const writes = []
  const carrier = { async call(endpoint, payload) {
    if (endpoint === 'settings/describe') return { ok: true, value: { namespaces: [{ ns: 'subscriptions-compat-rc1', revision, user: { ...user } }] } }
    assert.equal(endpoint, 'settings/update')
    assert.equal(payload.args.ns, 'subscriptions-compat-rc1')
    assert.equal(payload.args.expectedRevision, revision)
    writes.push(payload.args.patch)
    Object.assign(user, payload.args.patch); revision++
    return { ok: true, value: {} }
  } }
  const options = { carrier, legacyValues: { quickQuotaVisible: true, searchProvider: 'codex', unrelatedSecret: 'never-copied' } }
  assert.deepEqual(await migrateLegacySubscriptionPreferences(options), { copiedFields: ['searchProvider'], preservedFields: ['quickQuotaVisible'] })
  assert.deepEqual(user, { quickQuotaVisible: false, searchProvider: 'codex' })
  assert.deepEqual(await migrateLegacySubscriptionPreferences(options), { copiedFields: [], preservedFields: ['quickQuotaVisible', 'searchProvider'] })
  assert.deepEqual(writes, [{ searchProvider: 'codex' }])
})

test('invalid old values and concurrent native changes never overwrite preferences', async () => {
  for (const legacyValues of [[], null, { quickQuotaVisible: 'true' }, { searchProvider: 'other' }]) {
    await assert.rejects(migrateLegacySubscriptionPreferences({ carrier: { call() { assert.fail('invalid source must not call the host') } }, legacyValues }), TypeError)
  }
  let writes = 0
  const carrier = { async call(endpoint, payload) {
    if (endpoint === 'settings/describe') return { ok: true, value: { namespaces: [{ ns: 'subscriptions-compat-rc1', revision: 9, user: {} }] } }
    writes++; assert.equal(payload.args.expectedRevision, 9)
    return { ok: false, error: { code: 'settings/conflict', message: 'private upstream detail' } }
  } }
  await assert.rejects(migrateLegacySubscriptionPreferences({ carrier, legacyValues: { searchProvider: 'auto' } }), error => error.code === 'settings/conflict' && !error.message.includes('private upstream detail'))
  assert.equal(writes, 1)
})
