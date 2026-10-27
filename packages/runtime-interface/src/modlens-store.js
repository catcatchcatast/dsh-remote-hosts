// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                               
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, normalize } from 'node:path'

const variable = 'DSH_MODLENS_CONFIG_PATH'
/** Locate only this plugin's store; default shared-file semantics are unchanged. */
export function createModlensConfigStore(input) {
  const isolated = input !== undefined
  if (isolated && (typeof input !== 'string' || input.includes('\0') || !isAbsolute(input))) throw new TypeError('modlens configuration location is invalid')
  const file = isolated ? normalize(input) : join(homedir(), '.modlens', 'config.json')
  return Object.freeze({
    file,
    directory: dirname(file),
    isolated,
    cliEnvironment(base) {
      const environment = { ...base }
      if (isolated) environment[variable] = file
      else delete environment[variable]
      return environment
    },
  })
}

/** The shipped CLI receives exactly the same explicit file from its owning plugin. */
export function modlensConfigStoreFromEnvironment(environment) {
  return createModlensConfigStore(environment?.[variable])
}
