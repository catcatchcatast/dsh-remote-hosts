import { defineConfig } from 'tsdown'

export default defineConfig({
  name: 'dsh-runtime-interface/client', entry: { client: 'src/client/index.js' },
  outDir: 'lib', format: ['cjs'], platform: 'browser', target: 'es2022',
  dts: false, sourcemap: true, clean: true,
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "dsh-runtime-interface", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
