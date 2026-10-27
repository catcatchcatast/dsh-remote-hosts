// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                    
                                                                               
                                                                                                                                                     
// 官方原生工作区仍负责列表、状态和菜单；这里只装远程设置及已授权展示适配。
                                                                       
import { installInputRecall } from './input-recall.js'
import * as settings from '../../remote-hosts-settings-rc1/src/client/index.js'
                                                                                               
import { installWorkspaceHostLabels } from './workspace-host-labels.js'
import { createWorkspaceHostLabels } from '../../runtime-interface/src/client/workspace-host-labels.js'

import { installWorkspacePathMenus } from '../../runtime-interface/src/client/workspace-path-menu.js'

export const inject = []
export function apply(ctx) {
  ctx.inject(['slots', 'locale', 'sessions', 'workspaces'], scope => { installWorkspacePathMenus(scope) })
  ctx.inject(['slots'], scope => { scope.effect(() => installInputRecall(scope), 'remote-hosts: current-session input recall') })
  const labels = createWorkspaceHostLabels(globalThis.__DSH_BROWSER_HOST_HUB__?.getHosts?.() ?? [])
  ctx.provide('remoteWorkspaceHostLabels', labels)
  ctx.inject(['workspaces', 'sessions'], scope => { scope.effect(() => labels.watchInventory(scope.get('workspaces').list, { sessions: scope.get('sessions').list }), 'remote-hosts: visible workspace Host inventory') })
  ctx.inject(settings.inject, scope => { scope.plugin(settings) })
  ctx.inject(['slots', 'locale'], scope => { installWorkspaceHostLabels(scope, labels) })
}
