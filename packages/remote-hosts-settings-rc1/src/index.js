import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createDispatcher, CHANNEL } from './dispatch.js'
import { storePath } from './store.js'
import { isConcreteSshAlias } from './ssh-aliases.js'

export const name = 'remote-hosts-settings-rc1'
export const inject = ['webServer', 'runtimeInterface', 'remoteHostsControl']

function defaultConfigFile() {
  return join(homedir(), '.ssh', 'config')
}

function helperReadable(port) {
  try {
    return existsSync(join(homedir(), '.dsh-mobile', `bootstrap-${port}.json`))
  } catch {
    return false
  }
}

function readSshConfig(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

function verifyAlias(configFile, alias) {
  if (!isConcreteSshAlias(alias)) return Promise.reject(new Error('HOST_ALIAS_INVALID'))
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', ['-G', '-F', configFile, '-o', 'BatchMode=yes', alias], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.resume()
    child.stderr.resume()
    const timer = setTimeout(() => child.kill(), 10000)
    child.once('error', () => { clearTimeout(timer); reject(new Error('SSH_ALIAS_UNAVAILABLE')) })
    child.once('close', code => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error('SSH_ALIAS_UNAVAILABLE'))
    })
  })
}

export function apply(ctx) {
  if (ctx.webServer.host !== '127.0.0.1') throw new Error('HOST_UNAVAILABLE')
  const control = ctx.remoteHostsControl
  const dispatch = createDispatcher({
    seedTargets: control.getConfiguredTargets(),
    configFile: defaultConfigFile(),
    webPort: ctx.webServer.port,
    storeFile: storePath(),
    readSshConfig: async path => readSshConfig(path),
    verifyAlias,
    helperReadable,
    control,
    localRuntime: ctx.runtimeInterface.localRuntime,
  })
  if (typeof ctx.runtimeInterface?.registerManagementRpc !== 'function') throw new TypeError('management interface is required')
  return ctx.effect(() => {
    void dispatch.boot().catch(() => {})
    return ctx.runtimeInterface.registerManagementRpc({
      channel: CHANNEL,
      dispatch: ({ method, params, signal }) => dispatch(method, params, signal),
    })
  }, 'remote-hosts-settings-rc1: rpc')
}
