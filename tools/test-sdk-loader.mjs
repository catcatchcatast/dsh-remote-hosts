// Public change history: docs/PUBLIC-CHANGES.md
import fs from 'node:fs'
import path from 'node:path'
import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'

const official = process.env.DSH_OFFICIAL_021_ROOT
if (!official) throw new Error('Set DSH_OFFICIAL_021_ROOT to the official DSH installation root.')
const sdk = createRequire(path.join(official, 'node_modules/@deepseek-ai/dsh/package.json'))
const source = fileURLToPath(new URL('../packages/runtime-interface/', import.meta.url))
const manifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'))
let resolving = false
registerHooks({
  resolve(specifier, context, next) {
    if (resolving) return next(specifier, context)
    if (specifier === 'dsh-runtime-interface' || specifier.startsWith('dsh-runtime-interface/')) {
      const key = specifier === 'dsh-runtime-interface' ? '.' : './' + specifier.slice('dsh-runtime-interface/'.length)
      return next(pathToFileURL(path.join(source, manifest.exports[key])).href, context)
    }
    if (specifier.startsWith('@deepseek-ai/') || specifier === 'zod' || specifier === 'ws') {
      resolving = true
      let target
      try { target = sdk.resolve(specifier) } finally { resolving = false }
      if (specifier === 'ws' && !context.conditions?.includes('require')) target = target.replace(/index\.js$/, 'wrapper.mjs')
      return next(context.conditions?.includes('require') ? target : pathToFileURL(target).href, context)
    }
    return next(specifier, context)
  },
})
