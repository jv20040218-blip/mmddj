"""Repair the deployment target, not the runtime: preserve the actual selected avatar/chat.

Run via sudo with the SillyTavern root as argv[1]. Web credentials arrive on stdin only.
The current valid worldbook is read and checked, never overwritten by this repair.
"""
import pathlib, sys, json, re, struct, base64, zlib, hashlib, datetime, shutil
import urllib.request, http.cookiejar

root = pathlib.Path(sys.argv[1]).resolve()
user = root / 'data/default-user'
plugin = user / 'extensions/mmddj'
auth = json.loads(sys.stdin.readline())
meta = json.loads((plugin / 'release.json').read_text())
expected_version = sys.argv[2] if len(sys.argv) > 2 else '1.7.0'
assert meta['version'] == expected_version, 'The selected-card repair must name the expected release'


def readcard(data):
    blocks = {}
    off = 8
    while off + 12 <= len(data):
        size = struct.unpack('>I', data[off:off + 4])[0]
        kind, payload = data[off + 4:off + 8], data[off + 8:off + 8 + size]
        off += size + 12
        if kind == b'tEXt' and b'\0' in payload:
            key, encoded = payload.split(b'\0', 1)
            if key in [b'chara', b'ccv3']:
                blocks[key] = json.loads(base64.b64decode(encoded))
    assert blocks, 'No character metadata'
    return blocks.get(b'ccv3', blocks.get(b'chara'))


def writecard(original, card):
    encoded = base64.b64encode(json.dumps(card, ensure_ascii=False, separators=(',', ':')).encode())
    result = bytearray(original[:8]); off = 8
    while off + 12 <= len(original):
        size = struct.unpack('>I', original[off:off + 4])[0]
        kind, payload = original[off + 4:off + 8], original[off + 8:off + 8 + size]
        chunk = original[off:off + size + 12]; off += size + 12
        if kind == b'tEXt' and payload.split(b'\0', 1)[0] in [b'chara', b'ccv3']:
            payload = payload.split(b'\0', 1)[0] + b'\0' + encoded
            chunk = struct.pack('>I', len(payload)) + kind + payload + struct.pack('>I', zlib.crc32(kind + payload) & 0xffffffff)
        result.extend(chunk)
    return bytes(result)


match = re.search(r'"active_character"\s*:\s*("(?:[^"\\]|\\.)*"|null)', (user / 'settings.json').read_text())
assert match, 'Saved active avatar is missing; do not guess a filename'
avatar = json.loads(match.group(1))
assert isinstance(avatar, str) and pathlib.Path(avatar).name == avatar and avatar.endswith('.png')
target = user / 'characters' / avatar
assert target.resolve().parent == (user / 'characters').resolve() and target.is_file()
old = readcard(target.read_bytes())
old_data = old.get('data', old)
scripts = old_data.get('extensions', {}).get('tavern_helper', {}).get('scripts', [])
assert any(str(s.get('name', '')).startswith('ARK_UI') for s in scripts), 'Selected avatar is not this module'

book_name = meta['card']['worldbook_name']
world_path = user / 'worlds' / (book_name + '.json')
world_bytes = world_path.read_bytes()
world = json.loads(world_bytes)
assert len(world['entries']) == meta['card']['worldbook_entries']
assert all(isinstance(e.get('key'), list) and isinstance(e.get('keysecondary'), list) for e in world['entries'].values())
source = plugin / meta['card']['path']
source_bytes = source.read_bytes()
assert hashlib.sha256(source_bytes).hexdigest() == meta['card']['sha256']
new = readcard(source_bytes)

cookies = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookies))
headers = {'Authorization': 'Basic ' + base64.b64encode((auth['web_user'] + ':' + auth['web_password']).encode()).decode()}


def request(endpoint, data=None, content_type='application/json'):
    body = json.dumps(data, ensure_ascii=False).encode() if isinstance(data, dict) else data
    extra = {'Content-Type': content_type} if body is not None else {}
    req = urllib.request.Request('http://127.0.0.1:8000' + endpoint, data=body, headers={**headers, **extra})
    with opener.open(req, timeout=90) as response:
        raw = response.read()
    try: return json.loads(raw)
    except ValueError: return raw.decode()


headers['X-CSRF-Token'] = request('/csrf-token')['token']
pre = request('/api/characters/get', {'avatar_url': avatar})
pre_data = pre.get('data', pre)
chat = pre.get('chat', pre_data.get('chat'))
fav = pre.get('fav', pre_data.get('extensions', {}).get('fav'))
chat_exists = bool(chat and (user / 'chats' / target.stem / (chat + '.jsonl')).is_file())
backup = pathlib.Path('/root/.ark-story-deploy-backup') / ('selected-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
backup.mkdir(parents=True, mode=0o700)
shutil.copy2(target, backup / avatar)
if chat: new['chat'] = chat
if fav is not None: new['data']['extensions']['fav'] = fav
card_bytes = writecard(source_bytes, new)
boundary = 'ark-selected-avatar-repair'
body = bytearray()
for key, value in {'file_type': 'png', 'preserved_name': avatar}.items():
    body.extend(('--' + boundary + '\r\nContent-Disposition: form-data; name="' + key + '"\r\n\r\n' + value + '\r\n').encode())
body.extend(('--' + boundary + '\r\nContent-Disposition: form-data; name="avatar"; filename="ark-latest.png"\r\nContent-Type: image/png\r\n\r\n').encode())
body.extend(card_bytes); body.extend(('\r\n--' + boundary + '--\r\n').encode())
imported = request('/api/characters/import', bytes(body), 'multipart/form-data; boundary=' + boundary)
assert imported['file_name'] == target.stem
after = request('/api/characters/get', {'avatar_url': avatar})
for field, value in [('chat', chat), ('fav', fav)]:
    if value is not None:
        request('/api/characters/edit-attribute', {'avatar_url': avatar, 'ch_name': after.get('data', after)['name'], 'field': field, 'value': value})
after = request('/api/characters/get', {'avatar_url': avatar})
after_data = after.get('data', after)
assert after_data['character_version'] == meta['version']
assert after_data['extensions']['world'] == book_name
assert after.get('chat', after_data.get('chat')) == chat
script = next(s for s in after_data['extensions']['tavern_helper']['scripts'] if str(s.get('name', '')).startswith('ARK_UI'))
assert hashlib.sha256(script['content'].encode()).hexdigest() == meta['card_script_sha256']
assert world_path.read_bytes() == world_bytes, 'Existing valid book must not be reset by target repair'
saved = re.search(r'"active_character"\s*:\s*("(?:[^"\\]|\\.)*")', (user / 'settings.json').read_text())
assert json.loads(saved.group(1)) == avatar
receipt = {'repair': 'selected_avatar_deployment_target', 'selected_avatar': avatar,
           'old_version': old_data.get('character_version'), 'new_version': after_data['character_version'],
           'old_worldbook': old_data.get('extensions', {}).get('world'), 'new_worldbook': book_name,
           'script_sha256_matches': True, 'chat_pointer_preserved': True, 'original_chat_file_present': chat_exists,
           'selected_avatar_preserved': True, 'valid_worldbook_unchanged': True,
           'card_backup': str(backup / avatar), 'paid_model_calls': 0}
(backup / 'deployment.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2))
print(json.dumps(receipt, ensure_ascii=False))
