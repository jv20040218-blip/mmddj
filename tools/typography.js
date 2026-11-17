'use strict';
// Minimum matches the history snapshot heading. Larger text stays larger.
const REFERENCE = { size:14, weight:600 };
const ROOT_SELECTORS = ['#ark-ui-root','.ark-global-statusbar-mount-point','.ark-story-reply-status-host','.ark-startup-container'];

function fontFloor(font, reference=REFERENCE) {
  const size=parseFloat(font.fontSize),rawWeight=font.fontWeight;
  const weight=rawWeight==='bold'?700:rawWeight==='normal'?400:parseFloat(rawWeight);
  return {size:Math.max(Number.isFinite(size)?size:reference.size,reference.size),weight:Math.max(Number.isFinite(weight)?weight:400,reference.weight)};
}
function getRoots(doc) {
  return [...new Set(ROOT_SELECTORS.flatMap(selector=>Array.from(doc.querySelectorAll(selector))))];
}
function enforceTypography(doc, options={}) {
  const compute=options.getStyle || (doc.defaultView && doc.defaultView.getComputedStyle && (node=>doc.defaultView.getComputedStyle(node)));
  if(!compute)return {changed:0,reference:REFERENCE};
  const heading=doc.querySelector('.ark-story-history-title');
  const measured=heading?compute(heading):null;
  const reference=measured?fontFloor(measured):REFERENCE;
  const all=new Set();
  for(const root of getRoots(doc)){all.add(root);for(const node of root.querySelectorAll('*'))all.add(node);}
  const updates=[];
  // Read the whole batch before writing, avoiding per-element layout thrash.
  for(const node of all){
    const style=compute(node),target=fontFloor(style,reference);
    const size=parseFloat(style.fontSize),weight=style.fontWeight==='bold'?700:style.fontWeight==='normal'?400:parseFloat(style.fontWeight);
    if(size<target.size || !Number.isFinite(weight) || weight<target.weight)updates.push({node,style,target,size,weight});
  }
  const write=(node,key,value)=>{if(node.style.setProperty)node.style.setProperty(key,value,'important');else node.style[key.replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=value;};
  for(const {node,style,target,size,weight} of updates){
    if(size<target.size){
      write(node,'font-size',target.size+'px');
      const line=parseFloat(style.lineHeight);
      if(Number.isFinite(line)&&line<target.size*1.25)write(node,'line-height','1.5');
    }
    if(!Number.isFinite(weight)||weight<target.weight)write(node,'font-weight',String(target.weight));
  }
  return {changed:updates.length,reference};
}
function mountTypography(doc,options={}) {
  if(doc.__ARK_PLUGIN_TYPOGRAPHY__)return doc.__ARK_PLUGIN_TYPOGRAPHY__;
  const view=doc.defaultView||{},Observer=options.Observer||view.MutationObserver;
  const request=options.requestFrame||view.requestAnimationFrame?.bind(view)||(fn=>setTimeout(fn,0));
  const cancel=options.cancelFrame||view.cancelAnimationFrame?.bind(view)||clearTimeout;
  let frame=null,stopped=false;
  const refresh=()=>{if(!stopped)return enforceTypography(doc,options);};
  const schedule=()=>{if(!stopped&&frame===null)frame=request(()=>{frame=null;refresh();});};
  const inScope=node=>{
    for(let n=node;n;n=n.parentNode){
      if(n.id==='ark-ui-root')return true;
      if(String(n.className||'').split(/\s+/).some(c=>['ark-global-statusbar-mount-point','ark-story-reply-status-host','ark-startup-container'].includes(c)))return true;
    }
    return false;
  };
  const observer=Observer?new Observer(records=>{
    if(records.some(record=>inScope(record.target)||Array.from(record.addedNodes||[]).some(node=>inScope(node)||node.querySelector&&ROOT_SELECTORS.some(s=>node.querySelector(s)))))schedule();
  }):null;
  if(observer)observer.observe(doc.body,{childList:true,subtree:true});
  if(view.addEventListener)view.addEventListener('resize',schedule);
  const handle={refresh,stop(){stopped=true;if(observer)observer.disconnect();if(frame!==null)cancel(frame);if(view.removeEventListener)view.removeEventListener('resize',schedule);delete doc.__ARK_PLUGIN_TYPOGRAPHY__;}};
  doc.__ARK_PLUGIN_TYPOGRAPHY__=handle;refresh();return handle;
}
const api={REFERENCE,ROOT_SELECTORS,fontFloor,enforceTypography,mountTypography};
if(typeof module!=='undefined'&&module.exports)module.exports=api;
if(typeof globalThis!=='undefined')globalThis.__ARK_UI_TYPOGRAPHY__=api;
