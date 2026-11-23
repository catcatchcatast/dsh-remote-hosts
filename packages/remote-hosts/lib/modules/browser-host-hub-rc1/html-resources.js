// Public change history: docs/PUBLIC-CHANGES.md
import { createReadStream } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { SAXParser, cssValues } from './third_party/html-parser.js'
import { createWorkspaceFileReader } from 'dsh-runtime-interface'

const pathsOf = value => /^[A-Za-z]:|\\/.test(value) ? path.win32 : path.posix
function referenced(value, base) {
  if (!value || value.startsWith('#') || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value)) return undefined
  const paths = pathsOf(base), clean = decodeURIComponent(value.split(/[?#]/)[0])
  return paths.resolve(paths.dirname(base), clean)
}
function cssReferences(text, add) {
  const parsed = cssValues(text)
  parsed.walk(node => {
    if (node.type === 'function' && node.value.toLowerCase() === 'url') add(cssValues.stringify(node.nodes).replace(/^(['"])(.*)\1$/, '$2'))
  })
  for (let i=0;i<parsed.nodes.length;i++) if (parsed.nodes[i].type==='word'&&parsed.nodes[i].value==='@import') {
    const next=parsed.nodes.slice(i+1).find(node=>node.type!=='space'&&node.type!=='comment')
    if(next?.type==='string')add(next.value)
  }
}

export async function htmlResources(cache, source, host, signal) {
  const current = signal
    const assets = {}, pending = [source], visited = new Set()
    while (pending.length) {
      current.throwIfAborted()
      const entry = pending.shift(), normalized = pathsOf(entry.path).normalize(entry.path)
      if(visited.has(normalized))continue
      visited.add(normalized);assets[normalized]=entry.id
      const extension = entry.path.split('.').at(-1).toLowerCase(), refs = new Set()
      const add = value => { const target=referenced(value,entry.path);if(target)refs.add(target) }
      if (extension==='html'||extension==='htm') {
        const parser=new SAXParser();parser.resume()
        let style=false,css=''
        parser.on('startTag', token => {
          const attrs=Object.fromEntries(token.attrs.map(a=>[a.name,a.value]))
          if(token.tagName==='style'){style=true;css=''}
          if(attrs.style)cssReferences(attrs.style,add)
          if(['img','script','audio','video','source','track'].includes(token.tagName)){
            add(attrs.src);add(attrs.poster)
            if(attrs.srcset)for(const item of attrs.srcset.split(','))add(item.trim().split(/\s+/)[0])
          }
          if(token.tagName==='link'&&attrs.rel?.split(/\s+/).includes('stylesheet'))add(attrs.href)
        })
        parser.on('text', token=>{if(style)css+=token.text})
        parser.on('endTag', token=>{if(token.tagName==='style'){style=false;cssReferences(css,add);css=''}})
        await pipeline(createReadStream(entry.file,{encoding:'utf8'}),parser,{signal:current})
      } else if(extension==='css')cssReferences(await readFile(entry.file,'utf8'),add)
      for(const target of refs){
        const paths=pathsOf(entry.path),relative=paths.relative(paths.dirname(entry.path),target)
        const asset=await cache.prepare(source.hostId,source.sessionId,relative,()=>createWorkspaceFileReader(host),current,entry.path)
        assets[paths.normalize(asset.path)]=asset.id
        if(/\.(?:css|html?)$/i.test(asset.path))pending.push(asset)
      }
    }
    const manifest=JSON.stringify(assets)
    const revision=createHash('sha256').update(manifest).digest('hex')
  return cache.derive(source, 'html-resources-v1:' + revision, async (_input, output) => {
    await writeFile(output,manifest,{flag:'wx',mode:0o600})
    return {type:'application/json'}
  },signal)
}
