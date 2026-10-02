'use strict';
// CI only. Creates synthetic volumes/containers on a dedicated local daemon.
// Never accepts an existing volume name, a credential, or a production endpoint.
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {Readable}=require('node:stream');
const {DatabaseSync}=require('node:sqlite');
const {check}=require('./preflight-mounts.cjs');
const {download}=require('./mac-downloader.cjs');
const {decrypt}=require('./identity-envelope.cjs');
const {verifyBackup}=require('./backup-identity.cjs');
const LABEL='shrigma.synthetic-offsite-drill';
const id=crypto.randomUUID(),prefix='shrigma-drill-'+id+'-';
const ownedContainers=[],ownedVolumes=[];
let privateRoot,stage='bootstrap',activeContainer=null,lastDockerFailure=null;
const STAGES=new Set(['bootstrap','ci_gate','docker_context','image_attestation','fixture_private','volume_create','fixture_create','fixture_start','fixture_ready','fixture_baseline','preflight_create','preflight_start','preflight_health','preflight_mounts','snapshot_create','snapshot_start','snapshot_health','source_unchanged','snapshot_receipt','encrypt_create','encrypt_start','encrypt_wait','encrypt_mounts','reader_transfer','nonce_replay','restore_verify','restored_rows']);
function at(name){if(!STAGES.has(name))fail();stage=name;lastDockerFailure=null;}
function fail(){throw Error('SYNTHETIC_DRILL_REFUSED');}
function docker(args,{input,allowFailure=false}={}){
 const r=spawnSync('docker',args,{input,encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024});
 if(r.error||r.signal||r.status!==0){if(allowFailure)return null;lastDockerFailure={command:['context','image','volume','container','create','start','exec','wait','rm'].includes(args[0])?args[0]:'other',exitCode:Number.isInteger(r.status)?r.status:null,signal:!!r.signal,timeout:r.error?.code==='ETIMEDOUT'};fail();}
 return r.stdout;
}
function inspect(kind,name){try{return JSON.parse(docker([kind,'inspect',name]))[0];}catch{fail();}}
function mount(volume,target,ro=false){return ['--mount','type=volume,src='+volume+',dst='+target+(ro?',readonly':'')];}
function volume(alias){
 const name=prefix+alias;
 if(docker(['volume','inspect',name],{allowFailure:true})!==null)fail();
 docker(['volume','create','--label',LABEL+'='+id,name]);
 const metadata=inspect('volume',name);if(metadata.Name!==name||metadata.Labels?.[LABEL]!==id||metadata.Driver!=='local')fail();
 ownedVolumes.push(name);return name;
}
function image(ref,title,entry){
 if(typeof ref!=='string'||!/^[a-z0-9][a-z0-9_./:@-]{0,255}$/.test(ref))fail();
 const data=inspect('image',ref);
 if(!/^sha256:[a-f0-9]{64}$/.test(data.Id)||data.Config?.User!=='1000:1000'||data.Config?.Labels?.['org.opencontainers.image.title']!==title||JSON.stringify(data.Config?.Entrypoint)!==JSON.stringify(['node',entry]))fail();
 return data.Id;
}
function create(alias,imageRef,{mounts=[],command=[],entrypoint=null,environment={},memory='512m',cpus='0.5',health=null,stdin=false}={}){
 const name=prefix+alias,args=['create','--name',name,'--label',LABEL+'='+id,'--user','1000:1000','--read-only','--network','none','--cap-drop','ALL','--security-opt','no-new-privileges:true','--pids-limit','64','--restart','no','--memory',memory,'--cpus',cpus];
 for(const m of mounts)args.push(...m);
 if(stdin)args.push('--interactive');
 for(const [key,value]of Object.entries(environment)){if(!/^[A-Z0-9_]+$/.test(key))fail();args.push('--env',key+'='+value);}
 if(entrypoint)args.push('--entrypoint',entrypoint);
 if(health)args.push('--health-cmd',health,'--health-interval','1s','--health-timeout','10s','--health-retries','2','--health-start-period','5s');
 args.push(imageRef,...command);
 const cid=docker(args).trim();if(!/^[a-f0-9]{64}$/.test(cid))fail();
 ownedContainers.push(cid);activeContainer=cid;const metadata=inspect('container',cid);
 if(metadata.Config?.Labels?.[LABEL]!==id||metadata.Name!=='/'+name)fail();
 return cid;
}
function remove(cid){
 const i=ownedContainers.indexOf(cid);if(i<0)fail();
 const metadata=inspect('container',cid);if(metadata.Config?.Labels?.[LABEL]!==id)fail();
 docker(['rm','--force',cid]);ownedContainers.splice(i,1);if(activeContainer===cid)activeContainer=null;
}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function ready(cid,{health=false,probe=null}={}){
 activeContainer=cid;
 const deadline=Date.now()+60000;
 while(Date.now()<deadline){
  const state=inspect('container',cid).State;
  if(!state?.Running)fail();
  if(health?state.Health?.Status==='healthy':probe?docker(['exec',cid,'node','-e',probe],{allowFailure:true})!==null:true)return;
  if(health&&state.Health?.Status==='unhealthy')fail();await delay(200);
 }
 fail();
}
function cleanup(){
 let complete=true;
 for(const cid of ownedContainers.slice().reverse()){
  const raw=docker(['container','inspect',cid],{allowFailure:true});
  if(raw){try{if(JSON.parse(raw)[0]?.Config?.Labels?.[LABEL]===id)docker(['rm','--force',cid],{allowFailure:true});else complete=false;}catch{complete=false;}}
  if(docker(['container','inspect',cid],{allowFailure:true})!==null)complete=false;
 }
 for(const name of ownedVolumes.slice().reverse()){
  const raw=docker(['volume','inspect',name],{allowFailure:true});
  if(raw){try{if(JSON.parse(raw)[0]?.Labels?.[LABEL]===id)docker(['volume','rm',name],{allowFailure:true});else complete=false;}catch{complete=false;}}
  if(docker(['volume','inspect',name],{allowFailure:true})!==null)complete=false;
 }
 if(privateRoot)fs.rmSync(privateRoot,{recursive:true,force:true});
 return complete;
}
const SAFE_METADATA_PROBE=String.raw`
const fs=require('node:fs');
try{
 const st=p=>{try{return fs.lstatSync(p);}catch{return null;}};
 const privateDir=s=>!!s&&s.isDirectory()&&s.uid===1000&&(s.mode&511)===448;
 const privateFile=s=>!!s&&s.isFile()&&s.uid===1000&&(s.mode&511)===384&&s.nlink===1;
 const src=st('/source-data'),db=st('/source-data/dashboard.sqlite'),wal=st('/source-data/dashboard.sqlite-wal'),shm=st('/source-data/dashboard.sqlite-shm'),out=st('/snapshot-data');
 const lines=fs.readFileSync('/proc/self/mountinfo','utf8').split('\n');
 const option=(where,want)=>lines.some(line=>{const f=line.split(' - ')[0].split(' ');return f[4]===where&&f[5]?.split(',').includes(want);});
 const status=fs.readFileSync('/proc/self/status','utf8');
 const field=k=>new RegExp('^'+k+':\\s*([^\\n]+)','m').exec(status)?.[1]?.trim();
 const cpu=/^(\d+) (\d+)/.exec(fs.readFileSync('/sys/fs/cgroup/cpu.max','utf8'));
 const memory=Number(fs.readFileSync('/sys/fs/cgroup/memory.max','utf8').trim());
 const cpuRatio=cpu&&Number(cpu[2])>0?Number(cpu[1])/Number(cpu[2]):null;
 process.stdout.write(JSON.stringify({uid1000:process.getuid()===1000,gid1000:process.getgid()===1000,rootRO:option('/','ro'),sourceRO:option('/source-data','ro'),outputRW:option('/snapshot-data','rw'),sourceDirPrivate:privateDir(src),dbPrivate:privateFile(db),dbWithinBound:!!db&&db.size>0&&db.size<=536870912,walPrivate:wal===null||privateFile(wal),shmPrivate:shm===null||privateFile(shm),walPresent:!!wal,shmPresent:!!shm,outputDirPrivate:privateDir(out),outputEmpty:!!out&&fs.readdirSync('/snapshot-data').length===0,distinctVolumeRoots:!!src&&!!out&&(src.dev!==out.dev||src.ino!==out.ino),networkOnlyLo:fs.readdirSync('/sys/class/net').join(',')==='lo',capabilitiesZero:['CapEff','CapPrm','CapBnd','CapAmb'].every(k=>/^0+$/.test(field(k)||'')),noNewPrivileges:field('NoNewPrivs')==='1',memoryLimitMiB:Number.isSafeInteger(memory)?Math.round(memory/1048576):null,cpuQuotaRatio:Number.isFinite(cpuRatio)?cpuRatio:null}));
}catch{process.stdout.write('{"probeAvailable":false}');process.exitCode=1;}
`;
function diagnostic(){
 const result={schema:'identity_offsite_synthetic_drill_v1',pass:false,stage:STAGES.has(stage)?stage:'bootstrap'};
 if(lastDockerFailure)result.docker=lastDockerFailure;
 if(!activeContainer||!ownedContainers.includes(activeContainer))return result;
 const r=spawnSync('docker',['container','inspect',activeContainer],{encoding:'utf8',timeout:5000,maxBuffer:1024*1024});
 if(r.error||r.signal||r.status!==0)return result;
 try{
  const c=JSON.parse(r.stdout)[0];if(c?.Config?.Labels?.[LABEL]!==id)return result;
  const s=c.State||{},h=c.HostConfig||{};
  const allowed=new Set(['created','running','paused','restarting','removing','exited','dead']);
  result.container={owned:true,state:allowed.has(s.Status)?s.Status:'unknown',running:s.Running===true,oomKilled:s.OOMKilled===true,exitCode:Number.isInteger(s.ExitCode)?s.ExitCode:null,health:['starting','healthy','unhealthy'].includes(s.Health?.Status)?s.Health.Status:null,healthFailures:Number.isInteger(s.Health?.FailingStreak)?s.Health.FailingStreak:null,healthLastExitCode:Number.isInteger(s.Health?.Log?.at(-1)?.ExitCode)?s.Health.Log.at(-1).ExitCode:null,memoryLimitMiB:Number.isSafeInteger(h.Memory)?Math.round(h.Memory/1048576):null,cpuQuotaRatio:Number.isInteger(h.NanoCpus)?h.NanoCpus/1e9:null,readOnlyRoot:h.ReadonlyRootfs===true,networkNone:h.NetworkMode==='none',mounts:Array.isArray(c.Mounts)?c.Mounts.map(m=>({sourceRO:m.Destination==='/source-data'?m.RW===false:null,snapshotRW:m.Destination==='/snapshot-data'?m.RW===true:null,cipherRO:m.Destination==='/cipher-data'?m.RW===false:null})):[]};
  if(s.Running===true){
   const probe=spawnSync('docker',['exec',activeContainer,'node','-e',SAFE_METADATA_PROBE],{encoding:'utf8',timeout:5000,maxBuffer:4096});
   if(!probe.error&&!probe.signal&&probe.status===0){
    const value=JSON.parse(probe.stdout);
    const safeKeys=['uid1000','gid1000','rootRO','sourceRO','outputRW','sourceDirPrivate','dbPrivate','dbWithinBound','walPrivate','shmPrivate','walPresent','shmPresent','outputDirPrivate','outputEmpty','distinctVolumeRoots','networkOnlyLo','capabilitiesZero','noNewPrivileges','memoryLimitMiB','cpuQuotaRatio'];
    result.self={};for(const k of safeKeys)if(typeof value[k]==='boolean'||typeof value[k]==='number')result.self[k]=value[k];
   }else result.self={probeAvailable:false};
  }
 }catch{result.container={owned:true,diagnosticAvailable:false};}
 return result;
}
const FIXTURE=String.raw`
const fs=require('node:fs'),crypto=require('node:crypto'),{DatabaseSync}=require('node:sqlite');
try{
 const p='/source-data/dashboard.sqlite';fs.closeSync(fs.openSync(p,'wx',0o600));const db=new DatabaseSync(p);
 db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; CREATE TABLE identity_canary(id TEXT PRIMARY KEY,email TEXT NOT NULL,role TEXT NOT NULL); CREATE TABLE grant_canary(user_id TEXT REFERENCES identity_canary(id),panel TEXT,access TEXT); CREATE TABLE payload_canary(v BLOB);");
 db.prepare('INSERT INTO identity_canary VALUES(?,?,?)').run('synthetic-admin','admin@example.invalid','admin');
 db.prepare('INSERT INTO identity_canary VALUES(?,?,?)').run('synthetic-reader','reader@example.invalid','reader');
 db.prepare('INSERT INTO grant_canary VALUES(?,?,?)').run('synthetic-reader','crm','read');
 db.prepare('INSERT INTO payload_canary VALUES(?)').run(crypto.randomBytes(300000));
 for(const f of [p,p+'-wal',p+'-shm'])fs.chmodSync(f,0o600);
 setInterval(()=>{},3600000);
}catch{process.exitCode=1;}
`;
const PROBE=String.raw`
const fs=require('node:fs'),crypto=require('node:crypto');try{
const p='/source-data/dashboard.sqlite',paths=['/source-data',p,p+'-wal',p+'-shm'];
const out=paths.map(f=>{const s=fs.lstatSync(f);return {dev:s.dev,ino:s.ino,uid:s.uid,mode:s.mode&511,nlink:s.nlink,size:s.size,sha256:s.isFile()?crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'):null};});
if(out.some(s=>s.uid!==1000)||out[0].mode!==448||out.slice(1).some(s=>s.mode!==384||s.nlink!==1)||out[2].size<1)process.exitCode=1;else process.stdout.write(JSON.stringify(out));
}catch{process.exitCode=1;}
`;
const READER_FIXTURE=String.raw`
const fs=require('node:fs'),{Writable}=require('node:stream'),{createReader}=require('/app/cipher-reader.cjs');
class R extends Writable{constructor(){super();this.headers={};this.parts=[];this.statusCode=200;this.headersSent=false;}setHeader(k,v){this.headers[k.toLowerCase()]=v;}_write(b,e,cb){this.headersSent=true;this.parts.push(Buffer.from(b));cb();}end(...a){this.headersSent=true;return super.end(...a);}}
(async()=>{try{const b=Buffer.alloc(4096);let raw='';for(;;){const n=fs.readSync(0,b,0,b.length,null);if(!n)break;raw+=b.subarray(0,n).toString('utf8');if(raw.length>32768)throw Error('INPUT_REFUSED');if(raw.includes('\n'))break;}const req=JSON.parse(raw);const handler=createReader({dir:'/cipher-data/envelope',host:'cipher.synthetic.invalid',tokenSha256:process.env.BACKUP_READER_TOKEN_SHA256,expiresAt:Date.now()+120000});const res=new R();await handler(req,res);process.stdout.write(JSON.stringify({statusCode:res.statusCode,headers:res.headers,body:Buffer.concat(res.parts).toString('base64')}));}catch{process.exitCode=1;}})();
`;
async function main(){
 at('ci_gate');
 if(process.platform!=='linux'||process.env.CI!=='true'||process.env.GITHUB_ACTIONS!=='true'||process.argv.slice(2).join(' ')!=='--synthetic-ci'||process.env.DOCKER_TLS_VERIFY||process.env.DOCKER_CERT_PATH||process.env.DOCKER_HOST&&!process.env.DOCKER_HOST.startsWith('unix://'))fail();
 at('docker_context');
 const context=JSON.parse(docker(['context','inspect']))[0];if(!context?.Endpoints?.docker?.Host?.startsWith('unix://'))fail();
 at('image_attestation');
 const snapshot=image(process.env.OFFSITE_SNAPSHOT_IMAGE,'Shrigma isolated identity snapshot','/app/jobguard.cjs');
 const encrypt=image(process.env.OFFSITE_ENCRYPT_IMAGE,'Shrigma isolated identity envelope','/app/identity-envelope.cjs');
 const reader=image(process.env.OFFSITE_READER_IMAGE,'Shrigma fixed ciphertext reader','/app/cipher-reader.cjs');
 at('fixture_private');
 privateRoot=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'offsite-drill-private-')));fs.chmodSync(privateRoot,0o700);
 const pair=crypto.generateKeyPairSync('rsa',{modulusLength:3072,publicExponent:65537,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
 const priv=path.join(privateRoot,'private.pem');fs.writeFileSync(priv,pair.privateKey,{mode:0o600});
 const expectedNonce=crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex');
 const wrongNonce=crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex');
 at('volume_create');
 const source=volume('source'),snapshotVolume=volume('snapshot'),cipher=volume('cipher');
 at('fixture_create');
 const live=create('fixture',snapshot,{mounts:[mount(source,'/source-data')],entrypoint:'node',command:['-e',FIXTURE],memory:'128m',cpus:'0.1'});
 at('fixture_start');docker(['start',live]);
 at('fixture_ready');await ready(live,{probe:PROBE});
 at('fixture_baseline');
 const before=JSON.parse(docker(['exec',live,'node','-e',PROBE]));
 at('preflight_create');
 const hold=create('preflight',snapshot,{mounts:[mount(source,'/source-data',true),mount(snapshotVolume,'/snapshot-data')],command:['hold'],memory:'128m',cpus:'0.1',health:'node /app/jobguard.cjs check'});
 at('preflight_start');docker(['start',hold]);
 at('preflight_health');await ready(hold,{health:true});
 at('preflight_mounts');
 const attest=check(JSON.stringify([inspect('container',hold)]),{sourceName:source,outputName:snapshotVolume});if(!attest.pass)fail();remove(hold);
 at('snapshot_create');
 const snap=create('snapshot',snapshot,{mounts:[mount(source,'/source-data',true),mount(snapshotVolume,'/snapshot-data')],command:['backup'],health:'node /app/jobguard.cjs health'});
 at('snapshot_start');docker(['start',snap]);
 at('snapshot_health');await ready(snap,{health:true});
 at('source_unchanged');
 const after=JSON.parse(docker(['exec',live,'node','-e',PROBE]));if(JSON.stringify(before)!==JSON.stringify(after))fail();
 at('snapshot_receipt');
 const receipt=JSON.parse(docker(['exec',snap,'node','-e',"try{process.stdout.write(require('node:fs').readFileSync('/snapshot-data/.done','utf8'));}catch{process.exitCode=1;}"]));
 if(receipt.schema!=='identity_snapshot_done_v1'||!Number.isSafeInteger(receipt.bytes)||!/^[a-f0-9]{64}$/.test(receipt.sha256))fail();remove(snap);
 at('encrypt_create');
 const cipherJob=create('encrypt',encrypt,{mounts:[mount(snapshotVolume,'/snapshot-data',true),mount(cipher,'/cipher-output')],command:['encrypt','/snapshot-data/identity','-','/cipher-output/envelope'],environment:{DASHBOARD_BACKUP_PUBLIC_KEY_PEM_B64:Buffer.from(pair.publicKey).toString('base64'),DASHBOARD_BACKUP_SNAPSHOT_NONCE_SHA256:expectedNonce},memory:'768m'});
 at('encrypt_start');docker(['start',cipherJob]);
 at('encrypt_wait');const exitCode=Number(docker(['wait',cipherJob]).trim());if(exitCode!==0)fail();
 at('encrypt_mounts');
 const encryptedMounts=inspect('container',cipherJob).Mounts;if(encryptedMounts.length!==2||!encryptedMounts.some(m=>m.Name===snapshotVolume&&m.Destination==='/snapshot-data'&&m.RW===false)||!encryptedMounts.some(m=>m.Name===cipher&&m.Destination==='/cipher-output'&&m.RW===true))fail();remove(cipherJob);
 const token=crypto.randomBytes(32).toString('base64url'),tokenFile=path.join(privateRoot,'token');fs.writeFileSync(tokenFile,token,{mode:0o600});
 const serverHash=crypto.createHash('sha256').update(token).digest('hex');
 const transport=async(origin,name,supplied)=>{
  if(origin!=='https://cipher.synthetic.invalid'||supplied!==token||!['cipherblob.json','public-manifest.json'].includes(name))fail();
  const r=create('reader-'+name.split('.')[0],reader,{mounts:[mount(cipher,'/cipher-data',true)],entrypoint:'node',command:['-e',READER_FIXTURE],environment:{BACKUP_READER_TOKEN_SHA256:serverHash},memory:'128m',cpus:'0.25',stdin:true});
  const args=['start','--attach','--interactive',r];
  const request={method:'GET',url:'/'+name,headers:{host:'cipher.synthetic.invalid','x-forwarded-proto':'https',authorization:'Bearer '+token},rawHeaders:['Host','cipher.synthetic.invalid','X-Forwarded-Proto','https','Authorization','Bearer '+token]};
  const data=JSON.parse(docker(args,{input:JSON.stringify(request)+'\n'}));
  const metadata=inspect('container',r);if(metadata.State?.ExitCode!==0||metadata.Mounts.length!==1||metadata.Mounts[0].Name!==cipher||metadata.Mounts[0].RW!==false)fail();remove(r);
  if(data.statusCode!==200||typeof data.body!=='string')fail();const response=Readable.from([Buffer.from(data.body,'base64')]);response.statusCode=data.statusCode;response.headers=data.headers;return response;
 };
 at('reader_transfer');
 const encrypted=path.join(privateRoot,'encrypted');await download({origin:'https://cipher.synthetic.invalid',tokenFile,targetDir:encrypted,transport});
 at('nonce_replay');
 const replay=path.join(privateRoot,'replay');let rejected=false;try{await decrypt(encrypted,priv,replay,wrongNonce);}catch(e){rejected=e.message==='SNAPSHOT_NONCE_MISMATCH';}
 if(!rejected||fs.existsSync(replay)||fs.readdirSync(privateRoot).some(n=>n.startsWith('.decrypt-')))fail();
 at('restore_verify');
 const restored=path.join(privateRoot,'restored');await decrypt(encrypted,priv,restored,expectedNonce);const verified=await verifyBackup(restored);if(verified.bytes!==receipt.bytes||verified.sha256!==receipt.sha256)fail();
 at('restored_rows');
 const db=new DatabaseSync(path.join(restored,'identity.sqlite'),{readOnly:true});try{
  if(db.prepare('SELECT COUNT(*) AS n FROM identity_canary').get().n!==2||db.prepare("SELECT access FROM grant_canary WHERE user_id='synthetic-reader'").get().access!=='read'||db.prepare('SELECT length(v) AS n FROM payload_canary').get().n!==300000)fail();
 }finally{db.close();}
 return {schema:'identity_offsite_synthetic_drill_v1',pass:true,sourceReadOnly:true,sourceUnchanged:true,ownership1000:true,isolatedVolumes:true,replayNonceRejected:true,sqliteHashMatchesSnapshot:true,canaryRecordsRestored:true,httpFixtureOnly:true};
}
if(require.main===module){
 main().then(result=>{if(!cleanup())fail();console.log(JSON.stringify({...result,cleanupComplete:true}));}).catch(()=>{
  const details=diagnostic();
  try{cleanup();}catch{details.cleanupError=true;}
  console.error(JSON.stringify(details));process.exitCode=1;
 });
}
module.exports={main};
