// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                        
                                                                                                                                                           
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'tsdown'
                                                                            
const mobileFileBackend = new Set(['mobile.js', 'upload.js', 'detect.js', 'file-browser.js'])
const root = path.dirname(fileURLToPath(import.meta.url))
const workspace = path.resolve(root, '../..')
const { modules } = JSON.parse(fs.readFileSync(path.join(root, 'module-sources.json'), 'utf8'))
// Only these two cross-module imports exist. Everything else keeps its original identity.
const replacements = {
  'dsh-mobile-interactions-compat-rc1/carrier': '../mobile-interactions-compat-rc1/carrier.js',
  'dsh-rc1-host-carriers': '../rc1-host-carriers/index.js',
}
for (const module of modules) {
  const source = path.join(workspace, 'packages', module, 'src')
  const target = path.join(root, 'lib/modules', module)
  // Fixed generated output only; removed source files cannot survive a rebuild.
  if (!/^[a-z0-9-]+$/.test(module)) throw Error('REMOTE_MODULE_SOURCE_INVALID')
  fs.rmSync(target, { recursive: true, force: true })
  fs.mkdirSync(target, { recursive: true })
  for (const relative of fs.readdirSync(source, { recursive: true })) {
    const file = path.join(source, relative)
    if (relative.split(path.sep)[0] === 'client') continue
    if (module === 'file-upload-compat-rc1' && !mobileFileBackend.has(relative)) continue
    const stat = fs.lstatSync(file)
    if (stat.isSymbolicLink()) throw Error('REMOTE_MODULE_SOURCE_LINK_FORBIDDEN')
    if (!stat.isFile()) continue
    const output = path.join(target, relative)
    fs.mkdirSync(path.dirname(output), { recursive: true })
    let bytes = fs.readFileSync(file)
    if (/\.(?:js|mjs)$/.test(relative)) {
      let text = bytes.toString('utf8')
      for (const [specifier, replacement] of Object.entries(replacements)) text = text.replaceAll("'" + specifier + "'", "'" + replacement + "'").replaceAll('"' + specifier + '"', '"' + replacement + '"')
      bytes = Buffer.from(text)
    }
    fs.writeFileSync(output, bytes)
  }
}
await build({
  config: false, cwd: root, name: 'dsh-remote-hosts/client',
  entry: { client: path.join(root, 'src/client.js') }, outDir: path.join(root, 'lib'),
  format: ['cjs'], platform: 'browser', target: 'es2022', dts: false,
  sourcemap: true, clean: false,
  deps: { neverBundle: ['@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-store', 'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', 'dsh-runtime-interface', '@deepseek-ai/dsh-client-locale/client', '@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-client-ui-slots'] },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "dsh-remote-hosts", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
