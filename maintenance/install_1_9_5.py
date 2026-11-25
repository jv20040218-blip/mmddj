"""Apply reviewed 1.9.5 files to ST 1.19.0. Run while the process is stopped.
No settings, chats or worldbooks are written. Core upgrades require revalidation.
"""
import sys,json,pathlib,hashlib,shutil,datetime,os,base64,struct,zlib
root=pathlib.Path(sys.argv[1]).resolve()
repo=pathlib.Path(__file__).resolve().parents[1]
meta=json.loads((repo/'release.json').read_text())
assert meta['version']=='1.9.5' and not meta['archives_enabled']
user=root/'data/default-user'
settings=json.loads((user/'settings.json').read_text())
avatar=settings.get('active_character')
assert isinstance(avatar,str) and pathlib.Path(avatar).name==avatar
target=user/'characters'/avatar
def digest(data): return hashlib.sha256(data).hexdigest()
def readcard(data):
    blocks={};off=8
    while off+12<=len(data):
        n=struct.unpack('>I',data[off:off+4])[0];kind=data[off+4:off+8];part=data[off+8:off+8+n];off+=n+12
        if kind==b'tEXt' and b'\0' in part:
            key,value=part.split(b'\0',1)
            if key in (b'ccv3',b'chara'): blocks[key]=json.loads(base64.b64decode(value))
    return blocks.get(b'ccv3',blocks.get(b'chara'))
def writecard(data,card):
    value=base64.b64encode(json.dumps(card,ensure_ascii=False,separators=(',',':')).encode());out=bytearray(data[:8]);off=8
    while off+12<=len(data):
        n=struct.unpack('>I',data[off:off+4])[0];kind=data[off+4:off+8];part=data[off+8:off+8+n];chunk=data[off:off+n+12];off+=n+12
        if kind==b'tEXt' and part.split(b'\0',1)[0] in (b'ccv3',b'chara'):
            part=part.split(b'\0',1)[0]+b'\0'+value;chunk=struct.pack('>I',len(part))+kind+part+struct.pack('>I',zlib.crc32(kind+part)&0xffffffff)
        out.extend(chunk)
    return bytes(out)
oldbytes=target.read_bytes();old=readcard(oldbytes);data=old.get('data',old)
script=next(s for s in data['extensions']['tavern_helper']['scripts'] if s['name'].startswith('ARK_UI'))
assert digest(script['content'].encode()) in ('b3affd34a75e4d12f45eabe1ae34d4dc08a07cbc827514212aa6a2b2c16e9e75',meta['card']['script_sha256'])
runtime=(repo/'runtime-v1.9.5.mjs').read_bytes()
assert digest(runtime)==meta['card']['script_sha256']
book=user/'worlds'/(data['extensions']['world']+'.json');bookhash=digest(book.read_bytes())
chats=user/'chats'/target.stem
chat_hashes={str(p.relative_to(chats)):digest(p.read_bytes()) for p in chats.glob('*.jsonl')}
settingshash=digest((user/'settings.json').read_bytes())
expected={
 'src/endpoints/chats.js':'f0175f5dd701020d72f868db7577c8bea5bca65984ddd1ee0467cecbec20f7a6',
 'public/script.js':'e177b8db216096cefc3e41bffa6b1a5d8d6062b2e59c0265a3573f600246c230',
 'public/scripts/group-chats.js':'862eb24dfe1f596a2bd6d039a69397667829e0fc34471d22d2028d7781a5c73c',
 'public/scripts/ark-chat-revisions.js':None}
pending={}
for name,original in expected.items():
    dest=root/name;body=(repo/'maintenance/native-save-guard'/name).read_bytes()
    assert (not dest.exists() or digest(dest.read_bytes())==digest(body)) if original is None else digest(dest.read_bytes()) in (original,digest(body)), 'Unexpected current core file: '+name
    pending[dest]=body
script['content']=runtime.decode();script['info']=(script.get('info','')+'\n1.9.5 预设剧情请求、长档读取和同源依赖')
old['character_version']=data['character_version']='1.9.5'
old['name']=data['name']=meta['card']['name']
pending[target]=writecard(oldbytes,old)
stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup=pathlib.Path('/root/.ark-story-deploy-backup')/('v1.9.5-'+stamp);backup.mkdir(parents=True,mode=0o700)
before={};applied=[]
try:
    for dest,body in pending.items():
        rel=dest.relative_to(root);before[str(rel)]=dest.exists()
        if dest.exists():
            b=backup/rel;b.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(dest,b)
        temp=dest.with_name(dest.name+'.ark195.tmp');temp.write_bytes(body)
        if dest.exists(): shutil.copymode(dest,temp)
        os.replace(temp,dest);applied.append(dest)
    assert digest(book.read_bytes())==bookhash
    assert digest((user/'settings.json').read_bytes())==settingshash
    assert {str(p.relative_to(chats)):digest(p.read_bytes()) for p in chats.glob('*.jsonl')}==chat_hashes
    reread=readcard(target.read_bytes());active=reread['data']
    assert active['character_version']=='1.9.5'
    assert digest(next(s['content'] for s in active['extensions']['tavern_helper']['scripts'] if s['name'].startswith('ARK_UI')).encode())==meta['card']['script_sha256']
    receipt={'version':'1.9.5','active_avatar':avatar,'backup':str(backup),'files':{str(p.relative_to(root)):digest(p.read_bytes()) for p in pending},'original_files':before,'worldbook_unchanged':True,'chat_files_unchanged':len(chat_hashes),'settings_unchanged':True,'archives_enabled':False}
    (backup/'receipt.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2));print(json.dumps(receipt,ensure_ascii=False))
except BaseException:
    for dest in reversed(applied):
        rel=dest.relative_to(root)
        if before[str(rel)]: shutil.copy2(backup/rel,dest)
        else: dest.unlink(missing_ok=True)
    raise
