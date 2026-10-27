// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                               
export const name = 'fork-inbox-guard'
export const inject = ['runtimeInterface']

/** A new branch must not execute pending input inherited from its parent. */
export function apply(ctx) {
  return ctx.effect(() => ctx.runtimeInterface.forkInboxIsolation.install(({ inheritedMessageIds }) => [...inheritedMessageIds]), 'fork-inbox-guard: inherited input isolation')
}
