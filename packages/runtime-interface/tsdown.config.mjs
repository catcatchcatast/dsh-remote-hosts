// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                       
                                                                                                                                     
import { defineConfig } from 'tsdown'
                                                                                                                                               

export default defineConfig({
  name: 'dsh-runtime-interface/client', entry: { client: 'src/client/entry.js' },
  outDir: 'lib', format: ['cjs'], platform: 'browser', target: 'es2022',
  dts: false, sourcemap: true, clean: true,
  deps: { neverBundle: ['@deepseek-ai/dsh-client-ui-primitives', 'react-dom'] },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "dsh-runtime-interface", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
