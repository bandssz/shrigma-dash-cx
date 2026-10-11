#!/usr/bin/env python3
"""SOURCE-only hydration/build and ONE new real executable proof. Inert import."""
import argparse,hashlib,importlib.util,json,os,re,selectors,signal,subprocess,time
from pathlib import Path
HERE=Path(__file__).resolve().parent
EXPECTED={'TestPhysicalFullWiringIdleRunJoins','TestPhysicalFullWiringBothQueuesMustJoin','TestPhysicalFullWiringExpiredDrainNeverExit'}
EMAIL_EXPECTED={'TestPhysicalFullWiringDirectSMTPAdmissionJoin'}
IMPORT_PUBLIC_PINS = {'cmd/import.go': {'bytes': 4578, 'sha256': 'e1687da2f1280dccce68228294ba9d2a87c943dc79dbe786e3311099de549a29'}, 'cmd/handlers.go': {'bytes': 17416, 'sha256': '5326def67f06719777aee440d45dc0fbe046d25f40610906404ca0d64bbad2a1'}, 'internal/subimporter/importer.go': {'bytes': 19170, 'sha256': 'df3c6087107d0e0cc2285eb6adab7a9cee4bf3402e12259029e9e6742c8bf090'}, 'internal/notifs/notifs.go': {'bytes': 2868, 'sha256': 'f5944a0b6912554d25f1bd3694082b1eb7c89e6e9c83fe2ee1be22b9271d2c47'}, 'internal/auth/models.go': {'bytes': 9568, 'sha256': '149819b4e06048968d81ff77d975d259d64c4392e33c7bd419648b74fe55ae60'}, 'queries/users.sql': {'bytes': 5712, 'sha256': '5a802f86d701895904da11da0933016b5f807fc3c429483faa50555a448aadcd'}}
def need(v,c):
 if not v:raise ValueError(c)
def sha(b):return hashlib.sha256(b).hexdigest()
def body(p,limit=2097152):
 need(p.is_file() and not p.is_symlink() and p.stat().st_size<=limit,'SOURCE_BOUND_REFUSED');return p.read_bytes()
def mod(n,p):
 s=importlib.util.spec_from_file_location(n,p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
def call(argv,cwd,env,seconds):
 child=subprocess.Popen([str(x) for x in argv],cwd=cwd,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
 deadline=time.monotonic()+seconds;buf={'stdout':bytearray(),'stderr':bytearray()};sel=selectors.DefaultSelector()
 sel.register(child.stdout,selectors.EVENT_READ,'stdout');sel.register(child.stderr,selectors.EVENT_READ,'stderr')
 try:
  while sel.get_map():
   need(time.monotonic()<deadline,'FOCAL_PROCESS_TIMEOUT')
   for k,_ in sel.select(min(.25,max(0,deadline-time.monotonic()))):
    b=os.read(k.fileobj.fileno(),16384)
    if not b:sel.unregister(k.fileobj);continue
    buf[k.data].extend(b);need(sum(map(len,buf.values()))<=1048576,'FOCAL_OUTPUT_BOUND')
  code=child.wait(timeout=max(.01,deadline-time.monotonic()))
  return code,bytes(buf['stdout']),bytes(buf['stderr'])
 except Exception:
  try:os.killpg(child.pid,signal.SIGKILL)
  except ProcessLookupError:pass
  child.wait(timeout=2);raise
 finally:sel.close();child.stdout.close();child.stderr.close()
def env(args,network=False):
 e={'PATH':os.environ.get('PATH','/usr/bin:/bin'),'LANG':'C.UTF-8','GOPATH':str(args.out/'go-path'),
    'GOWORK':str(args.out/'go.work'),'GOTOOLCHAIN':'local','CGO_ENABLED':'0','GOCACHE':str(args.out/'go-cache'),
    'GOMODCACHE':str(args.out/'go-mod-cache'),'GOPROXY':'https://proxy.golang.org' if network else 'off','GOSUMDB':'sum.golang.org' if network else 'off'}
 return e
def common(a):
 need(os.getuid()==1000 and os.environ.get('PHYSICAL_DRAIN_FIXTURE_ISOLATED')=='1','FIXTURE_ISOLATION_REFUSED')
 repo=a.repo_root.resolve(strict=True);need(not (repo/'.git').exists() and not (repo/'.private').exists(),'PUBLIC_SNAPSHOT_REFUSED')
 pins=json.loads(body(HERE/'ASSETS.json'));need(pins['schema']=='physical-drain-full-wiring-assets-v1','ASSETS_SCHEMA_REFUSED')
 for name,p in pins['files'].items():
  b=body(repo/name);need(sha(b)==p['sha256'] and len(b)==p['bytes'],'SOURCE_PIN_REFUSED')
 c,o,e=call(['node','-e',"if(process.version!=='v22.23.3'||process.getuid()!==1000)process.exit(1)"],repo,os.environ,5);need(c==0 and not o and not e,'NODE_RUNTIME_REFUSED')
 c,o,e=call([a.go,'version'],repo,os.environ,5);need(c==0 and o.startswith(b'go version go1.26.1 '),'GO_RUNTIME_REFUSED')
 return repo,pins

def prepare(a):
 repo,pins=common(a);need(not a.out.exists(),'NEW_FIXTURE_REQUIRED');a.out.mkdir(mode=0o700);(a.out/'go-path').mkdir();(a.out/'go-cache').mkdir()
 package=mod('physical_public_package',repo/'tools/listmonk-regular-package/build.py')
 package.extract_source(a.inputs/'listmonk-upstream.tar.gz',a.out/'listmonk');package.extract_smtp(a.inputs/'smtppool.zip',a.out/'smtppool')
 for name,pin in IMPORT_PUBLIC_PINS.items():
  b=body(a.out/'listmonk'/name);need(len(b)==pin['bytes'] and sha(b)==pin['sha256'],'IMPORT_PUBLIC_SOURCE_REFUSED')
 smtp=mod('physical_real_smtp',repo/'tools/listmonk-regular-build/build.py');smtp.apply(a.out/'listmonk',a.out/'smtppool')
 worker=mod('physical_current_worker',repo/'tools/listmonk-regular-build/worker_patch.py')
 profile=repo/'crm-scheduler-batch-profile.json';old=worker.apply(a.out/'listmonk',repo,profile,sha(body(profile)))
 overlay=mod('physical_new_stage',repo/'tools/listmonk-physical-drain/apply.py');after=overlay.apply(a.out/'listmonk')
 # Recompute graph SOURCE digest from its exact old source list after main's
 # changed bytes. This is a synthetic new build identity, never old639's hash.
 graph_names=worker.LOCK['graph_cache']['runtime_sources']['worker']
 graph_sha,_=worker.graph_runtime_sha(repo,{n:(body(a.out/'listmonk'/n),body(a.out/'listmonk'/n)) for n in graph_names},{})
 need(graph_sha!=old['graph_cache_runtime_sha256'],'NEW_SOURCE_IDENTITY_REQUIRED')
 (a.out/'go.work').write_text('go 1.26.1\n\nuse (\n ./listmonk\n ./smtppool\n)\n')
 e=env(a,True)
 for sub in ('listmonk','smtppool'):
  c,o,x=call([a.go,'mod','download'],a.out/sub,e,180);need(c==0,'GO_PUBLIC_DEPENDENCIES_REFUSED')
 e=env(a)
 # Original official release assets are reused exactly; no frontend stub.
 parser=mod('physical_official_release',repo/'tools/listmonk-ab-build/build.py');entry=parser.LOCK['releases']['linux_amd64'];check=parser.LOCK['checksums']
 release=body(a.inputs/entry['name'],67108864);checks=body(a.inputs/check['name'])
 need(sha(release)==entry['sha256'] and sha(checks)==check['sha256'],'RELEASE_PIN_REFUSED')
 need(checks.decode().splitlines().count(entry['sha256']+'  '+entry['name'])==1,'RELEASE_CHECKSUM_REFUSED')
 assets=parser.inspect_stuffed(parser.release_files(release)['listmonk'])['assets'];need(len(assets)==130,'OFFICIAL_ASSET_SHAPE_REFUSED')
 query=body(a.out/'listmonk/queries/campaigns.sql');query_sha=sha(query)
 need(query_sha==json.loads(body(profile))['querySha256'],'QUERY_IDENTITY_DRIFT')
 tool=a.out/'stuffbin';c,o,x=call([a.go,'build','-trimpath','-buildvcs=false','-o',tool,'github.com/knadh/stuffbin/stuffbin'],a.out/'listmonk',e,180);need(c==0,'OFFICIAL_STUFFBIN_COMPILE_REFUSED')
 # Populate only missing compile-time embedded static assets with official
 # bytes; the patched query remains untouched and is the sole stuffed delta.
 for name,asset in assets.items():
  p=a.out/'listmonk'/name.lstrip('/')
  if not p.exists():p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(asset['body'])
 tests=a.out/'listmonk/internal/manager/physical_full_wiring_test.go';need(not tests.exists(),'TEST_NAME_DRIFT');tests.write_bytes(body(HERE/'manager_test.go'))
 exe_test=a.out/'manager.test';c,o,x=call([a.go,'test','-c','-o',exe_test,'./internal/manager'],a.out/'listmonk',e,180);need(c==0,'NEW_MANAGER_TEST_COMPILE_REFUSED')
 tests_email=a.out/'listmonk/internal/messenger/email/physical_full_wiring_test.go';need(not tests_email.exists(),'EMAIL_TEST_NAME_DRIFT');tests_email.write_bytes(body(HERE/'email_test.go'))
 exe_email=a.out/'email.test';c,o,x=call([a.go,'test','-c','-o',exe_email,'./internal/messenger/email'],a.out/'listmonk',e,180);need(c==0,'NEW_EMAIL_TEST_COMPILE_REFUSED')
 raw=a.out/'listmonk.unstuffed';c,o,x=call([a.go,'build','-trimpath','-buildvcs=false','-ldflags=-X main.versionString=v6.1.0 -X main.buildString=physical-drain-synthetic -X main.graphCacheRuntimeSHA='+graph_sha,'-o',raw,'./cmd'],a.out/'listmonk',e,180);need(c==0,'FULL_EXECUTABLE_COMPILE_REFUSED')
 directory=a.out/'assets';directory.mkdir();args=[]
 for i,(name,asset)in enumerate(sorted(assets.items())):
  p=directory/str(i);p.write_bytes(query if name==parser.QUERY else asset['body']);p.chmod(0o644);os.utime(p,(1774790840,1774790840));args.append(str(p)+':'+name)
 binary=a.out/'listmonk.bin';c,o,x=call([tool,'-a','stuff','-in',raw,'-out',binary,*args],a.out/'listmonk',e,60);need(c==0,'STUFFED_EXECUTABLE_REFUSED');binary.chmod(0o755)
 # Name consumed by Node avoids clashing with hydrated source directory.
 stuffed=parser.inspect_stuffed(body(binary,268435456));need(stuffed['prefix']==body(raw,268435456),'EXECUTABLE_PREFIX_REFUSED')
 need(set(stuffed['assets'])==set(assets),'ASSET_SET_DRIFT')
 changed=[n for n in assets if stuffed['assets'][n]['body']!=assets[n]['body']];need(changed==[parser.QUERY],'UNRELATED_ASSET_DRIFT')
 receipt={'schema':'physical-drain-full-synthetic-build-v1','binarySha256':sha(body(binary,268435456)),
  'managerTestSha256':sha(body(exe_test,268435456)),'emailTestSha256':sha(body(exe_email,268435456)),'querySha256':query_sha,'futureGraphSourceSha256':graph_sha,
  'newSourceFiles':after,'oldCandidate639Reused':False,'operational':False,'originalCalls':0}
 (a.out/'compile.json').write_text(json.dumps(receipt,indent=2)+'\n')

def proof(a):
 start=time.monotonic();repo,pins=common(a);r=json.loads(body(a.out/'compile.json'))
 need(sha(body(a.out/'manager.test',268435456))==r['managerTestSha256'],'COMPILED_TEST_DRIFT')
 e=env(a);pattern='^('+'|'.join(sorted(EXPECTED))+')$'
 c,o,x=call([a.go,'tool','test2json','-t','-p','github.com/knadh/listmonk/internal/manager',a.out/'manager.test','-test.v','-test.count=1','-test.timeout=5s','-test.run='+pattern],a.out/'listmonk',e,8)
 events=[json.loads(line) for line in o.splitlines()];passed={ev.get('Test')for ev in events if ev.get('Action')=='pass' and ev.get('Test')}
 need(c==0 and passed==EXPECTED and not any(ev.get('Action')in('fail','skip')for ev in events),'NEW_MANAGER_TEST_REFUSED')
 need(sha(body(a.out/'email.test',268435456))==r['emailTestSha256'],'COMPILED_EMAIL_TEST_DRIFT')
 c,o,x=call([a.go,'tool','test2json','-t','-p','github.com/knadh/listmonk/internal/messenger/email',a.out/'email.test','-test.v','-test.count=1','-test.timeout=5s','-test.run=^TestPhysicalFullWiringDirectSMTPAdmissionJoin$'],a.out/'listmonk',e,8)
 events=[json.loads(line)for line in o.splitlines()];email_passed={ev.get('Test')for ev in events if ev.get('Action')=='pass'and ev.get('Test')}
 need(c==0 and email_passed==EMAIL_EXPECTED and not any(ev.get('Action')in('fail','skip')for ev in events),'NEW_EMAIL_TEST_REFUSED')
 e.update(NODE_PATH=os.environ['NODE_PATH'],PHYSICAL_DRAIN_FIXTURE_ISOLATED='1',PHYSICAL_DRAIN_RECEIPT=str(a.report))
 remaining=60-(time.monotonic()-start);need(remaining>10,'PROOF_BUDGET_REFUSED')
 c,o,x=call(['node',HERE/'native-proof.cjs',a.out],repo,e,remaining)
 need(a.report.exists(),'NATIVE_RECEIPT_MISSING')
 report=json.loads(body(a.report));report['newManagerCases']=sorted(passed);report['newManagerCaseCount']=3;report['executionWithManagerSeconds']=round(time.monotonic()-start,3)
 report.update(newEmailerCases=sorted(email_passed),newEmailerCaseCount=1,directPushHeldUntilAck=True,directPushAfterBarrierRefused=True,totalNewCaseCount=10)
 report['ok']=report['ok'] and c==0 and report['executionWithManagerSeconds']<=60
 a.report.write_text(json.dumps(report,indent=2)+'\n');a.report.chmod(0o644)
 need(report['ok'],'REAL_EXECUTABLE_PROOF_REFUSED')
 return report

def main():
 p=argparse.ArgumentParser();p.add_argument('mode',choices=('prepare','proof'))
 for n in ('repo-root','inputs','go','out','report'):p.add_argument('--'+n,type=Path,required=True)
 a=p.parse_args();need(not a.report.exists(),'REPORT_ALREADY_EXISTS');phase=a.mode
 try:
  if phase=='prepare':prepare(a);r={'ok':True,'phase':'full-executable-compiled-not-executed','originalCalls':0,'operational':False}
  else:r=proof(a)
 except Exception as exc:
  c=str(exc);r={'schema':'physical-drain-full-synthetic-refusal-v1','ok':False,'phase':phase,
   'refusalCode':c if re.fullmatch('[A-Z0-9_]{1,80}',c) else 'FOCAL_SOURCE_REFUSED','exceptionType':type(exc).__name__,'originalCalls':0,'operational':False}
  if a.report.exists():
   try:r['closedNativeReport']=json.loads(body(a.report))
   except Exception:pass
 if phase=='prepare' or not a.report.exists():a.report.parent.mkdir(parents=True,exist_ok=True);a.report.write_text(json.dumps(r,indent=2)+'\n');a.report.chmod(0o644)
 print(json.dumps({k:r[k]for k in ('ok','phase','refusalCode','caseCount')if k in r}));return 0 if r['ok'] else 1
if __name__=='__main__':raise SystemExit(main())
