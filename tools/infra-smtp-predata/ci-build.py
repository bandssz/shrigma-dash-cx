#!/usr/bin/env python3
"""Build only. Reproduce the installed binary first; never push or deploy."""
import argparse,hashlib,json,os,re,shutil,subprocess
from pathlib import Path
HERE=Path(__file__).resolve().parent
BASE='ghcr.io/bandssz/shrigma-crm-listmonk@sha256:85acc4a8b455d9fa9f841cfb2c307fba1263651402ec569a213d8fb0d20544ad'
GO='golang@sha256:2389ebfa5b7f43eeafbd6be0c3700cc46690ef842ad962f6c5bd6be49ed82039'
PY='python@sha256:1b668429b3511ab407d8e00648891631b0b1a4d7e15e3ca70f38ab5b91ad4ab4'
def sha(b):return hashlib.sha256(b).hexdigest()
def run(args,env=None,cwd=None,timeout=900):
 p=subprocess.run([str(v) for v in args],env=env,cwd=cwd,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout)
 if p.returncode:raise RuntimeError('BUILD_STEP_FAILED:'+str(args[0])+':'+p.stderr.decode(errors='replace')[-4000:])
 return p.stdout
def write(path,value):
 path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
 with path.open('xb') as f:f.write(value)
 path.chmod(0o600)
def main():
 p=argparse.ArgumentParser();p.add_argument('--out',required=True,type=Path);p.add_argument('--tag',required=True);p.add_argument('--race',action='store_true');a=p.parse_args()
 assert re.fullmatch(r'ghcr\.io/bandssz/shrigma-crm-listmonk:smtp-predata-[0-9a-f]{40}',a.tag)
 out=a.out.resolve();assert not out.exists();out.mkdir(parents=True,mode=0o700);work=out/'reconstruct-417a';work.mkdir(mode=0o700)
 for name in ('extract-source.py','prepare-installed-assets.py','pack-exact-assets.py','prepare-candidate-source.mjs','prepare-image.py'):
  shutil.copyfile(HERE/name,work/name)
 shutil.copytree(HERE/'native-source',work/'native-source');shutil.copytree(HERE/'package',out/'package')
 for name in ('baseline-build','module-cache','compile-cache','installed-image-docs'):(work/name).mkdir(mode=0o700)
 run(['docker','pull','--platform','linux/amd64',BASE])
 identity=run(['docker','create','--platform','linux/amd64','--network','none','--read-only','--entrypoint','/bin/true',BASE]).decode().strip()
 try:
  for name in ('source.tar.gz','manifest.json','LICENSE'):run(['docker','cp',identity+':/usr/share/doc/listmonk-regular/'+name,work/'installed-image-docs'/name])
  run(['docker','cp',identity+':/listmonk/listmonk',work/'installed-image-docs/listmonk.bin'])
 finally:run(['docker','rm',identity])
 docs=work/'installed-image-docs';assert sha((docs/'source.tar.gz').read_bytes())=='e52e8faf698f81d6727a62ee2f5212e75898ea1c66e9980e7455f169d12b009b';assert sha((docs/'manifest.json').read_bytes())=='b241f0dbbe9ae2ac120ffc915cf756cb277dd8f2659a6b9eafdd49a2d9dd6516';assert sha((docs/'listmonk.bin').read_bytes())=='4abc9b3bac58ede5a922479ba703486248ca5218a84e263a03af56a47e0860bb'
 user=str(os.getuid())+':'+str(os.getgid())
 def py(name):return run(['docker','run','--rm','--network','none','--read-only','--user',user,'--mount','type=bind,source='+str(work)+',target=/bundle','-e','PYTHONDONTWRITEBYTECODE=1',PY,'python','/bundle/'+name])
 py('extract-source.py')
 def go(source,output,code,network='none'):
  return run(['docker','run','--rm','--network',network,'--read-only','--user',user,'--cpus','2','--memory','2g','--tmpfs','/tmp:rw,exec,nosuid,nodev,size=1073741824,mode=1777','--mount','type=bind,source='+str(work/source)+',target=/src,readonly','--mount','type=bind,source='+str(work/'module-cache')+',target=/cache','--mount','type=bind,source='+str(work/'compile-cache')+',target=/gocache','--mount','type=bind,source='+str(work/output)+',target=/out','-e','GOMODCACHE=/cache','-e','GOCACHE=/gocache','-e','GOPATH=/tmp/gopath','-e','GOTOOLCHAIN=local','-e','GOWORK=/src/go.work','-e','GOPROXY='+('https://proxy.golang.org' if network=='bridge' else 'off'),'-e','GOSUMDB='+('sum.golang.org' if network=='bridge' else 'off'),'-e','CGO_ENABLED=0','-w','/src/listmonk',GO,'sh','-ec',code])
 go('installed-source','baseline-build','go mod download && go mod verify','bridge')
 command='GOOS=linux GOARCH=amd64 go build -trimpath -buildvcs=false -o /out/listmonk.unstuffed -ldflags="-s -w -X main.buildString=v6.1.0-crm-regular-fe301a0926a5 -X main.versionString=v6.1.0 -X main.graphCacheRuntimeSHA=52991c68b5d94dd469b7b0d3a1bc731db108c3e4d139a17351690ae7c37a3335" ./cmd'
 go('installed-source','baseline-build',command+' && go build -trimpath -buildvcs=false -o /out/stuffbin github.com/knadh/stuffbin/stuffbin')
 prefix=sha((work/'baseline-build/listmonk.unstuffed').read_bytes());assert prefix=='2ed409125aedd9f829bf851119561cbd05d1be0e80b019fc983b9784c1f794e9'
 write(work/'baseline-compile.safe.json',(json.dumps({'byteExact':True,'baselineCompiledPrefixSha256':prefix})+'\n').encode())
 py('prepare-installed-assets.py')
 def pack(which):run(['docker','run','--rm','--network','none','--read-only','--user',user,'--mount','type=bind,source='+str(work)+',target=/bundle','-e','PYTHONDONTWRITEBYTECODE=1',PY,'python','/bundle/pack-exact-assets.py',which])
 pack('baseline');run(['node',work/'prepare-candidate-source.mjs']);go('candidate-source','candidate-build',command);pack('candidate')
 # The published executable must exactly match the independently built local candidate.
 assert sha((work/'candidate-build/listmonk').read_bytes())=='4fbdf596c1f4abfaf2b544ec922bc862de1f247ce5766cce747288af55c2dfaa'
 testenv={**os.environ,'GOMODCACHE':str(work/'module-cache'),'GOCACHE':str(work/'host-test-cache'),'GOPATH':str(work/'host-gopath'),'GOTOOLCHAIN':'local','GOWORK':str(work/'candidate-source/go.work'),'GOPROXY':'off','GOSUMDB':'off','CGO_ENABLED':'1' if a.race else '0'}
 assert run(['go','version']).decode().startswith('go version go1.26.1 ')
 testargs=['go','test','-json','-count=1','-timeout=120s']+(['-race'] if a.race else [])
 outputs=[run(testargs+['./internal/manager','./internal/messenger/email','./models'],env=testenv,cwd=work/'candidate-source/listmonk'),run(testargs+['./cmd/graph_cache.go','./cmd/graph_cache_test.go'],env=testenv,cwd=work/'candidate-source/listmonk'),run(testargs+['./guardedproof'],env=testenv,cwd=work/'candidate-source/smtppool')]
 focal=work/'focal-smtp';focal.mkdir(mode=0o700)
 for name in ('go.mod','pool.go','email.go','guarded.go'):shutil.copyfile(work/'candidate-source/smtppool'/name,focal/name)
 shutil.copyfile(HERE/'package/predata_retry_test.go',focal/'predata_retry_test.go');outputs.append(run(testargs+['.'],env={**testenv,'GOWORK':'off'},cwd=focal))
 raw=b''.join(outputs);events=[json.loads(line) for line in raw.splitlines() if line];assert not any(e.get('Action')=='fail' for e in events)
 write(work/'go-tests.synthetic.private.jsonl',raw);write(work/'go-tests.safe.json',(json.dumps({'schema':'smtp-ci-go-tests-v1','race':a.race,'testsPassed':sum(e.get('Action')=='pass' and 'Test'in e for e in events),'failed':0,'outputSha256':sha(raw)})+'\n').encode())
 py('prepare-image.py');run(['docker','build','--platform','linux/amd64','--pull=false','--network','none','--provenance=false','--tag',a.tag,work/'candidate-context'])
 original=json.loads(run(['docker','image','inspect',BASE]))[0];candidate=json.loads(run(['docker','image','inspect',a.tag]))[0]
 keys=('Entrypoint','Cmd','WorkingDir','Env','ExposedPorts','User','Volumes','StopSignal','Healthcheck','ArgsEscaped')
 assert all(original['Config'].get(k)==candidate['Config'].get(k) for k in keys);assert all(candidate['RootFS']['Layers'][i]==v for i,v in enumerate(original['RootFS']['Layers']))
 assert candidate['Architecture']=='amd64' and candidate['Os']=='linux'
 version=run(['docker','run','--rm','--platform','linux/amd64','--network','none','--read-only','--user','1000:1000','--entrypoint','/listmonk/listmonk',a.tag,'--version']).decode();assert 'v6.1.0-crm-regular-fe301a0926a5' in version
 # The sole candidate runs --version only. No database, app listener or real SMTP is used.
 proof={'schema':'smtp-repair-ci-build-v1','baselineImage':BASE,'baselineBinaryByteExact':True,'candidateBinarySha256':'4fbdf596c1f4abfaf2b544ec922bc862de1f247ce5766cce747288af55c2dfaa','candidateImage':a.tag,'candidateImageId':candidate['Id'],'runtimeConfigPreserved':True,'batchJitPreserved':True,'embeddedAssetsPreserved':130,'settingsModified':False,'race':a.race,'testsPassed':sum(e.get('Action')=='pass' and 'Test'in e for e in events),'published':False,'productionCalls':0}
 write(out/'BUILD.safe.json',(json.dumps(proof,indent=2)+'\n').encode());print(json.dumps(proof))
if __name__=='__main__':main()
