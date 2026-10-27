// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                                     
                                                                                                                                               
import { build } from 'tsdown'
import client from './tsdown.config.mjs'

await build({ ...client, config: false })
