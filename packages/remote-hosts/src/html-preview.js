// Public change history: docs/PUBLIC-CHANGES.md
import { createElement, useEffect, useState } from 'react'
// Public change history: docs/PUBLIC-CHANGES.md
import { preparePreview } from './prepare-preview.js'
const id = 'dsh-remote-hosts/html-stream'

export function HtmlPreview({ resourceAddress, useResource, useInteractivePreview, content }) {
  const resource = useResource(resourceAddress), source = resource.value
  const interactive = useInteractivePreview(value => value)
  const [view, setView] = useState({})
  useEffect(() => {
    if (!view.url) return
    const controller = new AbortController()
    const timer = setInterval(() => { fetch(view.url, { method: 'HEAD', signal: controller.signal })
      .then(response => { if (!controller.signal.aborted && response.status === 404) content.reload() }).catch(() => {}) }, 24 * 60 * 60 * 1000)
    return () => { clearInterval(timer); controller.abort() }
  }, [view.url, content.reload])
  useEffect(() => {
    if (!source?.absolutePath || resource.status !== 'live') return
    const controller = new AbortController()
    const sessionId = decodeURIComponent(new URL(resourceAddress).pathname.split('/')[2])
    setView({})
    preparePreview({ sessionId, path: source.absolutePath }, controller.signal).then(entry => {
      if (!controller.signal.aborted) setView({ url: entry.htmlUrl, version: entry.version })
    }).catch(error => { if (!controller.signal.aborted) { setView({ error: error.message }); content.failed() } })
    return () => controller.abort()
  }, [resourceAddress, source?.absolutePath, source?.version, resource.status, content.revision])
  if (view.error) return createElement('p', { role: 'alert' }, view.error)
  if (!view.url) return createElement('p', { role: 'status' }, '正在准备 HTML 预览…')
  return createElement('iframe', { key: view.url + interactive, src: view.url, sandbox: interactive ? 'allow-scripts' : '',
    title: 'HTML 文档预览', 'data-html-preview': true, style: { width: '100%', height: '100%', border: 0 },
    onLoad: () => content.loaded(view.version), onError: () => content.failed() })
}

export function installHtmlPreview(ctx) {
  ctx.effect(() => ctx.documentPreviews.register({ id, extensions: ['html', 'htm'], priority: 'extension',
    title: () => 'HTML', loading: 'renderer', wrap: false }))
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register({ name: 'sidebar.right.tab.document', key: id,
    inject: () => ({ hooks: { interactivePreview: ctx.configForms.developerTools.enabled } }),
  }, HtmlPreview)))
}
