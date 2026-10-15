import copy,gzip,hashlib,io,json,os,shutil,tarfile
from pathlib import Path
root=Path('/bundle');out=root/'candidate-context';src=root/'candidate-source'
def sha(b):return hashlib.sha256(b).hexdigest()
before=json.loads((root/'installed-image-docs/manifest.json').read_bytes())
proof=json.loads((root/'candidate-packed.safe.json').read_bytes());baseline=json.loads((root/'baseline-packed.safe.json').read_bytes())
assert baseline['baselineWholeBinaryByteExact'] and baseline['binarySha256']=='4abc9b3bac58ede5a922479ba703486248ca5218a84e263a03af56a47e0860bb'
binary=(root/'candidate-build/listmonk').read_bytes();assert sha(binary)==proof['binarySha256']=='4fbdf596c1f4abfaf2b544ec922bc862de1f247ce5766cce747288af55c2dfaa'
inventory=json.loads((root/'installed-source-inventory.private.json').read_bytes())['files'];actual={p.relative_to(src).as_posix():sha(p.read_bytes()) for p in src.rglob('*') if p.is_file()}
assert set(actual)==set(inventory) and [p for p in actual if actual[p]!=inventory[p]]==['smtppool/pool.go']
assert actual['smtppool/pool.go']=='ffe979909222c1d37bd8ae385cee13e97d38983445e5babf7e1e0036a0f04d8e'
buffer=io.BytesIO()
with tarfile.open(fileobj=buffer,mode='w',format=tarfile.PAX_FORMAT) as t:
 for rel in sorted(actual):
  body=(src/rel).read_bytes();item=tarfile.TarInfo('source/'+rel);item.size=len(body);item.mode=0o644;item.mtime=1774790840;t.addfile(item,io.BytesIO(body))
archive=gzip.compress(buffer.getvalue(),mtime=1774790840)
manifest=copy.deepcopy(before);manifest['schema']='listmonk-regular-smtp-predata-candidate-v1';manifest['status']='CANDIDATE_LOCAL_ONLY_NOT_DEPLOYED'
manifest['binary_sha256']=proof['binarySha256'];manifest['compiled_prefix_sha256']=proof['compiledPrefixSha256'];manifest['batch_profile']['build_receipt']['binarySha256']=proof['binarySha256']
manifest['smtp_overlay']['overlay']['smtppool']['pool.go']={'sha256':actual['smtppool/pool.go'],'status':'transformed-smtp-predata-only'}
manifest['smtp_predata_retry']={'baseline_image':'ghcr.io/bandssz/shrigma-crm-listmonk@sha256:85acc4a8b455d9fa9f841cfb2c307fba1263651402ec569a213d8fb0d20544ad','baseline_binary_sha256':baseline['binarySha256'],'baseline_whole_binary_reproduced_byte_exact':True,'baseline_manifest_sha256':sha((root/'installed-image-docs/manifest.json').read_bytes()),'baseline_source_archive_sha256':sha((root/'installed-image-docs/source.tar.gz').read_bytes()),'candidate_source_archive_sha256':sha(archive),'runtime_source_delta':['smtppool/pool.go'],'pool_before_sha256':inventory['smtppool/pool.go'],'pool_after_sha256':actual['smtppool/pool.go'],'send_guarded_sha256':actual['smtppool/guarded.go'],'unchanged_source_files':len(actual)-1,'embedded_asset_bodies_byte_exact':130,'existing_configuration_preserved':True,'historical_replay':False,'retry_body_write':False,'retry_final_ack':False,'retry_limit_semantics':'existing-total-attempts-unchanged'}
files={'listmonk':binary,'source.tar.gz':archive,'LICENSE':(root/'installed-image-docs/LICENSE').read_bytes(),'manifest.json':(json.dumps(manifest,indent=2,sort_keys=True)+'\n').encode(),'previous-manifest.json':(root/'installed-image-docs/manifest.json').read_bytes()}
for name,body in files.items():
 p=out/name;assert not p.exists();p.write_bytes(body);p.chmod(0o755 if name=='listmonk' else 0o644)
dockerfile='''FROM ghcr.io/bandssz/shrigma-crm-listmonk@sha256:85acc4a8b455d9fa9f841cfb2c307fba1263651402ec569a213d8fb0d20544ad
COPY --chmod=0755 listmonk /listmonk/listmonk
COPY --chmod=0644 source.tar.gz LICENSE manifest.json previous-manifest.json /usr/share/doc/listmonk-regular/
LABEL crm.regular.binary-sha256="'''+proof['binarySha256']+'''" \
      infra.smtp.predata-retry.pool-sha256="'''+actual['smtppool/pool.go']+'''" \
      infra.smtp.predata-retry.baseline-digest="sha256:85acc4a8b455d9fa9f841cfb2c307fba1263651402ec569a213d8fb0d20544ad" \
      infra.smtp.predata-retry.source-archive-sha256="'''+sha(archive)+'''"
'''
(out/'Dockerfile').write_text(dockerfile);(out/'Dockerfile').chmod(0o600)
report={'schema':'smtp-only-image-context-v1','files':{name:sha(body) for name,body in files.items()},'dockerfileSha256':sha(dockerfile.encode()),'runtimeSourceFilesChanged':['smtppool/pool.go'],'remainingSourceFilesByteExact':608,'embeddedAssetsByteExact':130,'settingsModified':False,'baselineImagePinned':True,'imageBuilt':False,'published':False,'productionCalls':0}
p=root/'candidate-context.safe.json';assert not p.exists();p.write_text(json.dumps(report,indent=2,sort_keys=True)+'\n');p.chmod(0o600);print(json.dumps(report))
