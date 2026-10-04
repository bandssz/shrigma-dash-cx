'use strict';
// Disposable CI proof only. No source read or Docker in the default OFF path.
if(process.env.READ_MANUAL_RECONCILE_OCI_PROOF!=='1'||process.env.CI!=='true'){
 process.stdout.write('{"state":"OFF","dockerCalls":0,"postgresCalls":0}\n');
}else{
 const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),cp=require('node:child_process');
 const IMAGE='ghcr.io/bandssz/shrigma-dash-operational-canary@sha256:5ca20e4ea134b7a1a139b80c74a65573a4386d9584fcac40aeedaeb9cf8fe815';
 const SOURCE_PINS={
  'remote-operator.cjs':'c780d91c178dfe00ffdc9af7265211ceeb66e12d14a096b60895f306141d3df5',
  'public-postcondition.cjs':'661bcac5bb4a467bf7f7ce90b974a2294b37209b724e59bd6c7036bd57b666d1',
  'operator.cjs':'b3a6972dc8d3ce9d30d95c717c703efd293592cc14222392968df61887fca1f0',
  '../crm-manager-read-activation-review/compose/build-compose.cjs':'0be6f7b41433eab086a4a9f1fb5bf4e49cc611f9d257d7c9dfc27067571a00ea'
 };
 const OWNER='com.shrigma.manual-reconcile-ci-owner',PURPOSE='com.shrigma.manual-reconcile-ci-purpose';
 const owner=crypto.randomUUID(),containers=[],volumes=[],hash=b=>crypto.createHash('sha256').update(b).digest('hex');
 let calls=0,passed=false,dockerConfig;const fail=()=>{throw Error('MANUAL_RECONCILE_OCI_PROOF_REFUSED');};
 function childEnv(){const env={...process.env};for(const name of Object.keys(env))if(name.startsWith('DOCKER_'))delete env[name];return env;}
 function docker(args,accepted=[0]){
  if(!dockerConfig)fail();calls++;const r=cp.spawnSync('/usr/bin/docker',['--config',dockerConfig,'--host','unix:///var/run/docker.sock',...args],{encoding:'utf8',timeout:120000,maxBuffer:1048576,env:childEnv()});
  if(!accepted.includes(r.status)||r.signal||r.error)fail();return r;
 }
 function inspect(cid){
  if(!/^[a-f0-9]{64}$/.test(cid)||!containers.includes(cid))fail();
  const rows=JSON.parse(docker(['inspect',cid]).stdout);
  if(rows.length!==1||rows[0].Id!==cid||rows[0].Config.Labels?.[OWNER]!==owner||rows[0].Config.Labels?.[PURPOSE]!=='no-sql-original-ledger')fail();return rows[0];
 }
 function inspectVolume(name){
  if(!volumes.includes(name))fail();const rows=JSON.parse(docker(['volume','inspect',name]).stdout);
  if(rows.length!==1||rows[0].Name!==name||rows[0].Labels?.[OWNER]!==owner||rows[0].Labels?.[PURPOSE]!=='no-sql-original-ledger')fail();return rows[0];
 }
 function createVolume(name){
  if(!/^shrigma-read-(?:source|stage)-[a-f0-9]{32}$/.test(name))fail();
  if(docker(['volume','ls','--format','{{.Name}}']).stdout.split('\n').includes(name))fail();
  docker(['volume','create','--label',OWNER+'='+owner,'--label',PURPOSE+'=no-sql-original-ledger',name]);volumes.push(name);inspectVolume(name);
 }
 function create(role,command,mounts,initializer=false){
  const uid=initializer?'0:0':'1000:1000',mem=initializer?67108864:335544320,cpu=initializer?0.1:0.35,pids=initializer?16:64;
  const args=['create','--label',OWNER+'='+owner,'--label',PURPOSE+'=no-sql-original-ledger','--label','com.shrigma.manual-reconcile-ci-role='+role,'--user',uid,'--read-only','--no-healthcheck','--cap-drop','ALL','--security-opt','no-new-privileges','--network','none','--memory',String(mem),'--memory-swap',String(mem),'--cpus',String(cpu),'--pids-limit',String(pids)];
  if(initializer)args.push('--cap-add','CHOWN');else args.push('--init','--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777');
  for(const mount of mounts)args.push('--mount',mount);
  args.push('--entrypoint',initializer?'node':'timeout',IMAGE,...(initializer?command:['-s','KILL','600',...command]));
  const cid=docker(args).stdout.trim();if(!/^[a-f0-9]{64}$/.test(cid))fail();containers.push(cid);const x=inspect(cid);
  const added=x.HostConfig.CapAdd||[],capAddOkay=Array.isArray(added)&&(initializer?added.length===1&&(added[0]==='CHOWN'||added[0]==='CAP_CHOWN'):added.length===0);
  if(x.Config.User!==uid||JSON.stringify(x.Config.Healthcheck?.Test)!==JSON.stringify(['NONE'])||x.HostConfig.ReadonlyRootfs!==true||x.HostConfig.NetworkMode!=='none'||x.HostConfig.Memory!==mem||x.HostConfig.MemorySwap!==mem||x.HostConfig.NanoCpus!==Math.round(cpu*1e9)||x.HostConfig.PidsLimit!==pids||JSON.stringify(x.HostConfig.CapDrop)!==JSON.stringify(['ALL'])||!capAddOkay||!(x.HostConfig.SecurityOpt||[]).some(v=>v==='no-new-privileges'||v==='no-new-privileges:true')||(x.Config.Env||[]).some(v=>/^(?:PG|READ_)/.test(v)))fail();
  if(!initializer&&(x.HostConfig.Init!==true||x.HostConfig.Tmpfs?.['/tmp']!=='rw,nosuid,nodev,noexec,size=16m,mode=1777'))fail();return cid;
 }
 function completed(cid){inspect(cid);docker(['start',cid]);if(docker(['wait',cid]).stdout.trim()!=='0')fail();const x=inspect(cid);if(x.State.Running||x.State.ExitCode!==0)fail();}
 try{
  if(process.platform!=='linux'||process.versions.node.split('.')[0]!=='22'||process.argv.length!==4||process.argv[2]!=='--approved-ci-only'||!fs.lstatSync('/var/run/docker.sock').isSocket())fail();fs.accessSync('/usr/bin/docker',fs.constants.X_OK);
  const directory=process.argv[3];if(!path.isAbsolute(directory)||path.resolve(directory)!==directory||fs.realpathSync(directory)!==directory)fail();
  for(const [name,pin]of Object.entries(SOURCE_PINS)){const file=path.resolve(directory,name),st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||hash(fs.readFileSync(file))!==pin)fail();}
  const C=require(path.resolve(directory,'../crm-manager-read-activation-review/compose/build-compose.cjs')),R=require(path.join(directory,'remote-operator.cjs')),P=require(path.join(directory,'public-postcondition.cjs'));
  if(C.IMAGE!==IMAGE||Object.keys(C.PINS).length!==9)fail();
  const sources=Object.fromEntries(Object.entries(C.PINS).map(([name,pin])=>{const file=path.resolve(directory,'../crm-manager-read-activation-review/runtime',name),st=fs.lstatSync(file),bytes=fs.readFileSync(file);if(!st.isFile()||st.isSymbolicLink()||hash(bytes)!==pin)fail();return[name,bytes.toString('utf8')];}));
  // All identities are generated here; no public-plan.json or reserved real IDs.
  const intent={schema:'crm-manager-read-runtime-intent-v1',operationId:crypto.randomUUID(),credentialIntentId:crypto.randomUUID(),action:'stage',fromPhase:'empty'},suffix=crypto.randomBytes(6).toString('hex');
  const stage=R.buildStagePlan({suffix,sources,intent,domainId:crypto.randomUUID(),isolatedProject:true});
  let childSuffix;do{childSuffix=crypto.randomBytes(6).toString('hex');}while(childSuffix===suffix);
  const reconcile=R.buildReconcilePlan({suffix:childSuffix,stagePlan:stage,domainId:crypto.randomUUID()}),probe=P.buildPublicPostcondition({remotePlan:reconcile});
  const sourceName=stage.descriptor.compose.volumes.source.name,ledgerName=stage.descriptor.compose.volumes.ledger.name;
  if(C.IMAGE!==stage.descriptor.image||Object.keys(probe.compose.services).join(',')!=='gateway'||probe.compose.services.gateway.depends_on!==undefined||probe.compose.services.gateway.env_file!==undefined||probe.compose.volumes.source.name!==sourceName||probe.compose.volumes.ledger.name!==ledgerName||probe.compose.volumes.source.external!==true||probe.compose.volumes.ledger.external!==true)fail();
  dockerConfig=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'manual-reconcile-docker-config-')));fs.chmodSync(dockerConfig,0o700);
  const images=JSON.parse(docker(['image','inspect',IMAGE]).stdout);
  if(images.length!==1||!(images[0].RepoDigests||[]).includes(IMAGE)||!images[0].Config||images[0].Config.Volumes&&Object.keys(images[0].Config.Volumes).length)fail();
  createVolume(sourceName);createVolume(ledgerName);
  const ledgerMount='type=volume,source='+ledgerName+',target=/runtime-proof,volume-nocopy',sourceRO='type=volume,source='+sourceName+',target=/review,readonly,volume-nocopy';
  // Fixture initialization only: the frozen two-volume initializer, once.
  const init=create('synthetic-fixture-initializer',stage.descriptor.compose.services['init-volumes'].command,['type=volume,source='+sourceName+',target=/source-volume,volume-nocopy',ledgerMount],true);completed(init);
  const seed="'use strict';const fs=require('node:fs'),J=require('/review/journal.cjs');if(process.getuid()!==1000||process.getgid()!==1000||fs.readdirSync('/runtime-proof').length)throw 0;J.createJournal('/runtime-proof').create("+JSON.stringify(intent)+");";
  const seedCid=create('synthetic-journal-intent-only',['node','--max-old-space-size=96','-e',seed],[sourceRO,ledgerMount]);completed(seedCid);
  const snapshot="'use strict';const fs=require('node:fs'),c=require('node:crypto'),id="+JSON.stringify(intent.operationId)+",J=require('/review/journal.cjs'),h=J.createJournal('/runtime-proof').readDurable(id);if(h.events.length||JSON.stringify(h.intent)!=="+JSON.stringify(JSON.stringify(intent))+")throw 0;const base='/runtime-proof/',names=fs.readdirSync(base);if(JSON.stringify(names)!==JSON.stringify([id]))throw 0;const entries=fs.readdirSync(base+id).sort();if(JSON.stringify(entries)!==JSON.stringify(['00.json']))throw 0;const b=fs.readFileSync(base+id+'/00.json');process.stdout.write(JSON.stringify({files:entries,bytes:b.length,sha256:c.createHash('sha256').update(b).digest('hex')}));";
  const snapshotCid=create('synthetic-original-ledger-snapshot',['node','--max-old-space-size=96','-e',snapshot],[sourceRO,ledgerMount]);
  docker(['start',snapshotCid]);if(docker(['wait',snapshotCid]).stdout.trim()!=='0')fail();const before=JSON.parse(docker(['logs',snapshotCid]).stdout);
  const gateway=create('public-reconcile-gateway-only',probe.command,[sourceRO,ledgerMount]),x=inspect(gateway);
  const mounts=x.Mounts.filter(v=>v.Type==='volume');if(mounts.length!==2||!mounts.some(v=>v.Destination==='/review'&&v.Name===sourceName&&v.RW===false)||!mounts.some(v=>v.Destination==='/runtime-proof'&&v.Name===ledgerName&&v.RW===true))fail();
  docker(['start',gateway]);
  const getCode="const q=require('node:http').get({host:'127.0.0.1',port:8099,path:'/status',headers:{host:"+JSON.stringify(reconcile.descriptor.domain.host)+"},timeout:1500},r=>{let b=0,s='';if(r.statusCode!==200)throw 0;r.on('data',x=>{b+=x.length;if(b>4096)throw 0;s+=x;});r.on('end',()=>process.stdout.write(s));});q.on('error',()=>process.exitCode=1);q.on('timeout',()=>q.destroy());";
  let raw;for(let n=0;n<30;n++){const r=docker(['exec','--user','1000:1000',gateway,'node','-e',getCode],[0,1]);if(r.status===0&&r.stdout){raw=r.stdout;break;}Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,200);}if(!raw)fail();
  const first=P.acceptPostcondition(raw,reconcile),second=P.acceptPostcondition(docker(['exec','--user','1000:1000',gateway,'node','-e',getCode]).stdout,reconcile);
  if(first.ledgerPhase!=='original_intent_held'||first.ledgerEmpty!==false||second.originalIntentHeld!==true||first.runtimeExecuted!==false)fail();
  const after=JSON.parse(docker(['exec','--user','1000:1000',gateway,'node','-e',snapshot]).stdout);if(JSON.stringify(before)!==JSON.stringify(after))fail();
  passed=true;
 }catch{process.exitCode=1;}
 finally{
  let cleaned=true;for(const cid of [...containers].reverse()){try{inspect(cid);docker(['rm','--force',cid]);}catch{cleaned=false;}}
  for(const name of [...volumes].reverse()){try{inspectVolume(name);docker(['volume','rm',name]);}catch{cleaned=false;}}
  if(dockerConfig){try{const st=fs.lstatSync(dockerConfig);if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid()||(st.mode&0o7777)!==0o700)fail();fs.rmSync(dockerConfig,{recursive:true});}catch{cleaned=false;}}
  if(!cleaned)process.exitCode=1;
  process.stdout.write(JSON.stringify({schema:'crm-manager-read-manual-reconcile-oci-proof-v1',state:passed&&cleaned?'verified':'refused',syntheticOnly:true,originalIntentHeld:passed,ledgerBytesUnchanged:passed,runtimeExecuted:false,postgresCalls:0,privateCredentialsOpened:false,cleanupOwnLabelsOnly:cleaned,dockerCalls:calls})+'\n');
 }
}
