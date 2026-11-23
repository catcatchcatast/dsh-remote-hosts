// Public change history: docs/PUBLIC-CHANGES.md
import { installSessionShareAgentPreset } from './session-share-interface.js'

export const name = 'dsh-runtime-interface/session-share-agent'
export const inject = ['sessionShareInterface', 'tools', 'attachments']
export async function apply(ctx) { await installSessionShareAgentPreset(ctx) }
export default { name, inject, apply }
