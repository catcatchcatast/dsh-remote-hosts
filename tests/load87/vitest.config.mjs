// 公开打包追溯：docs/PUBLIC-CHANGES.md                                              
import fs from 'node:fs'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
const source=process.env.DSH_OFFICIAL_021_SOURCE
if (!source) throw Error('Set DSH_OFFICIAL_021_SOURCE to official 0.2.1-rc.2 sources')
const req=createRequire(new URL('../../package.json',import.meta.url))
const {default:paths}=await import(pathToFileURL(req.resolve('vite-tsconfig-paths')).href)
const {standardDecoratorPlugin,vitestExecArgv}=await import(pathToFileURL(source+'/vitest.shared.ts').href)
const mapped=Object.entries(JSON.parse(fs.readFileSync(new URL('./official-test-paths.json',import.meta.url),'utf8'))).map(([key,values])=>({find:new RegExp('^'+key.replaceAll('.','[.]').replaceAll('*','(.*)')+'$'),replacement:source+'/'+values[0].replace('*','$1')}))
export default {root:new URL('.',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'),plugins:[paths({projects:[source+'/tsconfig.base.json']}),standardDecoratorPlugin()],resolve:{dedupe:['react','react-dom'],alias:[{find:/^@public-official\/(.*)$/,replacement:source+'/$1'},...mapped,{find:'lexical',replacement:source+'/node_modules/lexical'},{find:'react',replacement:source+'/node_modules/react'},{find:'react-dom',replacement:source+'/node_modules/react-dom'},{find:'@testing-library/react',replacement:source+'/node_modules/@testing-library/react/dist/index.js'},{find:'vitest',replacement:req.resolve('vitest/package.json').replace(/package.json$/,'dist/index.js')}]},test:{include:['recall.client.spec.tsx'],environment:'jsdom',pool:'threads',maxWorkers:1,fileParallelism:false,coverage:{enabled:false},execArgv:vitestExecArgv,testTimeout:10000,hookTimeout:10000}}
