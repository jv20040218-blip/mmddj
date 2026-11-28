'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),crypto=require('crypto');
const root=path.resolve(__dirname,'..'),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const codec=require('./png_card.cjs');
let runtime=fs.readFileSync(path.join(root,'runtime-v1.9.6-pre3.mjs'),'utf8');
const modules=[];
runtime=runtime.replace(/__def\(("[^"]+"),function\(module,exports,require\)\{\n([\s\S]*?)\n\}\);/g,(_,key)=>{
 const id=JSON.parse(key);modules.push(id);return '__def('+key+',function(module,exports,require){\n'+fs.readFileSync(path.join(root,'maintenance/runtime-src',id+'.js'),'utf8')+'\n});';
});assert.equal(modules.length,31);
const configRe=/globalThis\.__ARK_STORY_CONFIG__=(\{[^\n]*\});/,cfg=JSON.parse(runtime.match(configRe)[1]);
cfg.card_name='明日方舟·剧情完整版（1.9.6-pre4）';cfg.sparse_clone_only=true;
runtime=runtime.replace(configRe,'globalThis.__ARK_STORY_CONFIG__='+JSON.stringify(cfg)+';');
const build=sha(runtime).slice(0,12);runtime=runtime.replace(/globalThis\.__ARK_STORY_BUILD__="[a-f0-9]+";/,'globalThis.__ARK_STORY_BUILD__='+JSON.stringify(build)+';');
fs.writeFileSync(path.join(root,'runtime-v1.9.6-pre4.mjs'),runtime);
let cwb=fs.readFileSync(path.join(root,'extensions/arknights-copy-worldbook/core.bundle.js'),'utf8');
// Preserve the existing dependency order, replacing every wrapped source exactly once.
const moduleIds=[...cwb.matchAll(/^\/\/ ---- ((?:core|ui)\/[^\r\n]+) ----$/gm)].map(m=>m[1]);
let rebuilt=cwb.slice(0,cwb.indexOf('// ---- '));
const cwbIds=[...new Set([...moduleIds,'core/native_host','core/manager_bridge'])];
for(const id of cwbIds){
 const body=fs.readFileSync(path.join(root,'extensions/arknights-copy-worldbook',id+'.js'),'utf8');
 rebuilt+='// ---- '+id+' ----\n(function(){\nvar module={exports:{}};var exports=module.exports;\n'+body+'\n__cwb_modules['+JSON.stringify(id)+']=module.exports;\n__cwb_modules['+JSON.stringify(id.split('/').at(-1))+']=module.exports;\n})();\n';
}
rebuilt+='})(typeof globalThis!=="undefined"?globalThis:this);\n';
fs.writeFileSync(path.join(root,'extensions/arknights-copy-worldbook/core.bundle.js'),rebuilt);
let entry=fs.readFileSync(path.join(root,'extensions/arknights-copy-worldbook/index.js'),'utf8');
const oldHost=entry.indexOf('  function createHost() {'),oldPanel=entry.indexOf('  function mountPanel('),start=entry.indexOf('  async function start()');
if(oldHost>=0){assert(oldPanel>oldHost&&start>oldPanel);entry=entry.slice(0,oldHost)+entry.slice(start);}
// Remove the unused separate-API settings functions as well.
const settings=entry.indexOf('  function readSettings()'),chat=entry.indexOf('  async function start()');
if(settings>=0)entry=entry.slice(0,settings)+entry.slice(chat);
fs.writeFileSync(path.join(root,'extensions/arknights-copy-worldbook/index.js'),entry);
const manifest=JSON.parse(fs.readFileSync(path.join(root,'extensions/arknights-copy-worldbook/manifest.json'),'utf8'));manifest.version='1.0.1-pre4';
fs.writeFileSync(path.join(root,'extensions/arknights-copy-worldbook/manifest.json'),JSON.stringify(manifest,null,2)+'\n');
const original=codec.readCard(path.join(root,'cards/ark-story-v1.9.6-pre3.png')),card=structuredClone(original.card);
assert.equal(sha(original.buffer),'755b63eb5768850279da5a755d2287a94a54b35c37392aa200bb0ab619e4bc59');
card.name=card.data.name=cfg.card_name;card.character_version=card.data.character_version='1.9.6-pre4';
const script=card.data.extensions.tavern_helper.scripts.find(s=>s.name.startsWith('ARK_UI'));script.content=runtime;script.info+='\npre4 原生副本持久化、跨框架桥接和角色管理接线修复';
const png=codec.writeCard(original.buffer,original.chunk,card,path.join(root,'cards/ark-story-v1.9.6-pre4.png'));
const meta=JSON.parse(fs.readFileSync(path.join(root,'release.json'),'utf8'));
Object.assign(meta,{version:'1.9.6-pre4',tag:'v1.9.6-pre4',branch:'release/1.9.6-pre4',build_id:build,card_script_sha256:sha(runtime),runtime:'runtime-v1.9.6-pre4.mjs',installer:'maintenance/install_1_9_6_pre4.py'});
Object.assign(meta.card,{name:cfg.card_name,filename:'ark-story-v1.9.6-pre4.png',path:'cards/ark-story-v1.9.6-pre4.png',sha256:sha(png),script_sha256:sha(runtime),bytes:png.length});
meta.extensions['arknights-copy-worldbook'].manifest_version=manifest.version;
meta.changes=meta.changes.filter(s=>!s.startsWith('pre4：'));meta.changes.unshift('pre4：修复原生副本落盘与Chat Lore、父子页面桥接、动态档案逐轮钩子、真实角色管理状态、异步跨档保护和便携测试路径；剧情数据及三篇锁定文本逐字节不变');
meta.verification={model_calls:0,legacy_plugin_tests:141,native_integration_tests:10,story_structure_tests:17,browser:'isolated browser: manager,390px,form switch,reload,A/B books; real tablet pending'};
fs.writeFileSync(path.join(root,'release.json'),JSON.stringify(meta,null,2)+'\n');
const pmanifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));pmanifest.version=meta.version;fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify(pmanifest,null,2)+'\n');
let index=fs.readFileSync(path.join(root,'index.js'),'utf8').replaceAll("version: '1.9.6-pre3'","version: '1.9.6-pre4'");fs.writeFileSync(path.join(root,'index.js'),index);
for(const rel of ['data/story_runtime.json','data/base_worldbook.json'])assert.equal(sha(fs.readFileSync(path.join(root,rel))),meta[rel.includes('base_worldbook')?'worldbook':'data'].sha256);
console.log(JSON.stringify({version:meta.version,build,card_sha256:meta.card.sha256,runtime_sha256:meta.card.script_sha256,modules:modules.length,cwb_modules:cwbIds.length,data_unchanged:true}));
