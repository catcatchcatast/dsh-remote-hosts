// Public change history: docs/PUBLIC-CHANGES.md
import { createElement, useCallback, useEffect, useRef, useState } from 'react'
import { preparePreview } from './prepare-preview.js'
// Public change history: docs/PUBLIC-CHANGES.md

const id = 'dsh-remote-hosts/media'
const audio = ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'flac', 'aac']
const video = ['mp4', 'm4v', 'webm', 'ogv', 'mkv']
const endpoint = '/api/remote-hosts/file-preview'

export function MediaPreview({ resourceAddress, useResource, content }) {
  const resource = useResource(resourceAddress)
  const source = resource.value
  const [view, setView] = useState({})
  const [transcode, setTranscode] = useState(false)
  const player = useRef(null)
  const errorProbe = useRef(null)
  const resume = useRef(null)
  const bindPlayer = useCallback(node => {
    if (player.current && player.current !== node) {
      errorProbe.current?.abort()
      errorProbe.current = null
      player.current.pause()
      player.current.removeAttribute('src')
      player.current.load()
    }
    player.current = node
  }, [])
  const revision = content.kind === 'renderer' ? content.revision : undefined
  const prepareAgain = () => {
    if (player.current) resume.current = { time: player.current.currentTime, playing: !player.current.paused }
    content.reload()
  }
  useEffect(() => {
    if (!view.url) return
    const controller = new AbortController()
    // 打开的暂停播放器也保留缓存；每天只读续期，关闭标签即撤销。
    const timer = setInterval(() => {
      fetch(view.url, { method: 'HEAD', signal: controller.signal }).then(response => {
        if (!controller.signal.aborted && response.status === 404) prepareAgain()
      }).catch(() => {})
    }, 24 * 60 * 60 * 1000)
    return () => { clearInterval(timer); controller.abort() }
  }, [view.url, content.reload])
  useEffect(() => {
    if (revision === undefined || !source?.absolutePath || resource.status !== 'live') return
    const controller = new AbortController()
    setView({})
    const sessionId = decodeURIComponent(new URL(resourceAddress).pathname.split('/')[2])
    preparePreview({ sessionId, path: source.absolutePath, transcode }, controller.signal).then(cached => {
      if (!controller.signal.aborted) setView({ url: location.protocol === 'dsh-app:' ? cached.mediaUrl : `${endpoint}/${cached.id}`,
        version: cached.version, conversion: cached.conversion })
    }).catch(error => {
      if (!controller.signal.aborted) { setView({ error: error.message }); content.failed() }
    })
    return () => {
      controller.abort()
    }
  }, [resourceAddress, source?.absolutePath, source?.version, resource.status, revision, transcode])
  if (view.error) return createElement('p', { role: 'alert' }, view.error)
  if (!view.url) return createElement('p', { role: 'status' }, '正在准备媒体预览…')
  const tag = audio.includes(source.absolutePath.split('.').at(-1).toLowerCase()) ? 'audio' : 'video'
  const failed = () => { setView({ error: '媒体无法播放，请检查文件是否完整、编码是否受浏览器支持。' }); content.failed() }
  return createElement(tag, { ref: bindPlayer, src: view.url, controls: true, preload: 'metadata',
    style: { width: '100%', height: tag === 'video' ? '100%' : undefined, maxHeight: '100%' },
    onLoadedMetadata: () => {
      content.loaded(view.version)
      if (resume.current) {
        player.current.currentTime = Math.min(resume.current.time, player.current.duration)
        if (resume.current.playing) player.current.play().catch(() => {})
        resume.current = null
      }
    },
    onError: event => {
      if (view.conversion === 'remux' && !transcode) { setTranscode(true); return }
      const node = event.currentTarget
      errorProbe.current ??= new AbortController()
      fetch(view.url, { method: 'HEAD', signal: errorProbe.current.signal }).then(response => {
        if (player.current !== node) return
        if (response.status === 404) prepareAgain()
        else failed()
      }).catch(() => { if (player.current === node) failed() })
    },
  })
}

export function installMediaPreview(ctx) {
  ctx.effect(() => ctx.documentPreviews.register({ id, extensions: [...audio, ...video],
    binaryExtensions: [...audio, ...video], title: () => '媒体', loading: 'renderer', wrap: false }))
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register({
    name: 'sidebar.right.tab.document', key: id,
  }, MediaPreview)))
}
