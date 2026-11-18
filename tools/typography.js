'use strict';
const ROOT_SELECTORS = ['#ark-ui-root', '.ark-global-statusbar-mount-point', '.ark-story-reply-status-host', '.ark-startup-container', '.ark-story-tab', '.ark-story-status', '.ark-story-loading'];
const roots = ':is(' + ROOT_SELECTORS.join(',') + ')';
// Compiled console rules already combine ID selectors with !important.
const scope = roots + roots;
const text = ':where(:not([class*="material-symbols"]):not([class*="material-icons"]))';
const TYPOGRAPHY_CSS = `
${scope}{--font-body:SimHei,"黑体","Microsoft YaHei",sans-serif;--font-display:var(--font-body)}
${scope}${text},${scope} *${text}{font-family:SimHei,"黑体","Microsoft YaHei",sans-serif!important;font-size:16px!important;font-weight:400!important;line-height:1.65!important}
${scope} :is(h1,h2,.ark-story-title,.ark-console-heading){font-size:24px!important;line-height:1.35!important}
${scope} :is(h3,.ark-story-scene){font-size:20px!important;line-height:1.4!important}
${scope} :is(h4,h5,h6,.ark-story-preview-title,.ark-story-person){font-size:18px!important;line-height:1.45!important}
${scope} :is(button,select,summary){min-height:44px!important}
${scope} :is(button,select,input,textarea){max-width:100%;min-width:0}
${scope} :is(h1,h2,h3,h4,h5,h6,p){overflow-wrap:anywhere}
`;
function mountTypography(doc) {
  if (doc.__ARK_PLUGIN_TYPOGRAPHY__) return doc.__ARK_PLUGIN_TYPOGRAPHY__;
  const style = doc.createElement('style');
  style.id = 'ark-plugin-typography';
  style.textContent = TYPOGRAPHY_CSS;
  doc.head.appendChild(style);
  const handle = {
    refresh() {},
    stop() {
      if (style.parentNode) style.parentNode.removeChild(style);
      if (doc.__ARK_PLUGIN_TYPOGRAPHY__ === handle) delete doc.__ARK_PLUGIN_TYPOGRAPHY__;
    }
  };
  doc.__ARK_PLUGIN_TYPOGRAPHY__ = handle;
  return handle;
}
const api = { mountTypography };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.__ARK_UI_TYPOGRAPHY__ = api;
