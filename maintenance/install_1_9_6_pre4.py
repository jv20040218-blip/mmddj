"""Apply reviewed 1.9.6-pre4 files to SillyTavern 1.19.0.

Safety contract (same family as 1.9.5 / 1.9.6-pre):
- Backup changed files under /root/.ark-story-deploy-backup/
- Rollback restores code + card + extension files only
- Never write chats, settings, or worldbooks
- archives_enabled remains false; do not enable 1.10.0
- If a plugin folder already exists, update it in place
- Do not reset Amily2 or presets
- Install the new card as a new file; never overwrite an older card file

Run while the ST process is stopped. This script is for the unreleased
1.9.6-pre4 product and must not be confused with live 1.9.5 or 1.9.6-pre.
"""
import sys, json, pathlib, hashlib, shutil, datetime, os

root = pathlib.Path(sys.argv[1]).resolve()
repo = pathlib.Path(__file__).resolve().parents[1]
meta = json.loads((repo / 'release.json').read_text(encoding='utf-8'))
assert meta['version'] == '1.9.6-pre4' and not meta['archives_enabled'] and meta.get('do_not_enable_1_10_0', True)

user = root / 'data/default-user'
assert (user / 'settings.json').is_file(), 'Not a SillyTavern user directory'
settings = json.loads((user / 'settings.json').read_text(encoding='utf-8'))
settingshash = hashlib.sha256((user / 'settings.json').read_bytes()).hexdigest()

NEW_CARD_NAME = meta['card']['filename']
assert NEW_CARD_NAME == 'ark-story-v1.9.6-pre4.png'
PROTECTED_CARDS = {
    'ark-story-v1.9.6-pre3.png',
    'ark-story-v1.9.6-pre2.png',
    'ark-story-v1.9.6-pre.png',
    'ark-story-v1.9.5.png',
}
# Any currently selected older card must also stay untouched.
active = settings.get('active_character')
if isinstance(active, str) and pathlib.Path(active).name == active:
    if active != NEW_CARD_NAME:
        PROTECTED_CARDS.add(active)

characters = user / 'characters'
assert characters.is_dir(), 'Missing characters directory'
card_dest = characters / NEW_CARD_NAME
assert card_dest.name not in PROTECTED_CARDS, 'Refusing to use a protected older card filename'
assert card_dest.name == NEW_CARD_NAME

# If an older card is sitting at this exact new filename with a different hash, stop.
new_card_bytes = (repo / 'cards' / NEW_CARD_NAME).read_bytes()
expected_card_sha = meta['card']['sha256']
assert hashlib.sha256(new_card_bytes).hexdigest() == expected_card_sha, 'Packaged card hash mismatch'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def iter_tree(src: pathlib.Path):
    for path in src.rglob('*'):
        if not path.is_file():
            continue
        rel = path.relative_to(src)
        if any(p in {'.git', '__pycache__', 'node_modules', '.cache'} or p.endswith('.pyc') for p in rel.parts):
            continue
        yield path, rel


def copy_tree_pending(src: pathlib.Path, dest: pathlib.Path, pending: dict):
    dest.mkdir(parents=True, exist_ok=True)
    for path, rel in iter_tree(src):
        pending[dest / rel] = path.read_bytes()


# Worldbooks and chats must remain byte-identical.
worlds = user / 'worlds'
world_hashes = {str(p.relative_to(worlds)): digest(p.read_bytes()) for p in worlds.glob('*.json')} if worlds.is_dir() else {}
chats_root = user / 'chats'
chat_hashes = {str(p.relative_to(chats_root)): digest(p.read_bytes()) for p in chats_root.rglob('*.jsonl')} if chats_root.is_dir() else {}

runtime = (repo / 'runtime-v1.9.6-pre4.mjs').read_bytes()
assert digest(runtime) == meta['card']['script_sha256']

expected = {
    'src/endpoints/chats.js': 'f0175f5dd701020d72f868db7577c8bea5bca65984ddd1ee0467cecbec20f7a6',
    'public/script.js': 'e177b8db216096cefc3e41bffa6b1a5d8d6062b2e59c0265a3573f600246c230',
    'public/scripts/group-chats.js': '862eb24dfe1f596a2bd6d039a69397667829e0fc34471d22d2028d7781a5c73c',
    'public/scripts/ark-chat-revisions.js': None,
}
pending = {}
for name, original in expected.items():
    dest = root / name
    body = (repo / 'maintenance/native-save-guard' / name).read_bytes()
    current = digest(dest.read_bytes()) if dest.exists() else None
    if original is None:
        assert (not dest.exists()) or current == digest(body), 'Unexpected current core file: ' + name
    else:
        assert current in (original, digest(body)), 'Unexpected current core file: ' + name
    pending[dest] = body

# New card file only. Never overwrite a protected older card.
# Reinstall may replace an existing pre2 card at this exact new filename.
# Older card filenames are in PROTECTED_CARDS and cannot land in pending.
pending[card_dest] = new_card_bytes

# Plugin + copy-worldbook: update an existing install path, or place into user extensions.
plugin_candidates = [
    user / 'extensions' / 'mmddj',
    root / 'public/scripts/extensions/third-party/mmddj',
]
copy_candidates = [
    user / 'extensions' / 'arknights-copy-worldbook',
    root / 'public/scripts/extensions/third-party/arknights-copy-worldbook',
]
plugin_dest = next((p for p in plugin_candidates if p.exists()), user / 'extensions' / 'mmddj')
copy_dest = next((p for p in copy_candidates if p.exists()), user / 'extensions' / 'arknights-copy-worldbook')

# Install only the reviewed code delta. Story text and packed data stay byte-identical.
for field in ('data','worldbook','packed_data'):
    spec=meta[field]
    assert digest((plugin_dest/spec['path']).read_bytes()) == spec['sha256'], 'Current story data differs from reviewed pre3: '+field
current_meta=json.loads((plugin_dest/'manifest.json').read_text())
assert current_meta['version'] in ('1.9.6-pre3','1.9.6-pre4'), 'Unexpected deployed version'
if card_dest.exists():
    assert digest(card_dest.read_bytes()) == expected_card_sha, 'Existing pre4 card differs; will not overwrite user changes'
PLUGIN_FILES = ['index.js','manifest.json','release.json','runtime-v1.9.6-pre4.mjs','docs/pre4-repair-notes.md']
for rel in PLUGIN_FILES:
    src = repo / rel
    if src.is_file():
        pending[plugin_dest / rel] = src.read_bytes()
copy_tree_pending(repo / 'extensions' / 'arknights-copy-worldbook', copy_dest, pending)
copy_tree_pending(repo / 'maintenance' / 'runtime-src', plugin_dest / 'maintenance' / 'runtime-src', pending)

# Final guard: pending destinations must not be a protected older card.
for dest in pending:
    if dest.parent == characters and dest.name in PROTECTED_CARDS:
        raise SystemExit('Refusing to overwrite older card: ' + dest.name)

stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup = pathlib.Path('/root/.ark-story-deploy-backup') / ('v1.9.6-pre4-' + stamp)
backup.mkdir(parents=True, mode=0o700)
before = {}
applied = []
try:
    for dest, body in pending.items():
        rel_key = str(dest)
        before[rel_key] = dest.exists()
        if dest.exists():
            b = backup / dest.relative_to(root) if dest.is_relative_to(root) else backup / 'outside' / dest.name
            b.parent.mkdir(parents=True, exist_ok=True)
            if dest.is_file():
                shutil.copy2(dest, b)
        dest.parent.mkdir(parents=True, exist_ok=True)
        temp = dest.with_name(dest.name + '.ark196pre4.tmp')
        temp.write_bytes(body)
        if dest.exists():
            shutil.copymode(dest, temp)
        os.replace(temp, dest)
        applied.append(dest)
    assert digest((user / 'settings.json').read_bytes()) == settingshash, 'Settings were modified'
    if worlds.is_dir():
        assert {str(p.relative_to(worlds)): digest(p.read_bytes()) for p in worlds.glob('*.json')} == world_hashes, 'Worldbooks were modified'
    if chats_root.is_dir():
        assert {str(p.relative_to(chats_root)): digest(p.read_bytes()) for p in chats_root.rglob('*.jsonl')} == chat_hashes, 'Chats were modified'
    for name in PROTECTED_CARDS:
        path = characters / name
        if path.exists() and name != NEW_CARD_NAME:
            # present and not in pending
            assert path not in pending, 'Protected card was staged for write: ' + name
    assert digest(card_dest.read_bytes()) == expected_card_sha
    receipt = {
        'version': '1.9.6-pre4',
        'new_card': str(card_dest),
        'active_character_unchanged': settings.get('active_character'),
        'backup': str(backup),
        'files': {str(p): digest(p.read_bytes()) for p in pending},
        'original_files': before,
        'worldbook_unchanged': True,
        'chat_files_unchanged': len(chat_hashes),
        'settings_unchanged': True,
        'archives_enabled': False,
        'plugin_dest': str(plugin_dest),
        'copy_worldbook_dest': str(copy_dest),
        'older_cards_kept': sorted(PROTECTED_CARDS),
    }
    (backup / 'receipt.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({k: receipt[k] for k in receipt if k != 'files'}, ensure_ascii=False))
except BaseException:
    for dest in reversed(applied):
        rel_key = str(dest)
        if before[rel_key]:
            src = backup / dest.relative_to(root) if dest.is_relative_to(root) else backup / 'outside' / dest.name
            shutil.copy2(src, dest)
        else:
            dest.unlink(missing_ok=True)
    raise
