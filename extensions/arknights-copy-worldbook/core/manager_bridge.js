'use strict';
function buildCatalog(data, rows) {
  const byUid=new Map(rows.map(e=>[String(e.uid),e])),used=new Set();
  const actors=data?.actors?.actors || (Array.isArray(data?.actors)?data.actors:Object.values(data?.actorById||{}));
  const records=actors.map(actor=>{
    const all=[].concat(actor.states||[],actor.profile_variants||[]).map(f=>{
      const e=byUid.get(String(f.entry_id));if(!e)return null;used.add(String(e.uid));
      return {...e,entry_id:e.uid,source_uid:e.uid,form_id:String(e.uid),comment_pk:e.comment||e.name,label:f.label||e.comment,keys:e.keys||e.key||[],enabled:e.enabled??!e.disable};
    }).filter(Boolean);
    const generic=all.filter(f=>!/[（(]剧情[·・]/.test(f.comment_pk)),chapter=all.filter(f=>/[（(]剧情[·・]/.test(f.comment_pk));
    const defaults=generic.filter(f=>f.enabled),preferred=defaults.length===1?defaults[0]:generic.find(f=>String(f.entry_id)===String(actor.timeline_default_entry??actor.default_entry));
    generic.sort((a,b)=>Number(b===preferred)-Number(a===preferred));
    return {...actor,character_id:actor.actor_id,forms:generic,chapter_entries:chapter,default_form:preferred||null};
  });
  for(const e of rows){
    if(used.has(String(e.uid)))continue;
    const pk=(e.comment||e.name||'').trim(),match=pk.match(/^\[角色\]\s*[:：]\s*(.+?)(?:[（(](.*)[）)])?$/);
    if(!match)continue;
    const name=match[1].trim();let rec=records.find(a=>a.canonical_name===name);
    if(!rec){rec={actor_id:'native_'+e.uid,character_id:'native_'+e.uid,canonical_name:name,aliases:[name],forms:[],chapter_entries:[],default_form:null};records.push(rec);}
    const form={...e,entry_id:e.uid,source_uid:e.uid,form_id:String(e.uid),comment_pk:pk,label:match[2]||pk,keys:e.key||e.keys||[],enabled:e.enabled??!e.disable};
    if(/剧情[·・]/.test(match[2]||''))rec.chapter_entries.push(form);else{rec.forms.push(form);if(form.enabled&&!rec.default_form)rec.default_form=form;}
  }
  for(const rec of records)for(const f of rec.chapter_entries)f.chapter=(f.comment_pk.match(/[（(]剧情[·・]([^·・]+)[·・]/)||[])[1]||'';
  return records;
}
function createManager(plugin, host) {
  let actors = [], baseByUid = new Map(), catalog = [], dataVersion = null;
  const context = () => { const chat = host.chatId(); return { chat, store: plugin.loadSidecar(chat) }; };
  const find = name => actors.find(a => a.canonical_name === name || a.actor_id === name);
  function forms(actor) {
    const byUid = baseByUid;
    return [].concat(actor.states || [], actor.profile_variants || []).map(f => {
      const entry = byUid.get(String(f.entry_id)); return entry ? { ...f, ...entry, form_id: String(f.entry_id), entry_id: f.entry_id,
        source_uid: f.entry_id, comment_pk: entry.comment || entry.name, label: f.label || entry.comment, keys: entry.keys || entry.key || [] } : null;
    }).filter(Boolean);
  }
  const manager = {
    setData(data) {
      if(dataVersion === data?.data_version && baseByUid.size) return;
      actors = data?.actors?.actors || (Array.isArray(data?.actors) ? data.actors : Object.values(data?.actorById || {}));
      baseByUid = new Map(host.readBaseBook().map(e=>[String(e.uid),e])); dataVersion=data?.data_version;
      catalog=buildCatalog(data,[...baseByUid.values()]);actors=catalog;
      host.readCatalog=()=>catalog;
    },
    currentSave() {
      try { const {chat,store}=context(),ptr=host.readStoryMeta(chat);return {ok:true,key:host.identity().key,save:{currentChapter:store.currentChapter||'',snapshots:(store.snapshots||[]).map(s=>({...s,label:s.reason}))},book:ptr.book,mode:ptr.lore_mode}; }
      catch(e){return {ok:false,reason:e.message};}
    },
    listCharacters() {
      try { const {store}=context();return {ok:true,characters:actors.map(a=>{const rec=store.characters[a.actor_id],selected=rec?.forms?.[rec?.selection?.primary];return {
        name:a.canonical_name,character_id:a.actor_id,current_form:selected?.comment_pk||'',default_form:a.default_form?.comment_pk||'',
        influence:plugin.archiveProtection.isArchiveProtected(store,a.actor_id)?'已有动态档案/独立条目':'普通',manual_locked:!!store.manual?.[a.canonical_name],forms:[...a.forms,...a.chapter_entries].map(f=>({id:f.form_id,label:f.label})),pending:false};})}; }
      catch(e){return {ok:false,reason:e.message};}
    },
    async enable() { const chat=host.chatId();await host.prepare(chat);plugin.enableCloneMode(chat);await host.flush();return manager.currentSave(); },
    async selectForm(name,id) {
      const {chat,store}=context(),actor=find(name);if(!actor)throw Error('unknown_character');
      if(host.readStoryMeta(chat).lore_mode!=='clone')await manager.enable();
      const form=[...actor.forms,...actor.chapter_entries].find(f=>f.form_id===String(id));if(!form)throw Error('unknown_form');
      plugin.snapshot(chat,'manual_form:'+name);
      plugin.upsertCharacterForm(chat,{character_id:actor.actor_id,canonical_name:actor.canonical_name},form);
      plugin.switchForm(chat,actor.actor_id,{primary:form.form_id});
      const next=plugin.loadSidecar(chat);next.manual||={};next.manual[name]={locked:true};host.writeSidecar(chat,next);
      await host.flush();return {ok:true};
    },
    async setManual(name,locked){const {chat,store}=context();store.manual||={};if(locked)store.manual[name]={locked:true};else delete store.manual[name];host.writeSidecar(chat,store);await host.flush();return {ok:true};},
    async snapshot(reason){const {chat}=context();const result=plugin.snapshot(chat,reason);await host.flush();return result;},
    async rollback(id){const {chat}=context();const result=plugin.rollback(chat,id);if(result.ok)await host.flush();return result;}
  };return manager;
}
const api={createManager,buildCatalog};
if(typeof module!=='undefined'&&module.exports)module.exports=api;
if(typeof globalThis!=='undefined')globalThis.__ARK_CWB_MANAGER__=api;
