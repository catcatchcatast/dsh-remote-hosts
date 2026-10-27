// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                               
                                                                                                                                                   
const releasedError = () => Object.assign(new Error('FILE_UPLOAD_INSTALLATION_RELEASED'), { code: 'FILE_UPLOAD_INSTALLATION_RELEASED' })

function disposerOf(value, capability) {
  if (typeof value === 'function') return value
  if (value && typeof value.dispose === 'function') return () => value.dispose()
  throw new TypeError(`${capability} did not return a release handle`)
}

function throwFailures(failures) {
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'FILE_UPLOAD_INSTALLATION_RELEASE_FAILED')
}

/** Keep raw resource handles inside the interface and release them as one lease. */
export function createResourceLease() {
  let active = true
  let releaseResult
  const resources = []

  function track(value, capability) {
    const dispose = disposerOf(value, capability)
    if (!active) {
      try {
        const result = dispose()
        if (result && typeof result.then === 'function') void Promise.resolve(result).catch(() => undefined)
      } finally {
        throw releasedError()
      }
    }
    let owned = true
    const release = () => {
      if (!owned) return
      owned = false
      const index = resources.lastIndexOf(release)
      if (index !== -1) resources.splice(index, 1)
      return dispose()
    }
    resources.push(release)
    return release
  }

  function release() {
    if (!active) return releaseResult
    active = false
    const failures = []
    const pending = []
    for (const dispose of resources.splice(0).reverse()) {
      try {
        const result = dispose()
        if (result && typeof result.then === 'function') pending.push(Promise.resolve(result).catch(error => failures.push(error)))
      } catch (error) {
        failures.push(error)
      }
    }
    if (pending.length === 0) {
      throwFailures(failures)
      return
    }
    releaseResult = Promise.all(pending).then(() => throwFailures(failures))
    return releaseResult
  }

  return Object.freeze({
    assertActive() { if (!active) throw releasedError() },
    track,
    release,
  })
}
