// Public change history: docs/PUBLIC-CHANGES.md
import { build } from 'tsdown'
import client from './tsdown.config.mjs'

await build({ ...client, config: false })
