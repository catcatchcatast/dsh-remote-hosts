// Public change history: docs/PUBLIC-CHANGES.md
import { lstat, realpath } from 'node:fs/promises'
import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export interface PathDecision {
  allowed: boolean
  resolved?: string
  reason?: string
}

const ALLOWED_TOOLS = new Set(['read', 'read_image', 'grep', 'glob', 'web_search', 'ask_user_question'])
const SENSITIVE_COMPONENTS = new Set([
  '.git', '.dsh', '.ssh', '.gnupg', '.aws', '.azure', '.config', '.npmrc', '.pypirc',
  'credentials', 'credential', 'secrets', 'secret', 'id_rsa', 'id_ed25519',
])

function components(path: string): string[] {
  return path.replaceAll('\\', '/').split('/').filter(Boolean).map(part => part.toLowerCase())
}

function isSensitive(path: string): boolean {
  return components(path).some((part) => part === '.env' || part.startsWith('.env.') || SENSITIVE_COMPONENTS.has(part)
    || /^(?:credentials?|secrets?)(?:[._-].*)?$/.test(part)
    || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:[._-].*)?$/.test(part)
    || part.endsWith('.pem') || part.endsWith('.key') || part.endsWith('.pfx') || part.endsWith('.kdbx'))
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

export class WorkspacePathPolicy {
  readonly #root: string

  private constructor(root: string) {
    this.#root = root
  }

  static async create(root: string): Promise<WorkspacePathPolicy> {
    const resolved = await realpath(root)
    const info = await lstat(resolved)
    if (!info.isDirectory()) throw new Error('workspace root is not a directory')
    return new WorkspacePathPolicy(resolved)
  }

  static createSync(root: string): WorkspacePathPolicy {
    const resolved = realpathSync(root)
    const info = lstatSync(resolved)
    if (!info.isDirectory()) throw new Error('workspace root is not a directory')
    return new WorkspacePathPolicy(resolved)
  }

  get root(): string { return this.#root }

  async validateExisting(input: string, expected: 'file' | 'directory' | 'either' = 'either'): Promise<PathDecision> {
    if (typeof input !== 'string' || input.trim().length === 0 || input.includes('\0')) {
      return { allowed: false, reason: 'invalid path' }
    }
    if (isSensitive(input)) return { allowed: false, reason: 'sensitive path is blocked' }
    const lexical = resolve(this.#root, input)
    if (!inside(this.#root, lexical)) return { allowed: false, reason: 'path is outside the workspace' }
    let resolved: string
    try {
      resolved = await realpath(lexical)
    } catch {
      return { allowed: false, reason: 'path does not exist' }
    }
    if (!inside(this.#root, resolved)) return { allowed: false, reason: 'symlink target is outside the workspace' }
    if (isSensitive(relative(this.#root, resolved))) return { allowed: false, reason: 'sensitive path is blocked' }
    const info = await lstat(resolved)
    if (info.isSymbolicLink()) return { allowed: false, reason: 'symlinks are blocked' }
    if (!info.isFile() && !info.isDirectory()) return { allowed: false, reason: 'special files are blocked' }
    if (expected === 'file' && !info.isFile()) return { allowed: false, reason: 'path is not a regular file' }
    if (expected === 'directory' && !info.isDirectory()) return { allowed: false, reason: 'path is not a directory' }
    return { allowed: true, resolved }
  }

  guardTool(name: string, args: unknown): string | undefined {
    if (!ALLOWED_TOOLS.has(name)) return `Tool ${name} is not allowed in a shared session`
    if (typeof args !== 'object' || args === null || Array.isArray(args)) return 'Tool arguments must be an object'
    const values = args as Record<string, unknown>
    if (name === 'web_search') {
      const queries = values.queries
      if (!Array.isArray(queries) || queries.length < 1 || queries.length > 2
        || queries.some(query => typeof query !== 'string' || query.trim().length === 0 || query.length > 500)) {
        return 'web_search accepts one or two queries'
      }
      return undefined
    }
    if (name === 'ask_user_question') {
      const questions = values.questions
      if (!Array.isArray(questions) || questions.length < 1 || questions.length > 3) return 'ask_user_question accepts one to three questions'
      return undefined
    }
    const pathKey = name === 'read' || name === 'read_image' ? 'file_path' : 'path'
    const rawPath = values[pathKey]
    if (rawPath === undefined && (name === 'grep' || name === 'glob')) return undefined
    if (typeof rawPath !== 'string') return `${name} requires a valid ${pathKey}`
    const decision = this.validateExistingSync(rawPath, name === 'read' || name === 'read_image' ? 'file' : 'either')
    return decision.allowed ? undefined : decision.reason
  }

  validateExistingSync(input: string, expected: 'file' | 'directory' | 'either' = 'either'): PathDecision {
    if (typeof input !== 'string' || input.trim().length === 0 || input.includes('\0')) return { allowed: false, reason: 'invalid path' }
    if (isSensitive(input)) return { allowed: false, reason: 'sensitive path is blocked' }
    const lexical = resolve(this.#root, input)
    if (!inside(this.#root, lexical)) return { allowed: false, reason: 'path is outside the workspace' }
    let resolved: string
    try { resolved = realpathSync(lexical) } catch { return { allowed: false, reason: 'path does not exist' } }
    if (!inside(this.#root, resolved)) return { allowed: false, reason: 'symlink target is outside the workspace' }
    if (isSensitive(relative(this.#root, resolved))) return { allowed: false, reason: 'sensitive path is blocked' }
    const info = lstatSync(resolved)
    if (info.isSymbolicLink()) return { allowed: false, reason: 'symlinks are blocked' }
    if (!info.isFile() && !info.isDirectory()) return { allowed: false, reason: 'special files are blocked' }
    if (expected === 'file' && !info.isFile()) return { allowed: false, reason: 'path is not a regular file' }
    if (expected === 'directory' && !info.isDirectory()) return { allowed: false, reason: 'path is not a directory' }
    return { allowed: true, resolved }
  }
}
