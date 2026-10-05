#!/usr/bin/env python3
# CI adapter for public build/OCI/registry evidence. No production environment or SQL.
import argparse,hashlib,json,os,pathlib,re,shutil,subprocess,tempfile
ap=argparse.ArgumentParser();ap.add_argument('phase',choices=['gate','build','publish','anonymous']);ap.add_argument('kind',choices=['portal','campaign','read','writer','template']);args=ap.parse_args()
HERE=pathlib.Path(__file__).resolve().parent;plan=json.loads((HERE/'image-plan.json').read_text());revision=plan['sourceRevision'];p=next(x for x in plan['images'] if x['kind']==args.kind)
assert re.fullmatch('[a-f0-9]{40}',revision) and len(plan['sourceJobsExpected'])==17 and plan['defaultPublisherEnabled'] is False
assert p['image']=='ghcr.io/bandssz/shrigma-dash-operational-canary:crm-'+args.kind+'-'+revision+'-20261005'
source=pathlib.Path(os.environ['GITHUB_WORKSPACE'])/'source';runner=pathlib.Path(os.environ['RUNNER_TEMP']);proof=runner/('crm-stack-'+args.kind+'-proof');proof.mkdir(exist_ok=True)
phase=args.phase
REPO='ghcr.io/bandssz/shrigma-dash-operational-canary'
def require(v):
 if not v:raise RuntimeError('REFUSED')
def invoke(command,**kw):
 r=subprocess.run(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=kw.pop('timeout',300),**kw)
 require(r.returncode==0 and len(r.stdout)<=2*1024*1024);return r.stdout

def jsoncall(command):return json.loads(invoke(command))
def write(name,data):
 file=proof/name;require(not file.exists());file.write_text(json.dumps(data,sort_keys=True)+'\n')
def image_profile(image):
 fmt='{"id":{{json .Id}},"os":{{json .Os}},"architecture":{{json .Architecture}},"user":{{json .Config.User}},"revision":{{json (index .Config.Labels "org.opencontainers.image.revision")}},"source":{{json (index .Config.Labels "org.opencontainers.image.source")}},"base":{{json (index .Config.Labels "org.opencontainers.image.base.name")}},"component":{{json (index .Config.Labels "com.shrigma.component")}}}'
 v=jsoncall(['docker','image','inspect','--format',fmt,image]);require(set(v)=={'id','os','architecture','user','revision','source','base','component'})
 require(re.fullmatch('sha256:[a-f0-9]{64}',v['id']) and v['os']=='linux' and v['architecture']=='amd64' and v['user'] in ['node','1000:1000'] and v['revision']==revision and v['source']=='https://github.com/bandssz/shrigma-dash-cx' and v['base']==p['baseImage'] and v['component']=='crm-'+args.kind)
 return v

def oci(image):
 raw=invoke(['docker','run','--rm','--pull=never','--network','none','--no-healthcheck','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','512m','--memory-swap','512m','--cpus','0.5','--pids-limit','64','--tmpfs','/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777','--tmpfs','/dashboard-data:rw,noexec,nosuid,nodev,size=4m,uid=1000,gid=1000,mode=0700','--mount','type=bind,source='+str(HERE)+',target=/proof,readonly','--entrypoint','node',image,'--max-old-space-size=128','/proof/oci-preflight.cjs',args.kind],timeout=45)
 require(len(raw)<=65536);v=json.loads(raw)
 keys=['schema','kind','sourceRevision','baseImage','nodeVersion','sqliteVersion','os','architecture','uid','gid','pgVersion','checkedRuntimeFiles','portalPack','sqliteBackupApi','disabledContract','applicationStarted','postgresSqlExecuted','syntheticSqliteFixture','providerCalled','network']
 require(set(v)==set(keys));require(v['schema']=='crm-stack-image-oci-v1' and v['kind']==args.kind and v['sourceRevision']==revision and v['baseImage']==p['baseImage'] and v['nodeVersion'].split('.')[0]=='22' and v['os']=='linux' and v['architecture']=='x64' and v['uid']==v['gid']==1000 and v['checkedRuntimeFiles']==len(p['runtimeFiles']) and v['network']=='none')
 require(all(v[k] is False for k in ['applicationStarted','postgresSqlExecuted','providerCalled']))
 if args.kind=='portal':require(v['portalPack']==plan['portalPack'] and v['pgVersion'] is None and v['sqliteBackupApi'] is True and v['syntheticSqliteFixture'] is True and v['disabledContract'] is None)
 else:require(v['portalPack'] is None and v['pgVersion']=='8.13.1' and v['sqliteBackupApi'] is False and v['syntheticSqliteFixture'] is False and v['disabledContract']==(True if args.kind in ['writer','template'] else 'unconfigured-start-refused'))
 return v

def absent():
 r=subprocess.run(['docker','manifest','inspect',p['image']],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30)
 require(r.returncode!=0 and len(r.stderr)<4096)
 err=r.stderr.decode('utf8').strip();require(err in ['no such manifest: '+p['image'],'manifest unknown','manifest unknown: manifest unknown'])

try:
 require(os.environ.get('GITHUB_ACTIONS')=='true' and os.environ.get('GITHUB_REPOSITORY')=='bandssz/shrigma-dash-cx' and os.environ.get('GITHUB_EVENT_NAME')=='push')
 require(invoke(['git','rev-parse','HEAD'],cwd=source).decode().strip()==revision)
 carrier=os.environ['GITHUB_SHA'];require(re.fullmatch('[a-f0-9]{40}',carrier) and carrier!=revision)
 require(invoke(['git','rev-parse','HEAD'],cwd=HERE.parents[1]).decode().strip()==carrier)
 if phase=='gate':
  run=plan['sourceCiRun'];attempt=plan['sourceCiAttempt'];require(attempt==1)
  r=jsoncall(['gh','api','repos/bandssz/shrigma-dash-cx/actions/runs/'+str(run)])
  j=jsoncall(['gh','api','repos/bandssz/shrigma-dash-cx/actions/runs/'+str(run)+'/attempts/1/jobs?per_page=100'])
  require(r['id']==run and r['workflow_id']==plan['sourceWorkflowId'] and r['path']==plan['sourceWorkflowPath'] and r['event']=='push' and r['head_branch']==plan['sourceBranch'] and r['head_sha']==revision and r['run_attempt']==1 and r['status']=='completed' and r['conclusion']=='success')
  require(j['total_count']==17 and len(j['jobs'])==17 and len({x['name'] for x in j['jobs']})==17 and {x['name']:x['conclusion'] for x in j['jobs']}==plan['sourceJobsExpected'])
  require(all(x['status']=='completed' and x['run_id']==run and x['run_attempt']==1 and x['head_sha']==revision for x in j['jobs']))
  safe={k:r[k] for k in ['id','workflow_id','path','event','head_branch','head_sha','status','conclusion','run_attempt']};safe['jobs']=[{k:x[k] for k in ['id','name','status','conclusion','run_id','run_attempt','head_sha']} for x in j['jobs']];write('target-ci.json',safe)
 elif phase=='build':
  require((proof/'target-ci.json').exists());require(invoke(['git','diff','--name-only'],cwd=source).strip()==b'' and invoke(['git','diff','--cached','--name-only'],cwd=source).strip()==b'')
  with tempfile.TemporaryDirectory(prefix='crm-stack-'+args.kind+'-context-',dir=runner) as temporary,tempfile.TemporaryDirectory(prefix='crm-stack-docker-',dir=runner) as cfg:
   context=pathlib.Path(temporary);old=os.environ.get('DOCKER_CONFIG');os.environ['DOCKER_CONFIG']=cfg
   try:
    for f in p['buildInputs']:
     original=source/(p['contextRoot'] if p['contextRoot']!='.' else '')/f['path'];s=original.lstat();require(original.is_file() and not original.is_symlink() and s.st_size==f['bytes']);b=original.read_bytes();require(hashlib.sha256(b).hexdigest()==f['sha256']);target=context/f['path'];target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(b)
    command=['docker','build','--platform','linux/amd64','--file',str(context/p['dockerfile']),'--tag',p['image'],'--label','org.opencontainers.image.revision='+revision,'--label','org.opencontainers.image.source=https://github.com/bandssz/shrigma-dash-cx','--label','org.opencontainers.image.base.name='+p['baseImage'],'--label','com.shrigma.component=crm-'+args.kind]
    for k,v in p['buildArgs'].items():command+=['--build-arg',k+'='+v]
    invoke([*command,str(context)],timeout=600)
    profile=image_profile(p['image']);write('image-config.json',profile);write('preflight-oci.json',oci(profile['id']))
   finally:
    if old is None:os.environ.pop('DOCKER_CONFIG',None)
    else:os.environ['DOCKER_CONFIG']=old
 elif phase=='publish':
  expected=json.loads((proof/'image-config.json').read_text());require(image_profile(p['image'])==expected)
  # Registry auth stays in this own temporary CLI config and is deleted finally.
  with tempfile.TemporaryDirectory(prefix='crm-stack-registry-',dir=runner) as cfg:
   old=os.environ.get('DOCKER_CONFIG');os.environ['DOCKER_CONFIG']=cfg
   try:
    token=os.environ.pop('GHCR_TOKEN');require(token and '\n' not in token);invoke(['docker','login','ghcr.io','--username',os.environ['GITHUB_ACTOR'],'--password-stdin'],input=token.encode());del token
    absent();require(image_profile(p['image'])==expected)
    invoke(['docker','push',p['image']],timeout=300)
    refs=jsoncall(['docker','image','inspect','--format','{{json .RepoDigests}}',p['image']]);require(len(refs)==1 and re.fullmatch(re.escape(REPO)+'@sha256:[a-f0-9]{64}',refs[0]));write('pushed-image-reference.json',{'reference':refs[0]})
   finally:
    subprocess.run(['docker','logout','ghcr.io'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=10)
    if old is None:os.environ.pop('DOCKER_CONFIG',None)
    else:os.environ['DOCKER_CONFIG']=old
 elif phase=='anonymous':
  ref=json.loads((proof/'pushed-image-reference.json').read_text())['reference'];require(re.fullmatch(re.escape(REPO)+'@sha256:[a-f0-9]{64}',ref))
  with tempfile.TemporaryDirectory(prefix='crm-stack-anonymous-',dir=runner) as cfg:
   old=os.environ.get('DOCKER_CONFIG');os.environ['DOCKER_CONFIG']=cfg
   try:
    invoke(['docker','pull','--platform','linux/amd64',ref],timeout=300)
    expected=json.loads((proof/'image-config.json').read_text());require(image_profile(ref)==expected)
    post=oci(ref);require(json.loads((proof/'preflight-oci.json').read_text())==post);write('public-digest-oci.json',post)
   finally:
    if old is None:os.environ.pop('DOCKER_CONFIG',None)
    else:os.environ['DOCKER_CONFIG']=old
  publication={'schema':'crm-stack-publication-v1','kind':args.kind,'sourceRevision':revision,'workflowCarrierRevision':os.environ['GITHUB_SHA'],'runId':int(os.environ['GITHUB_RUN_ID']),'runAttempt':int(os.environ['GITHUB_RUN_ATTEMPT']),'tag':p['image'],'imageReference':ref,'imageConfigId':expected['id'],'anonymousPullVerified':True,'publicOciEqualsBuilt':True,'portalPack':plan['portalPack'] if args.kind=='portal' else None,'productionInstalled':False}
  write('publication.json',publication)
  # This closed public receipt is emitted only after anonymous OCI equality.
  print(json.dumps(publication,sort_keys=True))
except BaseException:
 # A failure after push may leave a published image. No deletion or automatic retry.
 raise SystemExit('IMAGE_JOB_REFUSED:'+phase)
