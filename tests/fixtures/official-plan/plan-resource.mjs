/** Read immutable plan arguments from a Session history page and earlier pages. */


import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'

import { parsePlanAddress, submittedPlan,                    } from './plan.mjs'



















/**
 * Bind plan reads to the generated Session Remote face.
 * A plan is a logged tool-call argument, so the provider reads one page at the current log
 * end and pages backwards from its cut. It neither activates nor subscribes.
 * Remote failures are reported as resource failure frames with their original codes.
 * @param remote - Existing Session history API.
 * @returns a provider whose reads stop after finding the exact invocation.
 */
export function planResourceProvider(remote                                                       )                           {
  return {
    protocol: 'plan',
    async *open(address, { signal })                                             {
      const aborted = ()          => signal.aborted
      if (aborted()) return
      const target = parsePlanAddress(address)
      if (target === undefined) {
        yield { ok: false, error: new RemoteError('plan/invalid-address', 'Invalid plan resource address.', {}) }
        return
      }
      const sessionAddress = target.session
      try {
        // One page fixes the cut the later pages page back from.
        const first = await remote.events({ address: sessionAddress }, signal)
        if (aborted()) return
        if (!first.ok) { yield { ok: false, error: first.error }; return }
        const throughSeq = first.value.cursor
        let page = { records: first.value.records, hasMore: first.value.hasMore }
        while (true) {
          for (const entry of page.records) {
            const plan = submittedPlan(entry.event)
            if (plan?.callId === target.callId) {
              yield { ok: true, value: plan }
              return
            }
          }
          const beforeSeq = page.records[0]?.event.seq
          if (!page.hasMore || beforeSeq === undefined) break
          const next = await remote.page({ address: sessionAddress, throughSeq, beforeSeq }, signal)
          if (aborted()) return
          if (!next.ok) { yield next; return }
          page = next.value
        }
        yield { ok: false, error: new RemoteError('plan/not-found', 'The submitted plan was not found in this Session.', {}) }
      } catch (error) {
        if (!aborted()) yield {
          ok: false,
          error: remoteErrorOf(error) ?? new RemoteError('plan/read-failed', error instanceof Error ? error.message : String(error), {}),
        }
      }
    },
  }
}
