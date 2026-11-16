"""Run through sudo on the authorized host. No credentials are written to disk.

1.7.0 版：原插件原位快进 + 世界书/卡片原生接口导入 + 导入前采集、导入后恢复最近聊天指针。
"""
import pathlib, sys, json, subprocess, hashlib, shutil, struct, base64, zlib, re
import urllib.request, http.cookiejar, datetime

STAGE_NAME = '.ark_story_deploy_v1_7_0'
stage = pathlib.Path(sys.argv[1]).resolve()
assert stage.parent == pathlib.Path('/home/ubuntu') and stage.name == STAGE_NAME
auth = json.loads(sys.stdin.readline())
meta = json.loads((stage / 'release.json').read_text(encoding='utf-8-sig'))

root = pathlib.Path('/root/SillyTavern')
user = root / 'data/default-user'
plugin = user / 'extensions/mmddj'
old_global = root / 'public/scripts/extensions/third-party/mmddj'


def git(*args):
    return subprocess.check_output(['git', '-C', str(plugin), *args], text=True).strip()


# ---- 1. 原位快进：只处理这一个插件，保留 origin 与工作区 ----
assert git('remote', 'get-url', 'origin').rstrip('/').removesuffix('.git') == 'https://github.com/jv20040218-blip/mmddj'
assert not git('status', '--porcelain'), 'Plugin contains unrelated changes; not overwritten'
old_commit = git('rev-parse', 'HEAD')
subprocess.run(['git', '-C', str(plugin), 'fetch', str(stage / 'plugin.bundle'),
                'refs/heads/main:refs/remotes/origin/main'], check=True, capture_output=True)
subprocess.run(['git', '-C', str(plugin), 'merge', '--ff-only', 'refs/remotes/origin/main'],
               check=True, capture_output=True)
assert git('rev-parse', 'HEAD') == meta['commit'] or subprocess.run(
    ['git', '-C', str(plugin), 'merge-base', '--is-ancestor', meta['commit'], 'HEAD']).returncode == 0, \
    'Plugin HEAD does not contain the published content commit'
head_commit = git('rev-parse', 'HEAD')
for key in ['data', 'card', 'worldbook']:
    item = meta[key]
    assert hashlib.sha256((plugin / item['path']).read_bytes()).hexdigest() == item['sha256'], key + ' hash mismatch'
assert head_commit == git('rev-parse', 'refs/remotes/origin/main'), 'HEAD is not the fetched release branch'


# ---- 2. 卡片读写：只改文本块，保留图像块 ----
def readcard(b):
    found = {}
    i = 8
    while i + 12 <= len(b):
        n = struct.unpack('>I', b[i:i + 4])[0]
        kind = b[i + 4:i + 8]
        payload = b[i + 8:i + 8 + n]
        i += n + 12
        if kind == b'tEXt' and b'\0' in payload:
            k, v = payload.split(b'\0', 1)
            if k in [b'chara', b'ccv3']:
                found[k] = v
    return json.loads(base64.b64decode(found.get(b'ccv3') or found[b'chara']))


def writecard(b, c):
    out = bytearray(b[:8])
    i = 8
    encoded = base64.b64encode(json.dumps(c, ensure_ascii=False, separators=(',', ':')).encode())
    while i + 12 <= len(b):
        n = struct.unpack('>I', b[i:i + 4])[0]
        kind = b[i + 4:i + 8]
        payload = b[i + 8:i + 8 + n]
        chunk = b[i:i + n + 12]
        i += n + 12
        if kind == b'tEXt' and payload.split(b'\0', 1)[0] in [b'chara', b'ccv3']:
            payload = payload.split(b'\0', 1)[0] + b'\0' + encoded
            chunk = struct.pack('>I', len(payload)) + kind + payload + struct.pack('>I', zlib.crc32(kind + payload) & 0xffffffff)
        out.extend(chunk)
    return bytes(out)


selection = re.search(r'"active_character"\s*:\s*("(?:[^"\\]|\\.)*"|null)', (user / 'settings.json').read_text())
assert selection, 'Cannot determine selected avatar; do not guess a canonical filename'
selected_avatar = auth.get('target_avatar') or json.loads(selection.group(1))
assert isinstance(selected_avatar, str) and pathlib.Path(selected_avatar).name == selected_avatar and selected_avatar.endswith('.png')
target = user / 'characters' / selected_avatar
assert target.resolve().parent == (user / 'characters').resolve() and target.is_file()
original = readcard(target.read_bytes())
selected_data = original.get('data', original)
selected_helper = selected_data.get('extensions', {}).get('tavern_helper', {})
selected_scripts = selected_helper.get('scripts', []) if isinstance(selected_helper, dict) else selected_helper if isinstance(selected_helper, list) else []
assert any(isinstance(s, dict) and str(s.get('name', '')).startswith('ARK_UI') for s in selected_scripts), 'Selected avatar is unrelated; specify the actual module avatar explicitly'
stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup = pathlib.Path('/root/.ark-story-deploy-backup') / stamp
backup.mkdir(parents=True, mode=0o700)
shutil.copy2(target, backup / target.name)

# ---- 3. 认证会话 ----
jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
authorization = 'Basic ' + base64.b64encode((auth['web_user'] + ':' + auth['web_password']).encode()).decode()
headers = {'Authorization': authorization}
base = 'http://127.0.0.1:8000'


def request(path, payload=None, content_type=None):
    h = dict(headers)
    if content_type:
        h['Content-Type'] = content_type
    req = urllib.request.Request(base + path, data=payload, headers=h)
    with opener.open(req, timeout=120) as response:
        return response.read()


token = json.loads(request('/csrf-token'))['token']
headers['X-CSRF-Token'] = token

# ---- 4. 导入前采集：最近聊天指针、收藏标记（不读聊天正文）----
pre = json.loads(request('/api/characters/get', json.dumps({'avatar_url': target.name}, ensure_ascii=False).encode(), 'application/json'))
pre_data = pre.get('data', pre)
pre_chat = pre.get('chat', pre_data.get('chat'))
pre_fav = pre.get('fav', (pre_data.get('extensions') or {}).get('fav'))
chat_dir = user / 'chats' / target.stem
chat_file_present = bool(isinstance(pre_chat, str) and pre_chat and (chat_dir / (pre_chat + '.jsonl')).is_file())

# ---- 5. 世界书 ----
book = json.loads((stage / 'worldbook.json').read_text(encoding='utf-8'))
native = book
assert isinstance(native['entries'], dict), 'Only native UID-keyed worldbooks may be installed'
assert hashlib.sha256((stage / 'worldbook.json').read_bytes()).hexdigest() == meta['worldbook']['sha256']
for uid, entry in native['entries'].items():
    assert str(entry['uid']) == uid
    assert isinstance(entry.get('key'), list) and isinstance(entry.get('keysecondary'), list), 'Native keyword arrays missing at ' + uid
    assert isinstance(entry.get('position'), int) and 0 <= entry['position'] <= 7
    assert isinstance(entry.get('disable'), bool)
world_name = meta['card']['worldbook_name']
book_path = user / 'worlds' / (world_name + '.json')
if book_path.exists():
    shutil.copy2(book_path, backup / book_path.name)
result = json.loads(request('/api/worldinfo/edit', json.dumps({'name': world_name, 'data': native}, ensure_ascii=False).encode(), 'application/json'))
assert result.get('ok') or result.get('success') or book_path.exists(), 'Worldbook import failed'

# ---- 6. 卡片导入（保留原文件名，不新增同类卡）----
card_bytes = (plugin / meta['card']['path']).read_bytes()
card = readcard(card_bytes)
for key in ['chat', 'fav']:
    if key in card and key in pre:
        card[key] = pre[key]
old_ext = (pre_data.get('extensions') or {})
if 'fav' in old_ext:
    card.setdefault('data', {}).setdefault('extensions', {})['fav'] = old_ext['fav']
card_bytes = writecard(card_bytes, card)
boundary = 'ark-story-install-161'
body = bytearray()
for k, v in {'file_type': 'png', 'preserved_name': target.name}.items():
    body.extend(('--' + boundary + '\r\nContent-Disposition: form-data; name="' + k + '"\r\n\r\n' + v + '\r\n').encode())
body.extend(('--' + boundary + '\r\nContent-Disposition: form-data; name="avatar"; filename="ark-story-latest.png"\r\nContent-Type: image/png\r\n\r\n').encode())
body.extend(card_bytes)
body.extend(('\r\n--' + boundary + '--\r\n').encode())
imported = json.loads(request('/api/characters/import', bytes(body), 'multipart/form-data; boundary=' + boundary))
assert imported.get('file_name') == target.stem, 'Character import returned an unexpected filename'

stored = readcard(target.read_bytes())
data = stored.get('data', stored)
assert data.get('character_version') == meta['version'], 'Imported card version mismatch'
assert data.get('extensions', {}).get('world') == world_name, 'Imported card is not bound to the new worldbook'
scripts = data['extensions']['tavern_helper']['scripts']
ark = next(s for s in scripts if str(s.get('name', '')).startswith('ARK_UI'))
assert hashlib.sha256(ark['content'].encode()).hexdigest() == meta['card_script_sha256'], 'Card script hash mismatch'

# ---- 7. 恢复最近聊天指针（导入接口会重置），并回读核验 ----
after = json.loads(request('/api/characters/get', json.dumps({'avatar_url': target.name}, ensure_ascii=False).encode(), 'application/json'))
after_chat = after.get('chat', after.get('data', {}).get('chat'))
chat_restored = after_chat == pre_chat
if pre_chat and not chat_restored:
    ch_name = after.get('data', after)['name']
    request('/api/characters/edit-attribute', json.dumps({'avatar_url': target.name, 'ch_name': ch_name,
                                                          'field': 'chat', 'value': pre_chat}, ensure_ascii=False).encode(), 'application/json')
    after = json.loads(request('/api/characters/get', json.dumps({'avatar_url': target.name}, ensure_ascii=False).encode(), 'application/json'))
    after_chat = after.get('chat', after.get('data', {}).get('chat'))
    chat_restored = after_chat == pre_chat
assert not pre_chat or chat_restored, 'Chat pointer restore did not take effect'
if pre_fav is not None:
    post_fav = after.get('fav', (after.get('data', {}).get('extensions') or {}).get('fav'))
    if post_fav != pre_fav:
        ch_name = after.get('data', after)['name']
        request('/api/characters/edit-attribute', json.dumps({'avatar_url': target.name, 'ch_name': ch_name,
                                                              'field': 'fav', 'value': pre_fav}, ensure_ascii=False).encode(), 'application/json')

api_card = json.loads(request('/api/characters/get', json.dumps({'avatar_url': target.name}, ensure_ascii=False).encode(), 'application/json'))
api_data = api_card.get('data', api_card)
assert api_data.get('character_version') == meta['version'], 'Character API still returns old card data'
assert api_data.get('extensions', {}).get('world') == world_name

# ---- 8. 世界书落盘核对 ----
stored_book = json.loads(book_path.read_text())
assert len(stored_book['entries']) == meta['card']['worldbook_entries'], 'Stored worldbook entry count mismatch'
assert stored_book['entries'] == book['entries'], 'Worldbook metadata or content changed during import'
helper = user / 'extensions/JS-Slash-Runner/dist/index.js'
assert helper.is_file(), 'Installed helper is required for the opening integration check'
opening_verification = json.loads(subprocess.check_output(
    ['node', str(stage / 'verify_openings.cjs'), str(book_path), str(target), str(helper)], text=True, timeout=120))
assert opening_verification['entries_read'] == meta['card']['worldbook_entries']
assert opening_verification['openings_executed'] == 61 and opening_verification['actor_switch_checks'] == 325
assert opening_verification['live_worldbook_unchanged']
physical_verification = json.loads(subprocess.check_output(
    ['node', str(stage / 'verify_physical_api.cjs'), str(plugin), str(target), str(helper)],
    input=json.dumps(auth), text=True, timeout=180))
assert physical_verification['child_to_fighter_verified'] and physical_verification['exit_restored_verified']
assert physical_verification['full_reset_entries_verified'] == meta['card']['worldbook_entries']
assert physical_verification['temporary_book_deleted'] and not physical_verification['player_chat_modified']
assert not list((user / 'worlds').glob(world_name + ' (test-*')), 'Temporary verification book remains'



# ---- 9. 只清理已核实的同源全局重复副本 ----
deleted_duplicate = False
if old_global.exists():
    assert old_global.resolve().parent == (root / 'public/scripts/extensions/third-party').resolve()
    origin = subprocess.check_output(['git', '-C', str(old_global), 'remote', 'get-url', 'origin'], text=True).strip()
    assert origin.rstrip('/').removesuffix('.git') == 'https://github.com/jv20040218-blip/mmddj'
    shutil.rmtree(old_global)
    deleted_duplicate = True

# ---- 10. 实际服务核验 ----
served = json.loads(request('/scripts/extensions/third-party/mmddj/manifest.json?build=' + meta['build_id']))
assert served['version'] == meta['version'], 'HTTP still serves an old plugin'
http_manifest = json.loads(request('/scripts/extensions/third-party/mmddj/data/data_manifest.json?build=' + meta['build_id']))
assert http_manifest['sha256'] == meta['data']['sha256'], 'HTTP serves old data'
assert http_manifest['data_version'] == meta['data_version']
assert not git('status', '--porcelain'), 'Installed extension must remain clean for future updates'
copies = []
for base_dir in [user / 'extensions', root / 'public/scripts/extensions/third-party']:
    if not base_dir.exists():
        continue
    for directory in base_dir.iterdir():
        manifest = directory / 'manifest.json'
        if directory.is_dir() and manifest.exists() and '明日方舟剧情数据' in json.loads(manifest.read_text()).get('display_name', ''):
            copies.append(str(directory))
assert len(copies) == 1, 'Duplicate story plugins remain: ' + json.dumps(copies, ensure_ascii=False)

receipt = {'version': meta['version'], 'commit': meta['commit'], 'head_commit': head_commit,
           'served_version': served['version'],
           'data_version': meta['data_version'], 'plugin_copies': len(copies), 'deleted_duplicate': deleted_duplicate,
           'card_file': target.name, 'card_version': data['character_version'], 'worldbook': world_name,
           'served_card_version': api_data['character_version'],
           'worldbook_entries': len(stored_book['entries']), 'chat_pointer_preserved': chat_restored,
           'chat_pointer_value': pre_chat, 'original_chat_file_present': chat_file_present,
           'old_commit': old_commit, 'card_backup': str(backup / target.name), 'paid_model_calls': 0, 'worldbook_native_schema': True, 'opening_verification': opening_verification, 'physical_verification': physical_verification}
(backup / 'deployment.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2))
print(json.dumps(receipt, ensure_ascii=False))
assert stage.parent == pathlib.Path('/home/ubuntu') and stage.name == STAGE_NAME
shutil.rmtree(stage)
