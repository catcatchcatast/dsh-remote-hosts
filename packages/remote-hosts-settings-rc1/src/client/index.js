import { RemoteHostsSection } from './RemoteHostsSection.jsx'
import { en, zh } from './locales.js'

const NS = 'settings.remoteHosts'
export const inject = ['slots', 'remoteHostsInterface', 'locale']

export function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'remote-hosts-settings-rc1: copy')
// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                          
  const original = ctx.get('remoteHostsInterface'), labels = ctx.get('remoteWorkspaceHostLabels')
  const hostsApi = labels ? labels.managementClient(original) : original
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'remote-hosts',
    order: 80,
    label: () => t('nav'),
    locale: NS,
    inject: () => ({ hostsApi, t }),
  }, RemoteHostsSection))
}
                                                                                                                                     
