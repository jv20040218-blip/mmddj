// 明日方舟剧情数据插件：只负责「把数据放到酒馆能取到的地址」并自检。
// 剧情 UI 与运行时仍由角色卡里的酒馆助手脚本提供，本插件不重复加载、不抢挂载。
const BASE = new URL('.', import.meta.url);
const DATA_URL = new URL('data/story_runtime.json', BASE).href;
const MANIFEST_URL = new URL('data/data_manifest.json', BASE).href;

window.__ARK_STORY_EXTENSION__ = { base: BASE.href, dataUrl: DATA_URL, manifestUrl: MANIFEST_URL, version: '1.3.0' };

async function selfCheck() {
    try {
        const res = await fetch(MANIFEST_URL, { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const m = await res.json();
        window.__ARK_STORY_EXTENSION__.manifest = m;
        console.info('[ARK_STORY] 插件就绪：数据 ' + (m.bytes / 1048576).toFixed(1) + ' MB，数据版本 ' + m.data_version + '，构建 ' + m.build_id);
        return m;
    } catch (e) {
        console.error('[ARK_STORY] 插件数据缺失：' + DATA_URL + '（' + (e && e.message) + '）');
        return null;
    }
}

selfCheck();
