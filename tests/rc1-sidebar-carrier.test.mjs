import test from 'node:test'
import assert from 'node:assert/strict'
import { createCarrier } from '../packages/mobile-interactions-compat-rc1/src/carrier.js'
test('sidebar Files carrier forwards only scoped file routes with its own credentials', async t => {
 const calls=[]
 t.mock.method(globalThis,'fetch', async (url,init)=>{calls.push({url:String(url),init});return calls.length===1?new Response(null,{status:303,headers:{Location:'/', 'Set-Cookie':'session=server; HttpOnly'}}):new Response('ok')})
 const carrier=await createCarrier('http://127.0.0.1:3081','http://127.0.0.1:3081/?token=test',null,new AbortController().signal)
 for(const method of ['session.cwd','fs.tree','fs.search','fs.read','fs.write']){
  await carrier.raw('/sidebar/api/'+method,{method:'POST',body:JSON.stringify({sessionId:'raw',cwd:'/home/test'}),headers:{Cookie:'client',Authorization:'client','content-type':'application/json'}})
  const call=calls.at(-1);assert.equal(call.init.headers.get('cookie'),'session=server');assert.equal(call.init.headers.has('authorization'),false);assert.equal(JSON.parse(call.init.body).cwd,'/home/test')
 }
 await carrier.raw('/sidebar/upload?sessionId=raw',{method:'POST',body:'bytes'})
 await carrier.raw('/sidebar/file?sessionId=raw&path=a',{method:'GET'})
 for(const route of ['/sidebar/api/git.status','/sidebar/api/settings.get','/sidebar/api/fs.tree/extra','/sidebar/api/%66s.tree','https://other.invalid/sidebar/api/fs.tree'])await assert.rejects(carrier.raw(route,{method:'POST'}),/ROUTE_INVALID/)
 await assert.rejects(carrier.raw('/sidebar/api/fs.write',{method:'GET'}),/METHOD_INVALID/)
})

test('session list carrier permits a slow catalog while keeping write deadlines unchanged', async t => {
  const deadlines = []
  t.mock.method(AbortSignal, 'timeout', ms => { deadlines.push(ms); return new AbortController().signal })
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    if (!init.body) return new Response(null, { status: 303, headers: { Location: '/', 'Set-Cookie': 'session=test' } })
    const request = JSON.parse(init.body)
    return Response.json({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: { items: [] } } })
  })
  const carrier = await createCarrier('http://127.0.0.1:3081', 'http://127.0.0.1:3081/?token=test', null, new AbortController().signal)
  await carrier.call('session/list', { args: { _request: {} } })
  await carrier.call('session/prompt', { args: {} })
  assert.deepEqual(deadlines, [10000, 60000, 15000])
})
