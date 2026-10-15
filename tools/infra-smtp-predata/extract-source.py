import hashlib,json,os,tarfile
from pathlib import Path,PurePosixPath
root=Path('/bundle');source=root/'installed-image-docs/source.tar.gz';dest=root/'installed-source'
def sha(b):return hashlib.sha256(b).hexdigest()
assert sha(source.read_bytes())=='e52e8faf698f81d6727a62ee2f5212e75898ea1c66e9980e7455f169d12b009b'
manifest=json.loads((root/'installed-image-docs/manifest.json').read_bytes());assert manifest['binary_sha256']=='4abc9b3bac58ede5a922479ba703486248ca5218a84e263a03af56a47e0860bb'
assert not dest.exists();dest.mkdir(mode=0o700)
files={};total=0
with tarfile.open(source,'r:gz') as archive:
 for item in archive:
  name=PurePosixPath(item.name)
  assert item.name.startswith('source/') and not name.is_absolute() and '..' not in name.parts and '\\' not in item.name and item.isfile()
  relative=PurePosixPath(*name.parts[1:]).as_posix();assert relative not in files
  total+=item.size;assert len(files)<2000 and total<67108864 and item.size<16777216
  body=archive.extractfile(item).read(item.size+1);assert len(body)==item.size
  target=dest/relative;target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
  with target.open('xb') as f:f.write(body)
  target.chmod(0o600);files[relative]=sha(body)
checks=[]
for rel,record in manifest['worker_overlay']['files'].items():checks.append({'path':'listmonk/'+rel,'matches':files['listmonk/'+rel]==record['sha256']})
for section,mapping in manifest['smtp_overlay']['overlay'].items():
 for rel,record in mapping.items():checks.append({'path':('listmonk/' if section=='listmonk' else 'smtppool/')+rel,'matches':files[('listmonk/' if section=='listmonk' else 'smtppool/')+rel]==record['sha256']})
assert all(x['matches'] for x in checks)
assert files['recipe/listmonk-regular-build/upstream.batch.lock.json']==manifest['source_lock_sha256']
assert files['listmonk/queries/campaigns.sql']==manifest['query_sha256']
assert files['smtppool/pool.go']=='277094a1b9b1dc266424d7505dfc88ca995f322cecd24fcfc81ddfc8fb9a63dd'
assert files['smtppool/guarded.go']=='18c1a1665734fb2f20b8776679fb6081ce910b0027d2350bd50447b811e5918c'
report={'schema':'installed-exact-source-inventory-v1','files':files,'count':len(files),'totalBytes':total,'declaredOverlayChecks':checks,'allDeclaredOverlayHashesMatch':True,'installedSourceSha256':sha(source.read_bytes()),'sourceLockSha256':manifest['source_lock_sha256'],'batchProfilePreserved':True,'productionCalls':0}
p=root/'installed-source-inventory.private.json';p.write_text(json.dumps(report,sort_keys=True,indent=2)+'\n');p.chmod(0o600)
print(json.dumps({k:report[k] for k in ('schema','count','totalBytes','allDeclaredOverlayHashesMatch','installedSourceSha256','sourceLockSha256','batchProfilePreserved','productionCalls')}))
