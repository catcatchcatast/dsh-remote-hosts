// 公开打包追溯：docs/PUBLIC-CHANGES.md                                               
import { join } from 'node:path'
import { createUploadHandler, createImageIntakePolicy, createSweeper, PARTIAL_TTL_MS } from './upload.js'
import { createFileBrowserHandler } from './file-browser.js'

export const name = 'mobile-file-transfer-compat-rc1'
export const inject = ['fileUploadInterface']

export function apply(ctx) {
  const installation = ctx.fileUploadInterface.createInstallation()
  const runtime = installation.port
  try {
    ctx.effect(() => installation.release)
    const defaultDir = join(process.cwd(), 'uploads')
    const sessionCwd = async id => runtime.sessions.cwd(id) ?? await runtime.sessions.persistedCwd(id)
    runtime.routes.registerPrefix('/api/upload/v2', createUploadHandler({
      maxBytes: 1024 * 1024 * 1024,
      maxConcurrent: 4,
      allowedExtensions: [],
      defaultDir,
      sessionCwd,
      imageMode: async id => (await runtime.imageCapabilities(id)).modelAcceptsImages ? 'native' : undefined,
      imageIntake: async id => {
        const capabilities = await runtime.imageCapabilities(id)
        return createImageIntakePolicy(capabilities.modelAcceptsImages && capabilities.imageLimits !== undefined, capabilities.imageLimits)
      },
    }))
    runtime.routes.registerPrefix('/api/file-browser/v1', createFileBrowserHandler({ defaultDir, sessionCwd }))
    runtime.registerEffect(() => createSweeper([
      defaultDir,
      async () => [...runtime.sessions.liveCwds(), ...await runtime.sessions.persistedCwds()],
    ], PARTIAL_TTL_MS, 60 * 60 * 1000))
  } catch (error) {
    try { installation.release() } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'mobile file transfer installation cleanup failed')
    }
    throw error
  }
}
