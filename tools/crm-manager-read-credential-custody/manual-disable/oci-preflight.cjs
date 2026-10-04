'use strict';
// Disposable CI-only NO SQL proof. No Docker or file reads in the delivered OFF mode.
if(process.env.MANUAL_DISABLE_OCI_PROOF!=='1'||process.env.CI!=='true'||process.argv[2]!=='--approved-ci-only'){
 process.stdout.write('{"state":"OFF","dockerCalls":0,"postgresCalls":0}\n');
}else{
 const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),cp=require('node:child_process'),M=require('./manual-disable.cjs'),{buildFixture}=require('./fixture.cjs');
 const owner=crypto.randomUUID(),containers=[],volumes=[],hash=b=>crypto.createHash('sha256').update(b).digest('hex'),fail=()=>{throw Error('MANUAL_DISABLE_OCI_PROOF_REFUSED');};
 let calls=0,passed=false,dockerConfig;
 function childEnv(){const env={...process.env};for(const k of Object.keys(env))if(k.startsWith('DOCKER_'))delete env[k];return env;}
 function admittedCapAdd(caps,chown){return Array.isArray(caps)&&(chown?caps.length===1&&(caps[0]==='CHOWN'||caps[0]==='CAP_CHOWN'):caps.length===0);}
 function docker(args,accepted=[0]){if(!dockerConfig)fail();calls++;const r=cp.spawnSync('/usr/bin/docker',['--config',dockerConfig,'--host','unix:///var/run/docker.sock',...args],{encoding:'utf8',timeout:120000,maxBuffer:1048576,env:childEnv()});if(!accepted.includes(r.status)||r.signal||r.error)fail();return r;}
 function inspect(cid){if(!/^[a-f0-9]{64}$/.test(cid)||!containers.includes(cid))fail();const rows=JSON.parse(docker(['inspect',cid]).stdout);if(rows.length!==1||rows[0].Id!==cid||rows[0].Config.Labels['com.shrigma.manual-disable-ci-owner']!==owner)fail();return rows[0];}
 function volume(name){const rows=JSON.parse(docker(['volume','inspect',name]).stdout);if(rows.length!==1||rows[0].Name!==name||rows[0].Labels['com.shrigma.manual-disable-ci-owner']!==owner)fail();return rows[0];}
 function createVolume(name){if(!/^shrigma-read-(?:source|disable)-[a-f0-9]{32}$/.test(name))fail();const names=docker(['volume','ls','--format','{{.Name}}']).stdout.trim().split('\n');if(names.includes(name))fail();docker(['volume','create','--label','com.shrigma.manual-disable-ci-owner='+owner,name]);volumes.push(name);volume(name);}
 function create(role,command,mounts,user,mem,cpu,pids,chown=false){const args=['create','--label','com.shrigma.manual-disable-ci-owner='+owner,'--label','com.shrigma.manual-disable-ci-role='+role,'--user',user,'--read-only','--no-healthcheck','--cap-drop','ALL','--security-opt','no-new-privileges','--network','none','--memory',String(mem),'--memory-swap',String(mem),'--cpus',String(cpu),'--pids-limit',String(pids)];if(chown)args.push('--cap-add','CHOWN');if(user==='1000:1000')args.push('--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777');for(const x of mounts)args.push('--mount',x);args.push('--entrypoint','node',M.IMAGE,...command);const cid=docker(args).stdout.trim();if(!/^[a-f0-9]{64}$/.test(cid))fail();containers.push(cid);const x=inspect(cid);if(x.Config.User!==user||JSON.stringify(x.Config.Healthcheck?.Test)!==JSON.stringify(['NONE'])||x.HostConfig.ReadonlyRootfs!==true||x.HostConfig.NetworkMode!=='none'||x.HostConfig.Memory!==mem||x.HostConfig.MemorySwap!==mem||x.HostConfig.NanoCpus!==Math.round(cpu*1e9)||x.HostConfig.PidsLimit!==pids||JSON.stringify(x.HostConfig.CapDrop)!==JSON.stringify(['ALL'])||!admittedCapAdd(x.HostConfig.CapAdd||[],chown)||!(x.HostConfig.SecurityOpt||[]).some(v=>v==='no-new-privileges'||v==='no-new-privileges:true')||(x.Config.Env||[]).some(v=>/^(?:PG_ADMIN_PASSWORD|READ_SERVICE_SCRAM|READ_ACTIVATION_RUNTIME_OPT_IN)=/.test(v)))fail();return cid;}
 function complete(cid){inspect(cid);docker(['start',cid]);const exit=docker(['wait',cid]).stdout.trim();const x=inspect(cid);if(exit!=='0'||x.State.Running||x.State.ExitCode!==0)fail();}
 try{
  if(process.platform!=='linux'||process.versions.node.split('.')[0]!=='22'||!fs.lstatSync('/var/run/docker.sock').isSocket())fail();fs.accessSync('/usr/bin/docker',fs.constants.X_OK);
  dockerConfig=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'manual-disable-docker-config-')));fs.chmodSync(dockerConfig,0o700);
  const fixture=buildFixture(),nonce=crypto.randomUUID(),ns=hash('SYNTHETIC_CI_ONLY:'+nonce).slice(0,32),disable=crypto.randomUUID(),cred=crypto.randomUUID(),original=crypto.randomUUID(),compact=disable.replace(/-/g,''),d=fixture.reservedDisable;
  fixture.original.intent.operationId=original;fixture.original.intent.credentialIntentId=cred;fixture.original.sourceVolume='shrigma-read-source-'+ns;fixture.original.ledgerVolume='shrigma-read-stage-'+ns;fixture.original.serviceName='mgr-stage-'+original.replace(/-/g,'').slice(0,12);
  d.intent.operationId=disable;d.intent.credentialIntentId=cred;d.serviceName='mgr-dis-'+compact.slice(0,12);d.host=d.serviceName+'.tazdb8.easypanel.host';d.domainId=crypto.randomUUID();d.ledgerVolume='shrigma-read-disable-'+compact;d.sourceVolume=fixture.original.sourceVolume;
  fixture.flags.READ_ACTIVATION_OPERATION_ID=disable;fixture.flags.READ_CREDENTIAL_INTENT_ID=cred;
  const p=M.buildPlan(fixture),sources=Object.entries(M.PINS).map(([name,pin])=>{const bytes=fs.readFileSync(path.join(__dirname,'runtime',name));if(hash(bytes)!==pin)fail();return{name,base64:bytes.toString('base64'),sha256:pin};});
  // Own synthetic source-volume fixture only. The manual initializer never writes it.
  createVolume(p.sourceVolume);createVolume(p.ledgerVolume);docker(['image','inspect',M.IMAGE]);
  const seed="'use strict';const fs=require('node:fs'),crypto=require('node:crypto'),entries="+JSON.stringify(sources)+";if(process.getuid()!==0||fs.readdirSync('/source').length)throw 0;for(const x of entries){const b=Buffer.from(x.base64,'base64');if(crypto.createHash('sha256').update(b).digest('hex')!==x.sha256)throw 0;const fd=fs.openSync('/source/'+x.name,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o444);try{fs.writeFileSync(fd,b);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}const fd=fs.openSync('/source',fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{fs.fchmodSync(fd,0o555);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}";
  const sourceMount='type=volume,source='+p.sourceVolume+',target=/source,volume-nocopy',ledgerMount='type=volume,source='+p.ledgerVolume+',target=/runtime-proof,volume-nocopy';
  complete(create('synthetic-source-fixture',['--max-old-space-size=16','-e',seed],[sourceMount],'0:0',67108864,0.1,16));
  complete(create('manual-ledger-initializer',p.bootstrap.services['init-ledger'].command,[ledgerMount],'0:0',67108864,0.1,16,true));
  const gateway=create('public-only-loader',p.publicPreflight.services.gateway.command,[ledgerMount,'type=volume,source='+p.sourceVolume+',target=/review,readonly,volume-nocopy'],'1000:1000',335544320,0.35,64);
  const x=inspect(gateway),source=x.Mounts.filter(m=>m.Destination==='/review'),ledger=x.Mounts.filter(m=>m.Destination==='/runtime-proof');if(source.length!==1||source[0].Name!==p.sourceVolume||source[0].RW!==false||ledger.length!==1||ledger[0].Name!==p.ledgerVolume||ledger[0].RW!==true||x.HostConfig.Tmpfs['/tmp']!=='rw,nosuid,nodev,noexec,size=16m,mode=1777')fail();
  docker(['start',gateway]);
  const getCode="let b=0,s='';const q=require('node:http').get({host:'127.0.0.1',port:8099,path:'/status',headers:{host:"+JSON.stringify(p.host)+"},timeout:1500},r=>{if(r.statusCode!==200)throw 0;r.on('data',c=>{b+=c.length;if(b>2048)throw 0;s+=c;});r.on('end',()=>process.stdout.write(s));});q.on('error',()=>process.exitCode=1);q.on('timeout',()=>q.destroy());";
  let raw;for(let n=0;n<20;n++){const r=docker(['exec','--user','1000:1000',gateway,'node','-e',getCode],[0,1]);if(r.status===0&&r.stdout){raw=r.stdout;break;}Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);}if(!raw)fail();M.acceptPublic(raw,p);
  // Original private loader with NO password/opt-in is refused before supervisor/PG.
  const refused=docker(['exec','--user','1000:1000',gateway,'node','-e',p.loaderPrivate],[1]);if(refused.stdout!==''||refused.stderr!=='MANUAL_READ_DISABLE_LOADER_REFUSED\n')fail();
  M.acceptPublic(docker(['exec','--user','1000:1000',gateway,'node','-e',getCode]).stdout,p);
  passed=true;
 }catch{process.exitCode=1;}
 finally{
  let cleaned=true;
  for(const cid of [...containers].reverse()){try{inspect(cid);docker(['rm','--force',cid]);}catch{cleaned=false;}}
  for(const name of [...volumes].reverse()){try{volume(name);docker(['volume','rm',name]);}catch{cleaned=false;}}
  if(dockerConfig){try{const s=fs.lstatSync(dockerConfig);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o7777)!==0o700)fail();fs.rmSync(dockerConfig,{recursive:true});}catch{cleaned=false;}}
  if(!cleaned)process.exitCode=1;
  process.stdout.write(JSON.stringify({schema:'crm-manager-read-manual-disable-oci-proof-v1',state:passed&&cleaned?'verified':'refused',syntheticOnly:true,runtimeSourceUnchanged:true,initializerLedgerOnly:true,originalSourceReadOnly:true,publicObserverAdmitted:passed,privateLoaderWithoutOptInRefused:passed,postgresCalls:0,privateCredentialsOpened:false,cleanupOwnLabelsOnly:cleaned,dockerCalls:calls})+'\n');
 }
}
