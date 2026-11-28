'use strict';

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderPanelHtml(status, settings, apiView) {
  const s = status || {};
  const cfg = settings || {};
  const view = apiView || {};
  const source = view.source || ((cfg.url && cfg.key) ? 'plugin_override' : 'tavern');
  const sourceLabel = source === 'plugin_override'
    ? '当前使用插件中单独填写的覆盖接口（可选）。'
    : (source === 'tavern'
      ? '当前使用酒馆已配置的生成接口，无需在此重复填写。'
      : '尚未读到酒馆生成接口。可先在酒馆完成 API 配置，或在下方可选栏填写覆盖接口。');
  const sourceDetail = [view.mainApi ? ('mainApi=' + view.mainApi) : '', view.model ? ('模型 ' + view.model) : ''].filter(Boolean).join(' · ');
  const warning = (s.banners || []).map(b => '<div class="ark-cwb-warn">' + escapeHtml(b.message || b.kind) + '</div>').join('');
  const chars = (s.overridden_characters || []).map(id => '<li>' + escapeHtml(id) + '</li>').join('') || '<li class="ark-cwb-muted">（尚未接管任何角色）</li>';
  const snaps = (s.snapshots || []).slice(-5).reverse().map(x => '<li>' + escapeHtml(x.reason) + ' · ' + escapeHtml(x.id) + '</li>').join('') || '<li class="ark-cwb-muted">（无快照）</li>';
  const mode = s.lore_mode || 'baseline';
  return [
    '<div class="ark-cwb-panel" id="ark-cwb-panel">',
    '<h3>明日方舟 · 稀疏克隆世界书</h3>',
    '<p class="ark-cwb-muted">底板世界书保持只读。启用后，当前存档通过官方 Chat Lore 绑定一本稀疏克隆书；动态层与回滚快照存放在侧车，不写入剧情热路径。</p>',
    warning,
    s.warning ? '<div class="ark-cwb-warn">降级：克隆书缺失，已回退为底板只读投影，不会改写底板。</div>' : '',
    '<div class="ark-cwb-row"><strong>当前模式：</strong><span>' + escapeHtml(mode) + '</span></div>',
    '<div class="ark-cwb-row"><strong>绑定 Chat Lore：</strong><span>' + escapeHtml(s.bound_lore || s.book || '（无）') + '</span></div>',
    '<div class="ark-cwb-row">',
    '<button type="button" data-ark-cwb="enable">为当前存档启用独立世界书</button>',
    '<button type="button" data-ark-cwb="disable">关闭克隆模式</button>',
    '<button type="button" data-ark-cwb="refresh">刷新状态</button>',
    '</div>',
    '<h4>已接管角色</h4><ul class="ark-cwb-list">' + chars + '</ul>',
    '<div class="ark-cwb-row">',
    '<input type="text" data-ark-cwb-input="character" placeholder="角色 ID（精确主键）">',
    '<input type="text" data-ark-cwb-input="form" placeholder="形态 entry_id">',
    '<button type="button" data-ark-cwb="switch">切换形态（本地编译）</button>',
    '<button type="button" data-ark-cwb="merge">合并时间线</button>',
    '<button type="button" data-ark-cwb="rollback">一键回滚</button>',
    '<button type="button" data-ark-cwb="summarize">按聊天更新档案</button>',
    '</div>',
    '<h4>最近快照</h4><ul class="ark-cwb-list">' + snaps + '</ul>',
    '<h4>模型接口</h4>',
    '<p class="ark-cwb-muted">设计修订、按聊天更新档案、合并时间线默认走酒馆当前用于生成的配置（SillyTavern 1.19.0 的 getContext().generateRaw，以及 mainApi / chatCompletionSettings）。密钥仍由酒馆服务端保管，本面板不会再要求填一套。下面三栏只是可选覆盖：都留空即用酒馆配置。</p>',
    '<div class="ark-cwb-row">' + escapeHtml(sourceLabel) + (sourceDetail ? ' <span class="ark-cwb-muted">(' + escapeHtml(sourceDetail) + ')</span>' : '') + '</div>',
    '<h4>可选覆盖（通常不必填）</h4>',
    '<div class="ark-cwb-row"><label>URL <input type="text" data-ark-cwb-input="url" value="' + escapeHtml(cfg.url || '') + '" placeholder="留空则用酒馆配置"></label></div>',
    '<div class="ark-cwb-row"><label>Model <input type="text" data-ark-cwb-input="model" value="' + escapeHtml(cfg.model || '') + '" placeholder="仅覆盖时填写"></label></div>',
    '<div class="ark-cwb-row"><label>API Key <input type="password" data-ark-cwb-input="key" value="' + escapeHtml(cfg.key ? '••••••' : '') + '" autocomplete="off" placeholder="留空则用酒馆配置"></label>',
    '<button type="button" data-ark-cwb="save-api">保存可选覆盖</button></div>',
    '</div>'
  ].join('');
}

const api = { escapeHtml, renderPanelHtml };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.__ARK_CWB_PANEL__ = api;
