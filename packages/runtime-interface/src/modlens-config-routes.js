// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                               
const refusal = 'request refused: this route answers same-origin loopback only'
function loopback(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}
function trusted(req) {
  const host = req.headers?.host
  if (typeof host !== 'string' || host === '') return false
  try {
    const url = new URL(`http://${host}`)
    if (!loopback(url.hostname) || req.headers?.['sec-fetch-site'] === 'cross-site') return false
    return req.headers?.origin === undefined || new URL(req.headers.origin).host === url.host
  } catch { return false }
}
function settingsPatch(value) {
  // Preserve the original submission semantics while detaching the stable
  // settings fields from the HTTP packet. The business owns engine policy.
  const patch = Object.create(null)
  if (value !== null && typeof value === 'object') {
    for (const key of ['provider', 'engine', 'baseUrl', 'model', 'apiKey', 'proxyMode', 'proxy', 'reuse']) {
      if (Object.hasOwn(value, key)) patch[key] = value[key]
    }
  }
  if (patch.reuse !== null && typeof patch.reuse === 'object') Object.freeze(patch.reuse)
  return Object.freeze(patch)
}

/** One installation owns its HTTP binding and its plugin-scoped disposal. */
export function installModlensConfigRoutes(ctx, { summary, save, open, discover }) {
  if ([summary, save, open, discover].some(value => typeof value !== 'function')) throw new TypeError('modlens settings handlers are required')
  let active = true
  const releases = new Set()
  const stop = () => {
    if (!active) return
    active = false
    for (const release of [...releases]) release()
  }
  ctx.effect(() => stop)
  if (typeof ctx.inject !== 'function') return stop
  ctx.inject(['webServer'], scope => {
    if (!active) return
    let routeActive = true
    scope.effect(() => {
      const send = (res, status, body) => {
        if (!active || !routeActive) return
        res.writeHead(status, body === undefined ? undefined : { 'content-type': 'application/json' })
        res.end(body === undefined ? undefined : JSON.stringify(body))
      }
      let unregister
      try {
        unregister = scope.webServer.register({
          name: 'modlens-config', kind: 'exact', path: '/modlens/config',
          async handler(req, res) {
            if (!active || !routeActive) return
            if (!trusted(req)) return send(res, 403, { error: refusal })
            if (req.method === 'GET') {
              try {
                const result = { ...await summary() }
                if (new URL(req.url, 'http://localhost').searchParams.has('discover')) result.discovery = await discover()
                send(res, 200, result)
              } catch (error) { send(res, 409, { error: String(error?.message ?? error) }) }
              return
            }
            if (req.method !== 'POST') return send(res, 405)
            let input
            try {
              const chunks = []; let total = 0
              for await (const chunk of req) {
                if (!active || !routeActive) return
                total += chunk.length
                if (total > 64 * 1024) {
                  send(res, 413, { error: 'config payload too large' }); req.destroy(); return
                }
                chunks.push(chunk)
              }
              if (!active || !routeActive) return
              input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            } catch {
              send(res, 400, { error: 'invalid configuration payload' })
              return
            }
            try {
              if (input?.open === true) { await open(); send(res, 200, { opened: true }); return }
              send(res, 200, await save(settingsPatch(input)))
            } catch (error) { send(res, 400, { error: String(error?.message ?? error) }) }
          },
        })
      } catch {
        console.error('[modlens] settings card route skipped: route unavailable')
        routeActive = false
        return
      }
      const release = () => {
        if (!routeActive) return
        routeActive = false
        releases.delete(release)
        unregister()
      }
      releases.add(release)
      return release
    })
  })
  return stop
}
