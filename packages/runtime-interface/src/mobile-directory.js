// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                                           
import { WEB_021_RUNTIME_VERSION } from './web-020.js'

/** Mobile browses host directories without replacing the desktop's native picker. */
export function createMobileDirectoryPort(ctx, { upstreamVersion, getController }) {
  let pending
  async function controller() {
    ctx.fiber.assertActive()
    const current = getController()
    if (upstreamVersion !== WEB_021_RUNTIME_VERSION) return current
    const picker = ctx.get('directoryPicker')
    if (current && picker?.capability?.().kind !== 'native') return current
    // Fresh isolate labels are private to this owning plugin; Cordis unloads
    // both official services with it. Concurrent mobile calls share one load.
    pending ??= (async () => {
      const [{ default: BrowseDirectoryPicker }, { DirectoryPickerController }] = await Promise.all([
        import('@deepseek-ai/dsh-host-directory-picker-browse'),
        import('@deepseek-ai/dsh-api-workspace-controller'),
      ])
      ctx.fiber.assertActive()
      const scope = ctx.isolate('directoryPicker').isolate('directoryPickerController')
      await scope.plugin(BrowseDirectoryPicker)
      await scope.plugin(DirectoryPickerController)
      ctx.fiber.assertActive()
      return scope.get('directoryPickerController')
    })()
    return pending
  }
  return Object.freeze({
    async list(path, signal) { return (await controller()).list(path, signal) },
    async createDirectory(path, name) { return (await controller()).createDirectory(path, name) },
  })
}
