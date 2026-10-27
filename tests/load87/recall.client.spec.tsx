// 公开打包追溯：docs/PUBLIC-CHANGES.md                                              
import {expect,it,vi,onTestFinished} from 'vitest'
import {createElement} from 'react'
import {Context} from '@deepseek-ai/cordis'
import {SlotRegistry} from '@public-official/packages/client/ui-renderer/src/client/registry.ts'
import {$selectDetectSpan,$replaceDetectSpanWithText} from '@public-official/packages/client/ui-conversation/src/client/input/editor/span-map.ts'
import {InputBar} from '@public-official/packages/client/ui-conversation/src/client/skeleton/InputBar.tsx'
import {act,fireEvent} from '@testing-library/react'
import {bench} from './official-input-fixture.tsx'
let Recall:any,bindInputRecall:any,installInputRecall:any
if(process.env.RECALL_LEAF) ({InputRecall:Recall,bindInputRecall,installInputRecall}=await import(/* @vite-ignore */ process.env.RECALL_LEAF))
export const human=(key:string,seq:number,text:string,kind='user')=>({key,kind,data:{kind,seq,source:{kind:'user'},content:[{type:'text',text}]}})
it('empty current composer ArrowUp recalls the last human text',()=>{
 const f=bench({Recall,chatNodes:[human('one',1,'first synthetic'),human('two',2,'last synthetic')]})
 act(()=>{f.textarea.focus()})
 fireEvent.keyDown(f.textarea,{key:'ArrowUp'})
 expect(f.shell.state.getSnapshot().draft).toBe('last synthetic')
 expect(f.textarea.textContent).toBe('last synthetic')
 expect(f.sink).not.toHaveBeenCalled()
})

const list=[human('old',1,'old synthetic'),human('new',2,'new synthetic')]
const text=(f:any)=>f.shell.state.getSnapshot().draft
const key=(f:any,name:string,extra:any={})=>fireEvent.keyDown(f.textarea,{key:name,...extra})
const write=(f:any,value:string)=>act(()=>{f.shell.setDraft(value)})
const focus=(f:any)=>act(()=>{f.textarea.focus()})
const select=(f:any,start:number,end=start)=>act(()=>{f.shell.editor.update(()=>{$selectDetectSpan({start,end})},{discrete:true})})
it('continuous Up/Down retains oldest boundary and returns to empty draft',()=>{
 const f=bench({Recall,chatNodes:list});focus(f)
 key(f,'ArrowUp');expect(text(f)).toBe('new synthetic')
 key(f,'ArrowUp');expect(text(f)).toBe('old synthetic')
 key(f,'ArrowUp');expect(text(f)).toBe('old synthetic')
 key(f,'ArrowDown');expect(text(f)).toBe('new synthetic')
 key(f,'ArrowDown');expect(text(f)).toBe('')
 expect(f.sink).not.toHaveBeenCalled()
})
it.each(['ArrowDown','Escape'])('%s restores a saved ordinary draft text',restore=>{
 const f=bench({Recall,chatNodes:list,draft:'unsent original'});focus(f)
 key(f,'ArrowUp');expect(text(f)).toBe('new synthetic')
 key(f,restore);expect(text(f)).toBe('unsent original')
})
it('edited recalled text is not overwritten by Down or Escape',()=>{
 const f=bench({Recall,chatNodes:list,draft:'unsent original'});focus(f);key(f,'ArrowUp')
 write(f,'manual edit');fireEvent.input(f.textarea)
 key(f,'ArrowDown');key(f,'Escape');expect(text(f)).toBe('manual edit')
})
it('recall leaves an explicit middle selection and Backspace native; structural edit reaches the shell',async()=>{
 const f=bench({Recall,chatNodes:[human('one',1,'abc123')]});focus(f);key(f,'ArrowUp')
 fireEvent.mouseDown(f.textarea,{button:0});select(f,2)
 expect(key(f,'Backspace')).toBe(true)
 // JSDOM没有Selection.modify/default deletion；真实鼠标退格由Root浏览器执行。
 await act(async()=>{await Promise.resolve()})
 expect(f.textarea.ownerDocument.getSelection()?.anchorOffset).toBe(2)
 act(()=>{f.shell.editor.update(()=>{$replaceDetectSpanWithText({start:1,end:2},'')},{discrete:true})})
 expect(text(f)).toBe('ac123')
})
it('ordinary nonempty multiline interior and selected ranges stay native',()=>{
 const f=bench({Recall,chatNodes:list,draft:'first\nmiddle\nlast'});focus(f)
 select(f,8);key(f,'ArrowUp');expect(text(f)).toBe('first\nmiddle\nlast')
 select(f,6,9);key(f,'ArrowUp');expect(text(f)).toBe('first\nmiddle\nlast')
 select(f,2);key(f,'ArrowUp');expect(text(f)).toBe('new synthetic')
 key(f,'Escape');expect(text(f)).toBe('first\nmiddle\nlast')
})
it.each([{isComposing:true},{keyCode:229}])('IME key facts %j do not recall',facts=>{
 const f=bench({Recall,chatNodes:list});focus(f);key(f,'ArrowUp',facts);expect(text(f)).toBe('')
})
it('composition lifecycle and the official ten-ms tail window do not recall',async()=>{
 const f=bench({Recall,chatNodes:list});focus(f)
 fireEvent.compositionStart(f.textarea);key(f,'ArrowUp');expect(text(f)).toBe('')
 fireEvent.compositionEnd(f.textarea,{data:''});key(f,'ArrowUp');expect(text(f)).toBe('')
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,16))})
 key(f,'ArrowUp');expect(text(f)).toBe('new synthetic')
})
it('real official keymap arbitration consumes a menu arrow before recall',()=>{
 const f=bench({Recall,chatNodes:list});focus(f)
 vi.spyOn(f.shell,'arbitrate').mockReturnValue('consumed')
 key(f,'ArrowUp');expect(text(f)).toBe('')
})
it('slash token is left to original input completion',()=>{
 const f=bench({Recall,chatNodes:list,draft:'/synthetic'});focus(f);select(f,10)
 key(f,'ArrowUp');expect(text(f)).toBe('/synthetic')
})
it('attachment and inline-reference drafts are not replaced',()=>{
 const attachment:any={kind:'image',id:'fixture-image',file:new File(['x'],'fixture.png',{type:'image/png'}),previewUrl:'blob:fixture-only'}
 const f=bench({Recall,chatNodes:list,attachments:[attachment]});focus(f)
 key(f,'ArrowUp');expect(text(f)).toBe('')
 act(()=>{f.shell.removeAttachment(attachment.id)})
 act(()=>{f.shell.insertReference({source:'fixture',ref:'r',label:'Ref',clipboardText:'reference'},{start:0,end:0,draftRev:f.shell.state.getSnapshot().draftRev})})
 expect(f.shell.state.getSnapshot().occurrences.length).toBe(1)
 const before=text(f);key(f,'ArrowUp');expect(text(f)).toBe(before)
})
it('only current canonical human/steering text blocks are extracted in seq order',()=>{
 const nodes=[human('last',8,'placeholder','steering'),human('first',2,'earlier'),{key:'sys',kind:'user',data:{seq:9,source:{kind:'compact-checkpoint'},content:[{type:'text',text:'not human'}]}},{key:'assistant',kind:'assistant',data:{seq:10,source:{kind:'user'},content:[{type:'text',text:'not input'}]}}]
 nodes[0].data.content=[{type:'text',text:'part one'},{type:'image',text:'not an image text'},{type:'text',text:'part two'}] as any
 const f=bench({Recall,chatNodes:nodes});focus(f);key(f,'ArrowUp');expect(text(f)).toBe('part one\npart two')
})
it('changing host/session on the resident InputBar never restores the previous draft',()=>{
 const a=bench({Recall,chatNodes:list,draft:'A draft',sessionId:'rh1.bG9jYWw.YQ'});focus(a);key(a,'ArrowUp')
 const b=bench({Recall,chatNodes:[human('b',1,'B history')],draft:'B draft',sessionId:'rh1.dWJ1bnR1.YQ'})
 b.view.unmount()
 a.view.rerender(createElement(InputBar,b.props));const current={...b,view:a.view,textarea:a.view.container.querySelector('[data-composer-input]')}
 focus(current);key(current,'ArrowDown');expect(text(b)).toBe('B draft')
 key(current,'ArrowUp');expect(text(b)).toBe('B history')
 key(current,'Escape');expect(text(b)).toBe('B draft')
 expect(text(a)).toBe('new synthetic')
})
it('same session new input generation resets browsing state',()=>{
 const a=bench({Recall,chatNodes:list,draft:'old generation',sessionId:'same'});focus(a);key(a,'ArrowUp')
 const b=bench({Recall,chatNodes:list,draft:'new generation',sessionId:'same'});b.view.unmount()
 a.view.rerender(createElement(InputBar,b.props));const current={...b,textarea:a.view.container.querySelector('[data-composer-input]')}
 focus(current);key(current,'Escape');expect(text(b)).toBe('new generation')
})
it('duplicate binding / late old disposer / unbind / HMR-like rebind has one owner',()=>{
 const f=bench({chatNodes:list});focus(f)
 const card=f.view.container.querySelector('[data-composer-card]')!
 const read=()=>({sessionId:'synthetic',input:f.shell.state.getSnapshot(),actions:f.shell.actions,chat:{nodes:{values:()=>list}}})
 const first=bindInputRecall(card,read),second=bindInputRecall(card,read)
 first();key(f,'ArrowUp');expect(text(f)).toBe('new synthetic')
 second();write(f,'');key(f,'ArrowUp');expect(text(f)).toBe('')
 const rebound=bindInputRecall(card,read);onTestFinished(rebound)
 key(f,'ArrowUp');expect(text(f)).toBe('new synthetic')
 rebound();write(f,'');key(f,'ArrowUp');expect(text(f)).toBe('')
})
it('real official slot declaration, collapse, re-declaration and plugin unload own the recall contribution',async()=>{
 const ctx=new Context(),registry=ctx.plugin(SlotRegistry);await registry
 onTestFinished(()=>registry.dispose())
 const slots:any=ctx.slots
 const writer=ctx.plugin({name:'synthetic-recall-test',inject:['slots'],apply:(scope:any)=>{scope.effect(()=>installInputRecall(scope))}})
 await writer.await()
 expect(slots.entries('conversation.input.overlay')).toHaveLength(0)
 const declare=()=>slots.register({name:'root',children:{'conversation.input.overlay':{kind:'list',scope:'session'}}},()=>null)
 const collapse=declare();expect(slots.entries('conversation.input.overlay')).toHaveLength(1)
 collapse();expect(slots.entries('conversation.input.overlay')).toHaveLength(0)
 declare();expect(slots.entries('conversation.input.overlay')).toHaveLength(1)
 await writer.dispose();expect(slots.entries('conversation.input.overlay')).toHaveLength(0)
})
it('same-stack rapid arrows keep one navigation and restore the original draft',()=>{
 const f=bench({Recall,chatNodes:list});focus(f)
 act(()=>{key(f,'ArrowUp');key(f,'ArrowUp')});expect(text(f)).toBe('old synthetic')
 act(()=>{key(f,'ArrowDown');key(f,'ArrowDown')});expect(text(f)).toBe('')
})
it('ordinary modified arrows pass without recall',()=>{
 const f=bench({Recall,chatNodes:list});focus(f)
 for(const modifier of ['ctrlKey','altKey','metaKey','shiftKey']){key(f,'ArrowUp',{[modifier]:true});expect(text(f)).toBe('')}
})
it('a completed synthetic send retires the saved draft before Escape',async()=>{
 const f=bench({Recall,chatNodes:list,draft:'original before send'});focus(f);key(f,'ArrowUp')
 await act(async()=>{key(f,'Enter');await Promise.resolve()})
 expect(f.sink).toHaveBeenCalledOnce();expect(text(f)).toBe('')
 key(f,'Escape');expect(text(f)).toBe('')
})
it('an empty paragraph before the caret is one logical newline, so middle-line Down remains native',()=>{
 const f=bench({Recall,chatNodes:[human('multi',1,'a\n\nb\nc')]});focus(f);key(f,'ArrowUp')
 select(f,4);key(f,'ArrowDown');expect(text(f)).toBe('a\n\nb\nc')
 select(f,6);key(f,'ArrowDown');expect(text(f)).toBe('')
})
