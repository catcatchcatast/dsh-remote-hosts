
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { defineConfig } from 'tsdown'

const PACKAGE_ID = '@deepseek-ai/dsh-client-ui-directory-picker-browse'
const CSS_PREFIX = '\0dsh-rc1-directory-picker-css:'
const CSS_SUFFIX = '.mjs'

/** Keep the package build self-contained; dsh-core remains an external runtime. */
const cssPlugin = {
  name: `${PACKAGE_ID}-css-modules`,
  resolveId(source, importer) {
    if (!source.endsWith('.module.css') || importer === undefined) return null
    return CSS_PREFIX + resolve(dirname(importer), source) + CSS_SUFFIX
  },
  async load(virtualId) {
    if (!virtualId.startsWith(CSS_PREFIX)) return null
    const file = virtualId.slice(CSS_PREFIX.length, -CSS_SUFFIX.length)
    const original = await readFile(file, 'utf8')
    const names = [...new Set([...original.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/g)].map(match => match[1]))]
    const map = Object.fromEntries(names.map(name => [name, `${PACKAGE_ID.replace(/[^A-Za-z0-9_-]/g, '-')}-${name}`]))
    const css = original.replace(/\.([A-Za-z_][A-Za-z0-9_-]*)/g, (_match, name) => `.${map[name] ?? name}`)
    const styleKey = `${PACKAGE_ID}/${basename(file)}`
    return [
      `const css = ${JSON.stringify(css)};`,
      `const styleKey = ${JSON.stringify(styleKey)};`,
      'if (typeof document !== "undefined" && ![...document.querySelectorAll("style[data-plugin-css]")].some(tag => tag.dataset.pluginCss === styleKey)) {',
      '  const tag = document.createElement("style");',
      `  tag.dataset.plugin = ${JSON.stringify(PACKAGE_ID)};`,
      '  tag.dataset.pluginCss = styleKey;',
      '  tag.textContent = css;',
      '  document.head.appendChild(tag);',
      '}',
      `export default ${JSON.stringify(map)};`,
    ].join('\n')
  },
}

const clientExternals = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis', '@deepseek-ai/dsh-api-remotes',
  '@deepseek-ai/dsh-api-remotes/client', '@deepseek-ai/dsh-client-locale/client',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-workspace/client',
]

const host = {
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2022',
  dts: false,
  clean: true,
  outExtensions: () => ({ js: '.js' }),
  external: [/^@deepseek-ai\//, 'node:*'],
}

const client = {
  name: `${PACKAGE_ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: ['cjs'],
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: { neverBundle: clientExternals, alwaysBundle: [/^clsx$/] },
  plugins: [cssPlugin],
  define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production') },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default defineConfig(({ env }) => env?.DSH_BUILD_FACE === 'host' ? host : [host, client])
