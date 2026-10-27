// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                                           
                                                                             
import * as files from '../lib/modules/file-upload-compat-rc1/mobile.js'
import * as bootstrap from '../lib/modules/mobile-bootstrap-rc1/index.js'
import * as interactions from '../lib/modules/mobile-interactions-compat-rc1/index.js'
import * as controller from '../lib/modules/mobile-controller-compat-rc1/index.js'
import * as sync from '../lib/modules/mobile-session-sync-rc1/index.js'
import * as stream from '../lib/modules/mobile-stream-compat-rc1/index.js'
import * as carriers from '../lib/modules/rc1-host-carriers/index.js'
import * as hub from '../lib/modules/browser-host-hub-rc1/index.js'
import * as settings from '../lib/modules/remote-hosts-settings-rc1/index.js'

export const name = 'remote-hosts'
export const modules = Object.freeze({ bootstrap, interactions, controller, sync, stream, carriers, hub, settings, files })
export function apply(ctx, config = {}) {
  for (const [key, plugin] of Object.entries(modules)) {
    const options = config.modules?.[plugin.name]
    if (options === false) continue
    ctx.plugin(plugin, options ?? {})
  }
}
