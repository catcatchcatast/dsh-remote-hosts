// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                                                     

const MAX_ARGUMENT_BYTES = 64 * 1024
const MAX_OBJECT_KEYS = 64
const MAX_KEY_LENGTH = 128
const MAX_DESCRIPTION_LENGTH = 512
const MAX_VIEW_TAG_LENGTH = 128
const MAX_VIEW_STRING_LENGTH = 512

const KNOWN_TOOL_DESCRIPTIONS = Object.freeze({
  bash: '执行命令',
  pwsh: '执行命令',
  job_output: '读取后台任务输出',
})

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedString(value, maximum) {
  return typeof value === 'string' ? value.slice(0, maximum) : undefined
}

function nonBlankString(value, maximum) {
  const string = boundedString(value, maximum)
  return string === undefined || string.trim() === '' ? undefined : string
}

function safeView(view) {
  if (!isRecord(view)) return {}
  const result = {}
  for (const key of ['card', 'title', 'description', 'signal', 'kind', 'status']) {
    const string = boundedString(view[key], key === 'card' || key === 'kind' ? MAX_VIEW_TAG_LENGTH : MAX_VIEW_STRING_LENGTH)
    if (string !== undefined) result[key] = string
  }
  if (Number.isSafeInteger(view.exitCode)) result.exitCode = view.exitCode
  return result
}

function normalizeToolName(value) {
  const name = nonBlankString(value, MAX_KEY_LENGTH)
  return name === undefined ? undefined : name.toLowerCase().replaceAll('-', '_')
}

function hasOperationSummary(view) {
  return ['description', 'title', 'signal'].some(key => nonBlankString(view[key], MAX_VIEW_STRING_LENGTH) !== undefined)
}

function declaredDescription(argumentsText) {
  if (typeof argumentsText !== 'string' || Buffer.byteLength(argumentsText, 'utf8') > MAX_ARGUMENT_BYTES) return undefined
  let parsed
  try { parsed = JSON.parse(argumentsText) } catch { return undefined }
  if (!isRecord(parsed)) return undefined
  const keys = Object.keys(parsed)
  if (keys.length > MAX_OBJECT_KEYS || keys.some(key => key.length > MAX_KEY_LENGTH)) return undefined
  return nonBlankString(parsed.description, MAX_DESCRIPTION_LENGTH)
}

/**
 * Derive a mobile-safe tool summary from the host view and declarative call description.
 * Command, path, query, result, and arbitrary argument fields are deliberately ignored.
 */
export function toMobileToolSummary({ name, toolName, arguments: argumentsValue, argumentsText, view } = {}) {
  const result = safeView(view)
  if (!hasOperationSummary(result)) {
    const description = declaredDescription(argumentsText ?? argumentsValue)
    if (description !== undefined) result.description = description
    else {
      const normalizedName = normalizeToolName(name ?? toolName)
      if (normalizedName !== undefined && Object.hasOwn(KNOWN_TOOL_DESCRIPTIONS, normalizedName)) {
        result.description = KNOWN_TOOL_DESCRIPTIONS[normalizedName]
      }
    }
  }
  return Object.keys(result).length === 0 ? undefined : result
}
