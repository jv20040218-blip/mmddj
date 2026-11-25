// 运行数据加载器（插件版专用）：56 MB 原文库不进卡，改由插件目录按候选路径取回。
// 设计约束：纯函数 + 可注入 fetch，便于 node 测试；不依赖 document/localStorage。
'use strict';

const DEFAULT_DIR = 'ark-story';
const DEFAULT_FILE = 'story_runtime.json';

// 候选顺序：显式覆盖 > 绝对路径 > 相对路径 > 带 origin 的绝对地址。
// 酒馆静态目录固定为 /scripts/extensions/third-party/<dir>/，相对路径兜底给反代改写前缀的部署。
function candidateUrls(cfg, origin) {
  const c = cfg || {};
  const dir = c.extension_dir || DEFAULT_DIR;
  const file = c.data_file || DEFAULT_FILE;
  const rel = 'scripts/extensions/third-party/' + dir + '/data/' + file;
  const out = [];
  if (c.data_url) out.push(c.data_url);
  out.push('/' + rel, rel, './' + rel);
  if (origin) out.push(String(origin).replace(/\/+$/, '') + '/' + rel);
  return out.filter((v, i) => out.indexOf(v) === i);
}

// 逐个候选尝试；只有解析出带 corpus 的对象才算成功，避免把 404 页面或错误 JSON 当数据。
async function packedStore(mode, packed, bytes) {
  if (typeof indexedDB === 'undefined') return null;
  let db;
  try {
    const key = new URL('.', new URL(packed.url, location.href)).href;
    db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('ark-story-runtime-cache', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('runtime');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('runtime', mode), store = tx.objectStore('runtime');
      const req = mode === 'readonly' ? store.get(key) : store.put({ ...packed, bytes }, key);
      tx.oncomplete = () => {
        const value = req.result;
        resolve(value?.url === packed.url && value.version === packed.version ? value.bytes : null);
      };
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
  } catch (_) { return null; } finally { db?.close(); }
}

async function decodePacked(bytes, packed) {
  const body = new Response(bytes);
  const json = bytes[0] === 31 && bytes[1] === 139
    ? await new Response(body.body.pipeThrough(new DecompressionStream('gzip'))).json()
    : await body.json();
  if (json.data_version !== packed.version || !Array.isArray(json.corpus?.nodes)) throw new Error('剧情数据版本不匹配');
  return json;
}

async function loadRuntime(opts) {
  const o = opts || {};
  const fetchImpl = o.fetchImpl;
  if (typeof fetchImpl !== 'function') throw new Error('loadRuntime 需要 fetch 实现');
  const urls = candidateUrls(o.config, o.origin);
  const tried = [];
  const packed = o.config && o.config.packed;
  if (packed && typeof DecompressionStream === 'function') {
    const cached = await packedStore('readonly', packed);
    if (cached) {
      try { return { data: await decodePacked(cached, packed), url: packed.url, tried }; }
      catch (_) { /* Refill from the server if the stored asset is unreadable. */ }
    }
    try {
      const res = await fetchImpl(packed.url, { cache: 'force-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const json = await decodePacked(bytes, packed);
      await packedStore('readwrite', packed, bytes);
      return { data: json, url: packed.url, tried };
    } catch (e) { tried.push(packed.url + ' → ' + e.message); }
  }
  for (const url of urls) {
    try {
      const res = await fetchImpl(url, { cache: 'no-cache' });
      if (!res || !res.ok) { tried.push(url + ' → HTTP ' + (res && res.status)); continue; }
      const json = await res.json();
      if (!json || !json.corpus || !json.corpus.nodes) { tried.push(url + ' → 不是运行数据'); continue; }
      return { data: json, url, tried };
    } catch (e) {
      tried.push(url + ' → ' + ((e && e.message) || String(e)));
    }
  }
  const err = new Error('剧情数据加载失败：' + tried.join('｜'));
  err.tried = tried;
  err.code = 'ARK_STORY_DATA_NOT_FOUND';
  throw err;
}

module.exports = { candidateUrls, loadRuntime, DEFAULT_DIR, DEFAULT_FILE };

