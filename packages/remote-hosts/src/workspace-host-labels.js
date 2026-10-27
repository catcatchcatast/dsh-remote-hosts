// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                          
                                                                                                   
import { createElement, useSyncExternalStore } from 'react'
import { installWorkspaceRecency } from '../../runtime-interface/src/client/workspace-recency.js'
const NS = 'remote-hosts.workspace-host-labels'

/** CSS字符串和style闭标签均作转义，名称只作为文字，不成为选择器或HTML。 */
function quoted(value) {
  return '"' + String(value).replace(/[\u0000-\u001f\u007f"\\<>]/g, char => '\\' + char.codePointAt(0).toString(16) + ' ') + '"'
}

export function workspaceHostStyles(hosts, selector, unknown, flat = false) {
  const rules = [selector() + '::after{content:' + quoted(unknown) + ';order:1;flex:0 1 auto;min-inline-size:0;max-inline-size:112px;margin-inline-start:4px;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;pointer-events:none;}',
    selector() + '::before{content:"";order:2;width:7px;height:7px;border-radius:50%;flex:none;margin-inline-start:1px;background:var(--dsw-alias-label-tertiary,#777);pointer-events:none;}']
  // 原工作区分组行gap为6px、单列表为0；圆点原左距1px保持，未改原生row间距。
  // 旧版为名称在前、圆点在后，本地整体隐藏；分组模式order只作用于新增伪元素；flat规则单列在下方。
  // 原021直接span的稳定类后缀；仅flat把时间和原菜单排在新增名/点之后，不触碰其它布局。
  if (flat) {
    // 原单列表gap为0，仅圆点后留4px并沿原flex居中；分组和树形保持原样。
    rules.push(selector() + '::before{margin-inline-end:4px;align-self:center;}')
    rules.push(selector() + ' > span[class$="_time"]{order:3;}')
    // 原time也显示紧凑交互状态：只给远程flat时间40px下限并右对齐，较长文字仍按原生内容宽度伸展。
    rules.push(selector() + ':not(' + selector('local') + ') > span[class$="_time"]{min-inline-size:4em;text-align:right;}')
    rules.push(selector() + ' > span[class$="_pinIndicator"]{order:4;}')
    rules.push(selector() + ' > span[class$="_rowActions"]{order:5;}')
  }
  rules.push(selector('local') + '::after{content:none;display:none;}')
  rules.push(selector('local') + '::before{content:none;display:none;}')
  const seen = new Set(['local'])
  for (const host of hosts) {
    if (seen.has(host.hostId)) continue
    let target
    try { target = selector(host.hostId) } catch { continue }
    seen.add(host.hostId)
    rules.push(target + '::after{content:' + quoted(host.label) + ';}')
    const state = String(host.state || '').toLowerCase()
    const color = ['connected', 'online', 'ready'].includes(state) ? 'var(--dsw-alias-state-success-primary,#22c55e)'
      : ['connecting', 'reconnecting', 'starting'].includes(state) ? 'var(--dsw-alias-state-warn-primary,#f59e0b)' : 'var(--dsw-alias-label-tertiary,#777)'
    rules.push(target + '::before{background:' + color + ';}')
  }
  return rules.join('\n')
}

export function installWorkspaceHostLabels(ctx, labels) {
  ctx.effect(() => ctx.locale.register(NS, { zh: { unknown: '未知主机' }, en: { unknown: 'Unknown host' } }), 'remote-hosts: workspace Host label copy')
  function WorkspaceHostLabels({ t, useStore }) {
    const hosts = useSyncExternalStore(labels.subscribe, labels.getSnapshot)
    const groupBy = useStore(state => state.groupBy)
    const selector = groupBy === 'flat' ? labels.sessionHostSelector : labels.workspaceHostSelector
    return createElement('style', { 'data-dsh-workspace-host-labels': '' }, workspaceHostStyles(hosts, selector, t('unknown'), groupBy === 'flat'))
  }
  // 原生entry声明子插槽时同步接入，早于其首mount；卸载声明即释放共享Store和适配。
  ctx.slots.inject('shell.overlay', () => ctx.slots.inject('sidebar.workspaces.directoryFlow', () => {
    const entry = ctx.slots.entries('sidebar.workspaces').find(item => item.children?.['sidebar.workspaces.directoryFlow'])
    if (!entry?.store || typeof entry.component !== 'function') return () => {}
    const restore = installWorkspaceRecency(entry)
    let stop
    try { stop = ctx.slots.register({ name: 'shell.overlay', id: 'dsh-remote-hosts.workspace-host-labels', locale: NS, store: entry.store }, WorkspaceHostLabels) }
    catch (error) { restore(); throw error }
    return () => { try { stop() } finally { restore() } }
  }))
}
