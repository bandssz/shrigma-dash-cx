import hashlib,importlib.util,json,subprocess,sys
from pathlib import Path
root=Path('/bundle');direction=sys.argv[1];assert direction in ('baseline','candidate')
spec=importlib.util.spec_from_file_location('pinned_stuffbin_reader',root/'native-source/tools/listmonk-ab-build/build.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
assets=json.loads((root/'installed-assets.private.json').read_bytes());original=(root/'installed-image-docs/listmonk.bin').read_bytes();before=m.inspect_stuffed(original)
raw=root/(direction+'-build/listmonk.unstuffed');out=root/(direction+'-build/listmonk');assert not out.exists()
args=[str(root/'baseline-build/stuffbin'),'-a','stuff','-in',str(raw),'-out',str(out)]
for item in assets['assets']:
 file=root/'installed-assets'/item['file'];assert m.sha(file.read_bytes())==item['sha256'];args.append(str(file)+':'+item['name'])
result=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=60);assert result.returncode==0 and len(result.stdout)+len(result.stderr)<65536
out.chmod(0o755);body=out.read_bytes();after=m.inspect_stuffed(body)
assert after['prefix']==raw.read_bytes() and set(after['assets'])==set(before['assets'])
assert all(after['assets'][k]['body']==before['assets'][k]['body'] for k in before['assets'])
wholeExact=body==original
if direction=='baseline':assert wholeExact
report={'schema':'smtp-packed-assets-attestation-v1','direction':direction,'binarySha256':m.sha(body),'compiledPrefixSha256':m.sha(after['prefix']),'assetCount':len(after['assets']),'allInstalledAssetBodiesByteExact':True,'baselineWholeBinaryByteExact':wholeExact if direction=='baseline' else None,'querySha256':after['assets']['/queries/campaigns.sql']['sha256'],'productionCalls':0}
p=root/(direction+'-packed.safe.json');p.write_text(json.dumps(report,sort_keys=True,indent=2)+'\n');p.chmod(0o600);print(json.dumps(report))
