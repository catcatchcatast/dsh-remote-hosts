// Public change history: docs/PUBLIC-CHANGES.md
import { spawn } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, extname, join, matchesGlob, relative } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { WorkspacePathPolicy } from './session-share-path-policy.ts'
import type { SessionSharePolicy } from './session-share-interface.js'

type VisitorImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

const IMAGE_TYPES: Record<string, VisitorImageMediaType> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
}
const SAFE_SHARE_TOOL_NAMES = ['ask_user_question', 'web_search', 'read', 'read_image', 'grep', 'glob']

function renderImage(value: { path: string; image: ImageAttachmentRef }): ContentBlock[] {
  return [
    { type: 'text', text: `<path>${value.path}</path>\n<type>image</type>` },
    { type: 'image', attachment: value.image },
  ]
}

async function walkFiles(policy: WorkspacePathPolicy, directory: string, signal: AbortSignal, limit = 10_000): Promise<string[]> {
  const output: string[] = []
  const queue = [directory]
  while (queue.length > 0 && output.length < limit) {
    if (signal.aborted) throw signal.reason
    const current = queue.shift()
    if (current === undefined) break
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      if (signal.aborted) throw signal.reason
      if (entry.isSymbolicLink()) continue
      const absolute = join(current, entry.name)
      const rel = relative(policy.root, absolute)
      const decision = policy.validateExistingSync(rel, entry.isDirectory() ? 'directory' : 'file')
      if (!decision.allowed) continue
      if (entry.isDirectory()) queue.push(absolute)
      else if (entry.isFile()) output.push(rel.replaceAll('\\', '/'))
      if (output.length >= limit) break
    }
  }
  return output
}

async function runRgBatch(pattern: string, cwd: string, files: readonly string[], signal: AbortSignal): Promise<Array<{ path: string; lineNumber: number; line: string }>> {
  if (files.length === 0) return []
  try {
    return await new Promise((resolve, reject) => {
    // Every path is enumerated and approved before ripgrep starts. Never point
    // ripgrep at the workspace root: post-filtering matches would be too late,
    // because the process would already have read secrets from denied files.
    const child = spawn('rg', ['--no-config', '--json', '--max-count', '100', '--', pattern, ...files], {
      cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes <= 2 * 1024 * 1024) stdout.push(chunk)
      else child.kill()
    })
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.reduce((sum, item) => sum + item.length, 0) < 64 * 1024) stderr.push(chunk) })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code !== 0 && code !== 1) return reject(new Error(`safe grep failed: ${Buffer.concat(stderr).toString('utf8').slice(0, 500)}`))
      const matches: Array<{ path: string; lineNumber: number; line: string }> = []
      for (const line of Buffer.concat(stdout).toString('utf8').split('\n')) {
        if (line.length === 0) continue
        try {
          const parsed = JSON.parse(line) as { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } }
          if (parsed.type === 'match' && parsed.data?.path?.text !== undefined && parsed.data.line_number !== undefined) {
            matches.push({ path: parsed.data.path.text.replaceAll('\\', '/'), lineNumber: parsed.data.line_number, line: (parsed.data.lines?.text ?? '').replace(/[\r\n]+$/, '').slice(0, 4000) })
          }
        } catch { /* ignore non-JSON diagnostic lines */ }
      }
      resolve(matches)
    })
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return await runGnuGrepBatch(pattern, cwd, files, signal)
  }
}

async function runGnuGrepBatch(pattern: string, cwd: string, files: readonly string[], signal: AbortSignal): Promise<Array<{ path: string; lineNumber: number; line: string }>> {
  return await new Promise((resolve, reject) => {
    // Ubuntu ships GNU grep even when ripgrep is absent. `-I` prevents binary
    // payloads from entering the model and `-Z` makes the filename boundary
    // unambiguous without pointing grep at an unapproved directory.
    const child = spawn('grep', ['-I', '-Z', '-nH', '-m', '100', '-E', '--', pattern, ...files], {
      cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes <= 2 * 1024 * 1024) stdout.push(chunk)
      else child.kill()
    })
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.reduce((sum, item) => sum + item.length, 0) < 64 * 1024) stderr.push(chunk) })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code !== 0 && code !== 1) return reject(new Error(`safe grep failed: ${Buffer.concat(stderr).toString('utf8').slice(0, 500)}`))
      const matches: Array<{ path: string; lineNumber: number; line: string }> = []
      for (const entry of Buffer.concat(stdout).toString('utf8').split('\n')) {
        const nul = entry.indexOf('\0')
        if (nul < 1) continue
        const path = entry.slice(0, nul).replaceAll('\\', '/')
        const match = /^(\d+):(.*)$/.exec(entry.slice(nul + 1))
        if (match?.[1] === undefined || match[2] === undefined) continue
        matches.push({ path, lineNumber: Number(match[1]), line: match[2].slice(0, 4000) })
      }
      resolve(matches)
    })
  })
}

async function runSafeRg(
  policy: WorkspacePathPolicy,
  pattern: string,
  base: string,
  include: string | undefined,
  signal: AbortSignal,
): Promise<Array<{ path: string; lineNumber: number; line: string }>> {
  let files = await walkFiles(policy, base, signal, 10_000)
    .then(paths => paths.map(path => relative(base, join(policy.root, path)).replaceAll('\\', '/')))
    .then(paths => paths.filter(path => path !== '' && path !== '..' && !path.startsWith('../')))
  if (include !== undefined) {
    try { files = files.filter(path => matchesGlob(path, include)) } catch { throw new Error('invalid include pattern') }
  }
  const matches: Array<{ path: string; lineNumber: number; line: string }> = []
  for (let offset = 0; offset < files.length && matches.length <= 100; offset += 64) {
    signal.throwIfAborted()
    const candidates = files.slice(offset, offset + 64).filter(path => {
      const rel = relative(policy.root, join(base, path))
      return policy.validateExistingSync(rel, 'file').allowed
    })
    const approved: string[] = []
    for (const path of candidates) {
      const info = await stat(join(base, path))
      if (info.isFile() && info.size <= 2 * 1024 * 1024) approved.push(path)
    }
    matches.push(...await runRgBatch(pattern, base, approved, signal))
  }
  return matches
}

export function installRestrictedShareTools(
  presetCtx: Context,
  options: {
    resolvePolicy: (agentId: string) => Promise<SessionSharePolicy | undefined>
    resolvePolicySync: (agentId: string) => SessionSharePolicy | undefined
  },
): void {
  const inheritedAsk = presetCtx.tools.get('ask_user_question')
  const inheritedSearch = presetCtx.tools.get('web_search')
  if (inheritedAsk === undefined || inheritedSearch === undefined) throw new Error('shared sessions require ask_user_question and web_search')

  const policyForExec = async (exec: { agent?: { id?: unknown } }) => {
    const id = typeof exec.agent?.id === 'string' ? exec.agent.id : ''
    const policy = id.length > 0 ? await options.resolvePolicy(id) : undefined
    if (policy?.state !== 'ACTIVE' || policy.branchSessionId !== id) throw new Error('active share policy is unavailable')
    return policy
  }
  presetCtx.tools.restrict({ allow: SAFE_SHARE_TOOL_NAMES })
  presetCtx.tools.guard(exec => {
    const id = typeof exec.agent?.id === 'string' ? exec.agent.id : ''
    if (id.length === 0) return 'Agent identity is unavailable'
    const policy = options.resolvePolicySync(id)
    if (policy?.state !== 'ACTIVE' || policy.branchSessionId !== id) return 'Active share policy is unavailable'
    try { return WorkspacePathPolicy.createSync(policy.workspaceRoot).guardTool(exec.name, exec.arguments) }
    catch { return 'Shared workspace is unavailable' }
  })

  presetCtx.tools.register(defineTool({
    name: 'read',
    description: 'Read a regular UTF-8 text file inside the shared workspace.',
    parameters: {
      file_path: { type: 'string', required: true },
      offset: { type: 'number' },
      limit: { type: 'number' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        path: { type: 'string', required: true }, text: { type: 'string', required: true }, truncated: { type: 'boolean', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: `<path>${value.path}</path>\n<content>\n${value.text}\n</content>${value.truncated ? '\n<truncated>true</truncated>' : ''}` }],
    },
    async execute(args, exec) {
      const policy = WorkspacePathPolicy.createSync((await policyForExec(exec)).workspaceRoot)
      const decision = policy.validateExistingSync(args.file_path, 'file')
      if (!decision.allowed || decision.resolved === undefined) throw new Error(decision.reason ?? 'file denied')
      if ((await stat(decision.resolved)).size > 2 * 1024 * 1024) throw new Error('shared read is limited to 2 MiB files')
      const bytes = await readFile(decision.resolved)
      if (bytes.includes(0)) throw new Error('binary files are not readable through shared sessions')
      const lines = bytes.toString('utf8').split(/\r?\n/)
      const offset = Number.isSafeInteger(args.offset) && (args.offset ?? 0) > 0 ? Math.floor(args.offset as number) : 1
      const limit = Number.isSafeInteger(args.limit) && (args.limit ?? 0) > 0 ? Math.min(200, Math.floor(args.limit as number)) : 200
      const page = lines.slice(offset - 1, offset - 1 + limit)
      const text = page.map((line, index) => `${offset + index}: ${line}`).join('\n').slice(0, 256 * 1024)
      if (exec.signal.aborted) throw exec.signal.reason
      return { path: relative(policy.root, decision.resolved).replaceAll('\\', '/'), text, truncated: offset - 1 + page.length < lines.length }
    },
  }))

  presetCtx.tools.register(defineTool({
    name: 'glob', description: 'Find regular files inside the shared workspace.',
    parameters: { pattern: { type: 'string', required: true }, path: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      root: { type: 'string', required: true }, paths: { type: 'array', required: true, items: { type: 'string' } }, truncated: { type: 'boolean', required: true },
    } }, render: (_args, value) => [{ type: 'text', text: value.paths.join('\n') + (value.truncated ? '\n<truncated>true</truncated>' : '') }] },
    async execute(args, exec) {
      const policy = WorkspacePathPolicy.createSync((await policyForExec(exec)).workspaceRoot)
      if (args.pattern.length > 512) throw new Error('glob pattern is too long')
      const base = args.path === undefined ? policy.root : policy.validateExistingSync(args.path, 'directory').resolved
      if (base === undefined) throw new Error('glob path is denied')
      const files = await walkFiles(policy, base, exec.signal, 5001)
      let paths: string[]
      try { paths = files.filter(path => matchesGlob(path, args.pattern)) } catch { throw new Error('invalid glob pattern') }
      return { root: relative(policy.root, base).replaceAll('\\', '/') || '.', paths: paths.slice(0, 500), truncated: paths.length > 500 }
    },
  }))

  presetCtx.tools.register(defineTool({
    name: 'grep', description: 'Search text in regular files inside the shared workspace.',
    parameters: { pattern: { type: 'string', required: true }, path: { type: 'string' }, include: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      matches: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        path: { type: 'string', required: true }, lineNumber: { type: 'integer', required: true }, line: { type: 'string', required: true },
      } } }, truncated: { type: 'boolean', required: true },
    } }, render: (_args, value) => [{ type: 'text', text: value.matches.map(match => `${match.path}:${match.lineNumber}:${match.line}`).join('\n') + (value.truncated ? '\n<truncated>true</truncated>' : '') }] },
    async execute(args, exec) {
      const policy = WorkspacePathPolicy.createSync((await policyForExec(exec)).workspaceRoot)
      if (args.pattern.length > 512) throw new Error('grep pattern is too long')
      const baseDecision = args.path === undefined ? { allowed: true, resolved: policy.root } : policy.validateExistingSync(args.path)
      if (!baseDecision.allowed || baseDecision.resolved === undefined) throw new Error(baseDecision.reason ?? 'grep path is denied')
      const raw = await runSafeRg(policy, args.pattern, baseDecision.resolved, args.include, exec.signal)
      const safe = raw.filter(match => {
        const absolute = join(baseDecision.resolved!, match.path)
        const rel = relative(policy.root, absolute)
        if (!policy.validateExistingSync(rel, 'file').allowed) return false
        return true
      })
      return { matches: safe.slice(0, 100), truncated: safe.length > 100 }
    },
  }))

  presetCtx.tools.register(defineTool({
    name: 'read_image', description: 'Read an image inside the shared workspace.',
    parameters: { file_path: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      path: { type: 'string', required: true }, image: { type: 'object', required: true, additionalProperties: false, properties: {
        attachmentId: { type: 'string', required: true }, mediaType: { type: 'string', required: true }, bytes: { type: 'integer', required: true }, width: { type: 'integer', required: true }, height: { type: 'integer', required: true }, name: { type: 'string' },
      } },
    } }, render: (_args, value) => renderImage({ path: value.path, image: { ...value.image, attachmentId: AttachmentId(value.image.attachmentId) } as ImageAttachmentRef }) },
    async execute(args, exec) {
      const policySnapshot = await policyForExec(exec)
      const policy = WorkspacePathPolicy.createSync(policySnapshot.workspaceRoot)
      const decision = policy.validateExistingSync(args.file_path, 'file')
      if (!decision.allowed || decision.resolved === undefined) throw new Error(decision.reason ?? 'image denied')
      const declaredMediaType = IMAGE_TYPES[extname(decision.resolved).toLowerCase()]
      if (declaredMediaType === undefined) throw new Error('read_image only accepts PNG, JPEG, WebP or GIF')
      if ((await stat(decision.resolved)).size > 8 * 1024 * 1024) throw new Error('shared read_image is limited to 8 MiB files')
      const bytes = await readFile(decision.resolved)
      const normalized = await policySnapshot.normalizeImage({ declaredMediaType, bytes })
      if (normalized === undefined) throw new Error('image normalization failed')
      const ref = await presetCtx.attachments.saveImage({ data: normalized.bytes, mediaType: normalized.mediaType as ImageMediaType, name: basename(decision.resolved) })
      return { path: relative(policy.root, decision.resolved).replaceAll('\\', '/'), image: ref }
    },
  }))

  presetCtx.tools.register({
    ...inheritedSearch,
    name: 'web_search',
    description: 'Search the web using one or two queries and return at most six sources.',
    async execute(args, exec) {
      const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(20_000)])
      const result = await inheritedSearch.execute(args, { ...exec, signal })
      if (typeof result !== 'object' || result === null || Array.isArray(result)) return result
      const value = result as Record<string, unknown>
      return { ...value, ...(Array.isArray(value.sources) ? { sources: value.sources.slice(0, 6), truncated: value.sources.length > 6 || value.truncated === true } : {}) }
    },
  })
}
