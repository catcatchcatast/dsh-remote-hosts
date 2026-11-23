// Public change history: docs/PUBLIC-CHANGES.md
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, rename, readFile, readdir, lstat, unlink, utimes, writeFile, copyFile, rm, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const CACHE_WEEK = 7 * 24 * 60 * 60 * 1000
const CHUNK = 1024 * 1024
const keyOf = identity => { const { output, ...source } = identity; return createHash('sha256').update(JSON.stringify(source)).digest('hex') }
async function waitFor(promise, signal) {
  let abort
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })])
  } finally { signal.removeEventListener('abort', abort) }
}

export class FilePreviewCache {
  constructor(root = path.join(os.tmpdir(), 'dsh-file-previews'), now = Date.now) {
    this.root = root
    this.now = now
    this.conversionGeneration = 'dsh-local-office-preview-' + randomUUID()
    this.pending = new Map()
    this.active = new Map()
    this.ready = mkdir(root, { recursive: true, mode: 0o700 }).then(() => this.clean())
    this.ready.catch(error => console.error('file preview cache:', error.message))
    this.timer = setInterval(() => this.clean().catch(error => console.error('file preview cleanup:', error.message)), CACHE_WEEK)
    this.timer.unref?.()
  }

  async prepare(hostId, sessionId, originalPath, createReader, signal, baseFile) {
    await this.ready
    if (this.closed) throw new Error('预览缓存已关闭')
    signal.throwIfAborted()
    const reader = await createReader()
    let stat
    try {
      stat = baseFile === undefined
        ? await reader.call('stat', { workspaceFileScopeId: sessionId, path: originalPath }, signal)
        : await reader.call('readBytes', { workspaceFileScopeId: sessionId, path: originalPath,
          options: { baseFile, range: { offset: 0, length: 1 } } }, signal)
    }
    finally { await reader.close() }
    const identity = { hostId, sessionId, path: stat.absolutePath, version: stat.version, bytes: stat.bytes }
    const id = keyOf(identity)
    const existing = await this.get(id)
    if (existing) { existing.release(); return existing }
    return this.shared(id, () => this.download(id, identity, createReader, this.pending.get(id).controller.signal), signal)
  }

  async shared(id, run, signal) {
    let pending = this.pending.get(id)
    if (pending?.controller.signal.aborted) {
      await waitFor(pending.promise.catch(() => {}), signal)
      return this.shared(id, run, signal)
    }
    if (!pending) {
      const controller = new AbortController()
      pending = { controller, users: 0, promise: Promise.resolve().then(run) }
      this.pending.set(id, pending)
      pending.promise.finally(() => { if (this.pending.get(id) === pending) this.pending.delete(id) }).catch(() => {})
    }
    pending.users++
    try {
      return await waitFor(pending.promise, signal)
    } finally {
      if (--pending.users === 0) pending.controller.abort()
    }
  }

  async derive(source, variant, convert, signal) {
    const identity = { hostId: source.hostId, sessionId: source.sessionId, path: source.path,
      version: source.version, bytes: source.bytes, variant }
    const id = keyOf(identity), existing = await this.get(id)
    if (existing) { existing.release(); return existing }
    return this.shared(id, async () => {
      const controller = this.pending.get(id).controller
      const lease = await this.get(source.id)
      const temporary = path.join(this.root, id + '.' + randomUUID() + '.part')
      const file = path.join(this.root, id + '.data')
      let published = false
      try {
        const extra = await convert(lease.file, temporary, controller.signal)
        controller.signal.throwIfAborted()
        const output = { bytes: (await lstat(temporary)).size, ...extra }
        await rename(temporary, file)
        await writeFile(temporary, JSON.stringify({ ...identity, output }), { flag: 'wx', mode: 0o600 })
        await rename(temporary, path.join(this.root, id + '.json'))
        published = true
        return { id, ...identity, output, file }
      } finally {
        lease?.release()
        await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
        if (!published) await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error })
      }
    }, signal)
  }
// Public change history: docs/PUBLIC-CHANGES.md
  async openCopy(entry, signal) {
    if (this.closed) throw new Error('预览缓存已关闭')
    const lease = await this.get(entry.id)
    const directory = path.join(this.root, entry.id + '.' + randomUUID() + '.open')
    let name = entry.path.split(/[\\/]/).at(-1)
    if (process.platform === 'win32') {
      name = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '')
      if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name
    }
    const target = path.join(directory, name)
    try {
      signal.throwIfAborted()
      await mkdir(directory, { mode: 0o700 })
      await copyFile(lease.file, target, constants.COPYFILE_FICLONE)
      signal.throwIfAborted()
      if (this.closed) throw new Error('预览缓存已关闭')
      return await realpath(target)
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error }
    finally { lease?.release() }
  }

  async download(id, identity, createReader, signal) {
    const temporary = path.join(this.root, id + '.' + randomUUID() + '.part')
    const file = path.join(this.root, id + '.data')
    const reader = await createReader()
    let handle
    const metadata = path.join(this.root, id + '.json')
    let published = false
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      handle = await open(temporary, 'wx', 0o600)
      for (let offset = 0; offset < identity.bytes;) {
        const length = Math.min(CHUNK, identity.bytes - offset)
        const part = await reader.call('readBytes', { workspaceFileScopeId: identity.sessionId,
          path: identity.path, options: { range: { offset, length } } }, signal)
        signal.throwIfAborted()
        if (part.version !== identity.version || part.bytes !== identity.bytes) throw new Error('文件已变化，请刷新预览。')
        if (part.offset !== offset || part.data?.byteLength !== length) throw new Error('文件读取未完成。')
        let written = 0
        while (written < length) written += (await handle.write(part.data, written, length - written, offset + written)).bytesWritten
        offset += length
      }
      const after = await reader.call('stat', { workspaceFileScopeId: identity.sessionId, path: identity.path }, signal)
      if (after.version !== identity.version || after.bytes !== identity.bytes) throw new Error('文件已变化，请刷新预览。')
      signal.throwIfAborted()
      await handle.close()
      await rename(temporary, file)
      const entry = { id, ...identity, file }
      await writeFile(temporary, JSON.stringify(identity), { flag: 'wx', mode: 0o600 })
      await rename(temporary, metadata)
      published = true
      return entry
    } finally {
      await handle?.close().catch(() => {})
      await reader.close()
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
      if (!published) await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error })
    }
  }

  async get(id) {
    if (!/^[a-f0-9]{64}$/.test(id)) return undefined
    try {
      const identity = JSON.parse(await readFile(path.join(this.root, id + '.json'), 'utf8'))
      const file = path.join(this.root, id + '.data'), info = await lstat(file)
      if (!info.isFile() || info.size !== (identity.output?.bytes ?? identity.bytes) || keyOf(identity) !== id) return undefined
      const date = new Date(this.now())
      await utimes(path.join(this.root, id + '.json'), date, date)
      this.active.set(id, (this.active.get(id) ?? 0) + 1)
      let released = false
      return { id, ...identity, file, release: () => {
        if (released) return
        released = true
        const remaining = this.active.get(id) - 1
        if (remaining) this.active.set(id, remaining)
        else this.active.delete(id)
      } }
    } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return undefined; throw error }
  }

  async clean() {
    let names
    try { names = await readdir(this.root) }
    catch (error) { if (error.code === 'ENOENT') return; throw error }
    for (const name of names) {
// Public change history: docs/PUBLIC-CHANGES.md
      if (/^[a-f0-9]{64}\.[a-f0-9-]+\.open$/.test(name)) {
        try {
          const directory = path.join(this.root, name), info = await lstat(directory)
          if (info.isDirectory() && !info.isSymbolicLink() && this.now() - info.mtimeMs >= CACHE_WEEK) {
            await rm(directory, { recursive: true }).catch(error => { if (!['ENOENT', 'EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error })
          }
        } catch (error) { if (error.code !== 'ENOENT') throw error }
        continue
      }
      const match = /^([a-f0-9]{64})(?:\.[a-f0-9-]+)?\.(data|json|part)(?:\.(?:docx?|xlsx?|pptx?))?$/.exec(name)
      if (!match || this.pending.has(match[1]) || this.active.has(match[1])) continue
      const file = path.join(this.root, name)
      try {
        const info = await lstat(file)
        if (!info.isFile() || this.now() - info.mtimeMs < CACHE_WEEK || this.active.has(match[1])) continue
        if (match[2] === 'data') {
          try { await lstat(path.join(this.root, match[1] + '.json')); continue }
          catch (error) { if (error.code !== 'ENOENT') throw error }
        }
        if (match[2] === 'json') await unlink(path.join(this.root, match[1] + '.data')).catch(error => { if (error.code !== 'ENOENT') throw error })
        await unlink(file)
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
  }

  close() {
    this.closed = true
    clearInterval(this.timer)
    for (const pending of this.pending.values()) pending.controller.abort()
    return Promise.allSettled([...this.pending.values()].map(value => value.promise)
      .concat(this.mediaReady?.then(server => server.close()) ?? []))
  }
}
