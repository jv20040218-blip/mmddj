'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),vm=require('node:vm');
const {createNativeHost}=require('../extensions/arknights-copy-worldbook/core/native_host');
const Factory=require('../extensions/arknights-copy-worldbook/core/plugin');
const clone=x=>JSON.parse(JSON.stringify(x));
function fixture(){
 let current='A';const db=new Map(),meta={A:{variables:{}},B:{variables:{}}},calls={write:0,save:0},cards=[{avatar:'ark.png',data:{extensions:{world:'BASE'}}}];
 const root={SillyTavern:{getContext:()=>({characters:cards,characterId:0,getCurrentChatId:()=>current,chatMetadata:meta[current]})}};
 const baseline={entries:{1:{uid:1,comment:'[角色]:塔露拉',content:'官方正文',key:['塔露拉'],keysecondary:[],disable:false}}};
 const io={baseline:async()=>clone(baseline),read:async name=>clone(db.get(name)),write:async(name,data)=>{calls.write++;db.set(name,clone(data));},saveChat:async()=>{calls.save++;}};
 const host=createNativeHost(root,{io}),plugin=Factory.createCopyWorldbookPlugin(host);
 return{host,plugin,db,meta,calls,root,io,baseline,setCurrent:x=>{current=x;},newHost:()=>createNativeHost(root,{io})};
}
test('native clone survives reload, uses correct Chat Lore field and never changes baseline',async()=>{
 const f=fixture(),before=JSON.stringify(f.baseline);await f.host.prepare('A');const en=f.plugin.enableCloneMode('A');
 f.host.writeBook(en.book,[{uid:100001,source_uid:1,keys:['塔露拉'],content:'存档经历',enabled:true}]);await f.host.flush();
 assert.equal(f.meta.A.world_info,en.book);assert(!f.meta.A.worldinfo);assert.equal(f.calls.write,1);assert.equal(f.calls.save,1);assert.equal(JSON.stringify(f.baseline),before);
 const reloaded=f.newHost();await reloaded.prepare('A');assert.equal(reloaded.readBook(en.book)[0].content,'存档经历');
 const native=f.db.get(en.book);assert(native.entries[100001].keysecondary);assert.equal(native.entries[2147483000].disable,true);
});
test('chat change during native write cannot bind or save into the other chat',async()=>{
 const f=fixture();await f.host.prepare('A');f.plugin.enableCloneMode('A');let release;
 f.io.write=async(name,data)=>{await new Promise(r=>release=r);f.db.set(name,clone(data));};
 const pending=f.host.flush();await new Promise(r=>setImmediate(r));f.setCurrent('B');release();
 await assert.rejects(pending,/chat_changed_during_commit/);assert.equal(f.meta.B.world_info,undefined);assert.equal(f.calls.save,0);
});
test('failed native save/readback does not report a committed clone',async()=>{
 const f=fixture();await f.host.prepare('A');f.plugin.enableCloneMode('A');f.io.write=async()=>{throw Error('offline');};
 await assert.rejects(f.host.flush(),/offline/);assert.equal(f.meta.A.world_info,undefined);assert.equal(f.calls.save,0);
});
test('base book and unrelated clone are not writable',async()=>{
 const f=fixture();await f.host.prepare('A');assert.throws(()=>f.host.createBook('BASE',[]),/base_write/);
 assert.throws(()=>f.host.writeBook('other',[]),/not_current_clone/);
});
test('unchanged clone contents do not repeat native worldbook writes',async()=>{
 const f=fixture();await f.host.prepare('A');const e=f.plugin.enableCloneMode('A');const rows=[{uid:100001,source_uid:1,keys:['塔露拉'],content:'same',enabled:true}];
 f.host.writeBook(e.book,rows);await f.host.flush();f.host.writeBook(e.book,rows);await f.host.flush();assert.equal(f.calls.write,1);
});
test('late summarizer result is rejected after changing to another chat',async()=>{
 const f=fixture();await f.host.prepare('A');f.plugin.enableCloneMode('A');let resolve,started;
 const waiting=new Promise(r=>started=r);
 const pending=f.plugin.summarizeIntoProfile('A','tal',{}, {generateRaw:async()=>{started();return new Promise(r=>resolve=r);}});
 await waiting;f.setCurrent('B');await f.host.prepare('B');
 resolve(JSON.stringify(Object.fromEntries(Factory.Schema.SECTIONS.map(k=>[k,'test']))));
 const result=await pending;assert.equal(result.reason,'chat_scope_changed');assert.equal(f.meta.B.world_info,undefined);
});
test('real chat event payload receives the archive summary in its chat messages',()=>{
 const host=Factory.createMemoryHost({chatId:'A'}),plugin=Factory.createCopyWorldbookPlugin(host);plugin.enableCloneMode('A');
 const payload={chat:[{role:'user',content:'继续'}]};plugin.attachArchiveSummaryPrompt('A',payload);
 assert.equal(payload.chat.length,2);assert.match(payload.chat[1].content,/存档摘要区/);assert.equal(payload.prompt,undefined);
});
test('iframe bridge finds the parent singleton',()=>{
 const fake={parent:{__ARK_COPY_WORLDBOOK__:{marker:true}}};vm.createContext(fake);
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../maintenance/runtime-src/core/phase_b_bridge.js'),'utf8'),fake);
 assert.equal(fake.__ARK_CORE_PHASE_B__.getPlugin().marker,true);
});
test('message update hooks resolve the plugin instead of a free variable',()=>{
 const src=fs.readFileSync(path.join(__dirname,'../maintenance/runtime-src/adapter/index.js'),'utf8');
 const body=src.slice(src.indexOf('function onHostEvent('),src.indexOf('function init()'));
 const fake={PhaseB:{getPlugin:()=>null},syncChat:()=>true,readMessage:()=>null};vm.createContext(fake);vm.runInContext(body,fake);
 assert.doesNotThrow(()=>vm.runInContext('onHostEvent("MESSAGE_UPDATED",[1])',fake));
});
