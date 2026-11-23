// Public change history: docs/PUBLIC-CHANGES.md
import { copyFile, unlink } from 'node:fs/promises'
import { spawn } from 'node:child_process'

function ffmpeg(args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.DSH_PREVIEW_FFMPEG || 'ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...args],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], signal })
    let detail = ''
    let failure
    child.stderr.on('data', chunk => { detail = (detail + chunk).slice(-4000) })
    child.once('error', error => { failure = error })
    child.once('close', code => code === 0 ? resolve() : reject(failure ?? new Error(detail || '媒体转换未完成，退出码：' + code)))
  })
}

export async function convertPreviewVideo(input, output, signal, forceTranscode = false) {
  try {
    if (forceTranscode) throw new Error('使用浏览器兼容编码')
    await ffmpeg(['-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', output], signal)
    return { type: 'video/mp4', conversion: 'remux' }
  } catch (error) {
    signal.throwIfAborted()
    if (error.code === 'ENOENT') throw error
    await ffmpeg(['-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', '-f', 'mp4', output], signal)
    return { type: 'video/mp4', conversion: 'transcode' }
  }
}

export async function convertPreviewOffice(input, output, extension, bytes, signal) {
  const { createConverter } = await import('@deepseek-ai/libreoffice-kit')
  const staged = output + '.' + extension
  let converter
  try {
    await copyFile(input, staged)
    signal.throwIfAborted()
    converter = await createConverter({ maxInputBytes: Math.max(1, bytes), maxOutputBytes: Number.MAX_SAFE_INTEGER,
      maxUncompressedBytes: Number.MAX_SAFE_INTEGER, maxArchiveEntries: Number.MAX_SAFE_INTEGER })
    const result = await converter.render({ inputPath: staged, outputPath: output }, signal)
    return { type: 'application/pdf', missingFonts: result.missingFonts }
  } finally {
    await converter?.dispose()
    await unlink(staged).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
}
