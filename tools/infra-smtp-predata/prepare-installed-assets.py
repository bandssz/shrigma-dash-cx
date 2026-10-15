import hashlib,importlib.util,json,os
from pathlib import Path
root=Path('/bundle');parser=root/'native-source/tools/listmonk-ab-build/build.py'
spec=importlib.util.spec_from_file_location('pinned_stuffbin_reader',parser);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
original=(root/'installed-image-docs/listmonk.bin').read_bytes();assert m.sha(original)=='4abc9b3bac58ede5a922479ba703486248ca5218a84e263a03af56a47e0860bb'
parts=m.inspect_stuffed(original);assert len(parts['assets'])==130 and m.sha(parts['prefix'])=='2ed409125aedd9f829bf851119561cbd05d1be0e80b019fc983b9784c1f794e9'
assert (root/'baseline-build/listmonk.unstuffed').read_bytes()==parts['prefix']
assert parts['assets']['/queries/campaigns.sql']['sha256']=='772efe8e05331fb201ed24cb08bb97a4625a49811d96622c2148342ce54c6700'
out=root/'installed-assets';out.mkdir(mode=0o700)
assets=[]
for index,(name,record) in enumerate(sorted(parts['assets'].items())):
 target=out/str(index);target.write_bytes(record['body']);target.chmod(0o644);os.utime(target,(1774790840,1774790840))
 assets.append({'file':str(index),'name':name,'sha256':record['sha256'],'bytes':len(record['body'])})
report={'schema':'installed-assets-byte-exact-v1','installedBinarySha256':m.sha(original),'compiledPrefixSha256':m.sha(parts['prefix']),'assets':assets,'count':len(assets),'allBodiesPreserved':True,'querySha256':parts['assets']['/queries/campaigns.sql']['sha256'],'productionCalls':0}
p=root/'installed-assets.private.json';p.write_text(json.dumps(report,sort_keys=True,indent=2)+'\n');p.chmod(0o600)
print(json.dumps({k:report[k] for k in ('schema','installedBinarySha256','compiledPrefixSha256','count','allBodiesPreserved','querySha256','productionCalls')}))
