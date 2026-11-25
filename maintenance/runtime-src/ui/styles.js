'use strict';
const STORY_CSS = `
.ark-story-tab{box-sizing:border-box;display:flex;flex-direction:column;gap:14px;padding:20px clamp(12px,3vw,36px);width:100%;height:100%;min-height:0;overflow-y:auto;color:var(--color-on-surface,#dce8ed);font:400 16px/1.65 SimHei,"黑体","Microsoft YaHei",sans-serif}
.ark-story-tab *{box-sizing:border-box;min-width:0}
.ark-story-tab :is(h2,h3,h4,p){margin:0;overflow-wrap:anywhere}
.ark-story-tab h2{font-size:24px;font-weight:400}
.ark-story-tab h3{font-size:20px;font-weight:400}
.ark-story-tab h4{font-size:18px;font-weight:400}
.ark-story-tab .ark-story-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:6px 14px}
.ark-story-tab .ark-story-help{max-width:72ch}
.ark-story-tab .ark-story-note,.ark-story-tab .ark-story-path,.ark-story-tab .ark-story-side-label,.ark-story-tab .ark-story-empty{color:var(--color-on-surface-variant,#adbec8);overflow-wrap:anywhere}
.ark-story-tab .ark-story-routes,.ark-story-tab .ark-story-actions,.ark-story-tab .ark-story-routeentry{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.ark-story-tab button{font:inherit;min-height:44px;max-width:100%;border:1px solid var(--color-outline-variant,#384b57);border-radius:8px;padding:8px 14px;background:var(--color-surface-container,#20343f);color:inherit;cursor:pointer;display:inline-flex;justify-content:center;align-items:center;gap:6px;white-space:normal;overflow-wrap:anywhere;transition:background .15s,border-color .15s}
.ark-story-tab button:hover{background:var(--color-surface-container-high,#293e49)}
.ark-story-tab button[aria-pressed="true"],.ark-story-tab button.ark-primary{background:var(--color-primary,#255b70);color:var(--color-on-primary,#fff);border-color:#62cdd2}
.ark-story-tab button:disabled{opacity:.45;cursor:default}
.ark-story-tab :is(button,select,summary):focus-visible{outline:2px solid #62cdd2;outline-offset:2px}
.ark-story-tab select{font:inherit;width:100%;max-width:100%;min-height:44px;padding:8px 10px;border:1px solid #767676;border-radius:8px;background:#fff;color:#202124;color-scheme:light}
.ark-story-tab select option,.ark-story-tab select optgroup{background:#fff;color:#202124}
.ark-story-tab .ark-story-main{display:flex;flex-direction:column;gap:18px;border-top:1px solid var(--color-outline-variant,#384b57);padding-top:16px}
.ark-story-tab .ark-story-stack{display:flex;flex-direction:column;gap:12px;max-width:88ch}
.ark-story-tab .ark-story-meta{display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px 16px;color:var(--color-on-surface-variant,#adbec8)}
.ark-story-tab .ark-story-narrative{white-space:pre-wrap;overflow-wrap:anywhere}
.ark-story-tab .ark-story-goal{padding-left:12px;border-left:3px solid var(--color-primary,#4c8293)}
.ark-story-tab .ark-story-playguide{padding:10px 12px;border-radius:8px;background:color-mix(in srgb,var(--color-primary,#255b70) 18%,transparent);border:1px solid var(--color-primary,#4c8293)}
.ark-story-tab .ark-story-next{padding:10px 12px;border-radius:8px;background:var(--color-surface-container-low,#17232b);border:1px dashed var(--color-outline-variant,#384b57);overflow-wrap:anywhere}
.ark-story-tab .ark-story-footer{background:var(--color-surface-container-low,#17232b);padding:12px 14px;border-radius:8px;display:flex;flex-direction:column;gap:4px;border:1px solid var(--color-outline-variant,#384b57)}
.ark-story-tab .ark-story-clock{font-variant-numeric:tabular-nums}
.ark-story-tab .ark-story-sidebar{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));gap:20px}
.ark-story-tab .ark-story-castcard{display:flex;flex-direction:column;gap:8px;max-width:360px}
.ark-story-tab .ark-story-portrait{display:flex;align-items:center;justify-content:center;min-height:140px;background:var(--color-surface-container-high,#293e49);color:var(--color-on-surface-variant,#aac5d2);border-radius:8px;overflow:hidden}
.ark-story-tab .ark-story-portrait img{width:100%;max-height:300px;object-fit:contain;object-position:top center;display:block}
.ark-story-tab .ark-story-portrait .material-symbols-outlined{font-size:40px}
.ark-story-tab .ark-story-person{font-size:18px}
.ark-story-tab .ark-story-person-state{color:var(--color-primary-text,#aed9c0)}
.ark-story-tab .ark-story-badge{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;background:var(--color-surface-container-high,#293e49);color:var(--color-on-surface-variant,#adbec8);border:1px solid var(--color-outline-variant,#384b57)}
.ark-story-tab .ark-story-badge.ark-warn{color:var(--color-error,#ffb4ab);border-color:var(--color-error,#ffb4ab)}
.ark-story-tab .ark-story-section{display:flex;flex-direction:column;gap:10px;border-top:1px solid var(--color-outline-variant,#384b57);padding-top:14px}
.ark-story-tab .ark-story-section h4{display:flex;align-items:center;gap:6px}
.ark-story-tab .ark-story-catalog-path{padding:8px 10px;border-radius:8px;background:var(--color-surface-container,#20343f)}
.ark-story-tab .ark-story-preview{display:flex;flex-direction:column;gap:12px;padding:16px;border:2px solid var(--color-primary,#4c8293);border-radius:10px;background:var(--color-surface-container-low,#17232b)}
.ark-story-tab .ark-story-preview-list{display:flex;flex-direction:column;gap:10px;max-height:55vh;overflow:auto;padding-right:4px}
.ark-story-tab .ark-story-preview-scene{padding:12px;border:1px solid var(--color-outline-variant,#384b57);border-radius:8px;background:var(--color-surface-container,#20343f);overflow-wrap:anywhere}
.ark-story-tab .ark-story-preview-scene p{white-space:pre-wrap;margin:8px 0}
.ark-story-tab .ark-story-source-details{margin-top:8px;border-top:1px dashed var(--color-outline-variant,#384b57);padding-top:6px}
.ark-story-tab summary{cursor:pointer;min-height:44px;padding:8px 0}
.ark-story-tab .ark-story-fulltext{white-space:pre-wrap;overflow-wrap:anywhere;max-height:46vh;overflow:auto;font:inherit;margin:8px 0 2px;padding:10px 12px;border-radius:6px;background:var(--color-surface-container-low,#17232b)}
.ark-story-tab .ark-story-preview-title{font-size:18px}
.ark-story-tab .ark-story-storycard{display:flex;flex-direction:column;gap:8px;margin:8px 0 8px 12px;padding:12px;border:1px solid var(--color-outline-variant,#384b57);border-radius:8px;background:var(--color-surface-container-low,#17232b)}
.ark-story-tab .ark-story-storytitle{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.ark-story-tab .ark-story-era{display:flex;flex-direction:column;gap:8px}
.ark-story-tab .ark-story-era-label,.ark-story-tab button.ark-story-storytitle{display:block;width:100%;padding:12px;text-align:left;white-space:normal}
.ark-story-tab [aria-expanded="true"]{border-color:#62cdd2;background:rgba(98,205,210,.10)}
.ark-story-tab .ark-story-empty{padding:8px 0}
.ark-story-tab .ark-story-history{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.ark-story-tab .ark-story-history select{flex:1 1 240px}
.ark-story-tab .ark-story-summary-page,.ark-story-tab .ark-story-cast-page{display:flex;flex-direction:column;gap:14px}
.ark-story-tab .ark-story-reference-head{display:flex;flex-wrap:wrap;gap:10px 20px;align-items:center;justify-content:space-between}
.ark-story-tab .ark-story-summary-page .ark-story-reference-body{width:100%;max-width:82ch;align-self:center}
.ark-story-tab .ark-story-reference-body{overflow-wrap:anywhere}
.ark-story-tab .ark-story-reference-body .ark-story-fulltext{max-height:none;overflow:visible}
.ark-story-tab .ark-story-act-summary{border-top:1px solid var(--color-outline-variant,#384b57);padding:20px 0;display:flex;flex-direction:column;gap:10px}
.ark-story-tab .ark-story-act-summary p{white-space:pre-wrap}
.ark-story-tab .ark-story-scene-picker{padding:12px;border:1px solid var(--color-outline-variant,#384b57);border-radius:10px;background:var(--color-surface-container-low,#17232b)}
.ark-story-tab .ark-story-scene-controls{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.ark-story-tab .ark-story-scene-controls select{flex:2 1 240px;width:auto}
.ark-story-tab .ark-story-scene-controls select[aria-label="当前段"]{flex:1 1 160px}
.ark-story-tab .ark-story-scene-buttons{display:flex;gap:8px}
.ark-story-tab .material-symbols-outlined{font-family:'Material Symbols Outlined';font-weight:normal;font-style:normal;line-height:1;letter-spacing:normal;text-transform:none;display:inline-block;white-space:nowrap;word-wrap:normal;direction:ltr;-webkit-font-feature-settings:'liga';-webkit-font-smoothing:antialiased}
@media(max-width:560px){.ark-story-tab{padding:12px;gap:12px}.ark-story-tab .ark-story-preview{padding:12px}.ark-story-tab .ark-story-storycard{margin-left:0}.ark-story-tab .ark-story-scene-buttons{width:100%}.ark-story-tab .ark-story-scene-buttons button{flex:1}.ark-story-tab .ark-story-reference-head{align-items:flex-start}.ark-story-tab .ark-story-reference-head button{width:100%}}
`;

function el(tag, props, children) {
  const node = document.createElement(tag);
  if (props) for (const k of Object.keys(props)) {
    const v = props[k];
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset' && typeof v === 'object') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  if (children != null) for (const c of [].concat(children)) { if (c == null || c === false) continue; node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); }
  return node;
}
function icon(name, cls) { return el('span', { class: 'material-symbols-outlined' + (cls ? ' ' + cls : ''), 'aria-hidden': 'true', text: name }); }
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
function mountPortrait(container, cast, placeholder) {
  if (!cast.portrait_url || cast.placeholder) { placeholder(false); return; }
  const urls = [...new Set([cast.portrait_url, ...(cast.portrait_fallback_urls || [])])]
    .filter(url => typeof url === 'string' && /^https:\/\//i.test(url));
  if (!urls.length) { placeholder(true); return; }
  const img = el('img', { alt: cast.name || '', loading: 'lazy', referrerpolicy: 'no-referrer' });
  let index = 0;
  img.addEventListener('error', () => {
    index++;
    if (index < urls.length) img.src = urls[index]; else placeholder(true);
  });
  img.src = urls[index];
  container.appendChild(img);
}

const api = { STORY_CSS, el, icon, clear, mountPortrait };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.__ARK_UI_STYLES__ = api;
