'use strict';
// Preview only. This adapter has no write admission, reservation or replay hook.
const crypto=require('node:crypto');
const {RESOURCE,PURPOSE,canonical}=require('./native-database-vault.cjs');
const {createOwnFoundation,capsuleHash}=require('./own-foundation/foundation.cjs');
const M=require('./own-foundation/manifest.json'),Q=require('./own-foundation/sql.cjs');
const PEER=require('./native-database-inventory.cjs').PEER;
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const fail=(code,status=503)=>Object.assign(Error(code),{code,status});
const bounded=(promise,ms,code)=>{let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(fail(code)),ms);})]).finally(()=>clearTimeout(timer));};
function createFoundationPreview({enabled=false,driver,vault}={}){
 const ready=enabled===true&&typeof driver?.Client==='function'&&/^\d+\.\d+\.\d+$/.test(driver.version||'')&&/^[a-f0-9]{64}$/.test(driver.packageSha256||'')&&['getPrivateCredential','inspectionBinding','admitInspection'].every(k=>typeof vault?.[k]==='function');
 let active=null,closing=false,blocked=false,closePromise;
 async function preview(args,context){
  if(!ready)throw fail('FOUNDATION_PREVIEW_OFF');
  if(closing||blocked)throw fail('FOUNDATION_PREVIEW_UNAVAILABLE');
  if(active)throw fail('FOUNDATION_PREVIEW_BUSY',409);
  if(!args||Object.getPrototypeOf(args)!==Object.prototype||Object.keys(args).sort().join(',')!=='expectedSha256,migrationId'||args.migrationId!==M.capsuleId||args.expectedSha256!==capsuleHash)throw fail('FOUNDATION_PREVIEW_CAPSULE_REFUSED',400);
  if(!context||typeof context.ownerId!=='string'||!context.ownerId||typeof context.connectionId!=='string'||!context.connectionId)throw fail('FOUNDATION_PREVIEW_OWNER_REQUIRED',403);
  const ownerId=context.ownerId,t={valid:true,fatal:false,session:null,kernel:null,done:null,finish:null};t.done=new Promise(r=>t.finish=r);active=t;
  const check=()=>{if(active!==t||!t.valid||t.fatal)throw fail('FOUNDATION_PREVIEW_SESSION_REFUSED');};
  const closePhysical=async()=>{
   const s=t.session;if(!s)return {retired:true,confirmedClosed:true};
   if(!s.endPromise){s.endRequested=true;s.endPromise=(async()=>{try{await bounded(Promise.resolve().then(()=>s.raw.end()),5000,'FOUNDATION_PREVIEW_CLOSE_TIMEOUT');if(!s.ended)throw fail('FOUNDATION_PREVIEW_CLOSE_UNCONFIRMED');}catch{blocked=true;throw fail('FOUNDATION_PREVIEW_CLOSE_UNCONFIRMED');}})();s.endPromise.catch(()=>{});}
   await s.endPromise;return {retired:true,confirmedClosed:true};
  };
  try{
   const binding=vault.inspectionBinding(ownerId),p=vault.getPrivateCredential({ownerId});
   if(p.ownerId!==ownerId||p.schema!=='shrigma-private-database-credential-v1'||p.revision!==binding.profileRevision||canonical(p.resource)!==canonical(RESOURCE)||p.transport?.mode!=='admitted-private-network'||typeof p.username!=='string'||!p.username||Buffer.byteLength(p.username)>63||/[\x00-\x1f\x7f]/.test(p.username)||typeof p.password!=='string'||!p.password||p.password.includes('\0')||Buffer.byteLength(p.password)>4096)throw fail('FOUNDATION_PREVIEW_CREDENTIAL_REFUSED');
   const recheck=()=>{check();if(canonical(vault.inspectionBinding(ownerId))!==canonical(binding))throw fail('FOUNDATION_PREVIEW_BINDING_CHANGED',409);};
   const admit=phase=>{
    recheck();const proof=vault.admitInspection({phase,ownerId,profileRevision:binding.profileRevision,credentialBindingHash:binding.credentialBindingHash,resourceHash:binding.resourceHash,purpose:PURPOSE,...(phase==='catalog'?{peer:t.session.peer}:{})});
    if(proof?.admitted!==true||proof.ownerId!==ownerId||proof.profileRevision!==binding.profileRevision||proof.credentialBindingHash!==binding.credentialBindingHash||proof.resourceHash!==binding.resourceHash||proof.purpose!==PURPOSE)throw fail('FOUNDATION_PREVIEW_READ_ADMISSION_REFUSED');recheck();
   };
   admit('connect');
   const raw=new driver.Client({host:RESOURCE.host,port:RESOURCE.port,database:RESOURCE.database,user:p.username,password:p.password,ssl:false,connectionTimeoutMillis:3000,query_timeout:12000,statement_timeout:8000,lock_timeout:2000,idle_in_transaction_session_timeout:10000,application_name:'shrigma-own-foundation-preview',client_encoding:'UTF8',options:'-c search_path=pg_catalog -c default_transaction_read_only=on -c statement_timeout=8000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=10000',keepAlive:true});
   const s={raw,tx:null,seq:0,pending:false,ended:false,endRequested:false,endPromise:null,peer:null,waiters:new Set(),lease:false};t.session=s;
   if(typeof raw.on!=='function'||typeof raw.connection?.on!=='function'||!['connect','query','end'].every(k=>typeof raw[k]==='function'))throw fail('FOUNDATION_PREVIEW_DRIVER_REFUSED');
   const wake=()=>{for(const w of s.waiters)w();s.waiters.clear();};
   raw.on('error',()=>{t.fatal=true;wake();closePhysical().catch(()=>{});});raw.on('end',()=>{s.ended=true;if(!s.endRequested)t.fatal=true;wake();});
   raw.connection.on('readyForQuery',m=>{if(!['I','T','E'].includes(m?.status)){t.fatal=true;closePhysical().catch(()=>{});}else{s.tx=m.status;s.seq++;}wake();});
   const allowed=new Set([PEER,Q.BEGIN_READ,Q.INVENTORY,Q.ROLLBACK]);
   const query=async(text,params)=>{
    recheck();if(!s.lease||s.pending||s.ended||!allowed.has(text)||params!==undefined)throw fail('FOUNDATION_PREVIEW_QUERY_REFUSED');
    s.pending=true;const seq=s.seq;
    try{const result=await bounded(Promise.resolve().then(()=>raw.query(text)),12000,'FOUNDATION_PREVIEW_QUERY_TIMEOUT');
     if(s.seq<=seq)await bounded(new Promise(resolve=>s.waiters.add(resolve)),2000,'FOUNDATION_PREVIEW_READY_TIMEOUT');
     recheck();if(s.seq<=seq)throw fail('FOUNDATION_PREVIEW_ACK_UNKNOWN');return result;
    }catch(e){t.fatal=true;throw e;}finally{s.pending=false;}
   };
   await bounded(Promise.resolve().then(()=>raw.connect()),5000,'FOUNDATION_PREVIEW_CONNECT_TIMEOUT');recheck();
   if(s.tx!=='I'||raw.connection.stream?.encrypted===true)throw fail('FOUNDATION_PREVIEW_PEER_REFUSED');
   s.lease=true;let peerResult;try{peerResult=await query(PEER);}finally{s.lease=false;}
   if(peerResult?.command!=='SELECT'||peerResult.rowCount!==1||peerResult.rows?.length!==1)throw fail('FOUNDATION_PREVIEW_PEER_REFUSED');
   const peer=peerResult.rows[0];
   if(peer.database!=='listmonk'||peer.sessionRole!==p.username||peer.currentRole!==p.username||peer.port!==5432||Math.floor(peer.engine/10000)!==17||!Number.isSafeInteger(peer.pid)||peer.pid<=0||peer.pid!==raw.processID||peer.ssl!==false||peer.read_only!=='on')throw fail('FOUNDATION_PREVIEW_PEER_REFUSED');s.peer=peer;admit('catalog');
   const physicalSessionHash=hash(canonical({resourceHash:binding.resourceHash,pid:peer.pid,nonce:crypto.randomBytes(32).toString('hex')}));
   t.kernel=createOwnFoundation({enabled:true,client:{query},getTransactionState:()=>s.tx,
    context:{ownerId,bindingRevision:p.revision,credentialBindingHash:binding.credentialBindingHash,installerRole:p.username,resource:RESOURCE,driver:{version:driver.version,packageSha256:driver.packageSha256}},
    withFoundationSession:async work=>{recheck();if(s.lease||s.tx!=='I')throw fail('FOUNDATION_PREVIEW_LEASE_REFUSED');s.lease=true;try{return await work({exclusive:true,connected:true,resourceHash:binding.resourceHash,driverPackageSha256:driver.packageSha256,physicalSessionHash,pid:peer.pid,installerRole:p.username});}finally{s.lease=false;}},
    poisonSession:closePhysical,admitInspection:async input=>{admit('catalog');if(input.purpose!=='own-foundation-read'||input.action!=='preview'||input.ownerId!==ownerId||input.resourceHash!==binding.resourceHash||input.capsuleHash!==capsuleHash)throw fail('FOUNDATION_PREVIEW_READ_ADMISSION_REFUSED');return {...input,admitted:true};}
   });
   const result=await bounded(t.kernel.preview({}),45000,'FOUNDATION_PREVIEW_TIMEOUT');recheck();
   if(s.tx!=='I'||result.applyAdmitted!==false||result.recoveryReady!==false)throw fail('FOUNDATION_PREVIEW_ACK_UNKNOWN');
   await t.kernel.close();t.kernel=null;await closePhysical();recheck();
   return Object.freeze({...result,previewInstalled:true,sqlInstallerEnabled:false,physicalSessionClosed:true});
  }catch(e){throw /^[A-Z][A-Z0-9_]{1,100}$/.test(e.code||'')?e:fail('FOUNDATION_PREVIEW_REFUSED');}
  finally{t.valid=false;try{await t.kernel?.close();}finally{try{await closePhysical();}finally{active=null;t.finish();}}}
 }
 function close(){if(closePromise)return closePromise;closing=true;closePromise=(async()=>{if(active)await bounded(active.done,60000,'FOUNDATION_PREVIEW_DRAIN_TIMEOUT');if(blocked)throw fail('FOUNDATION_PREVIEW_CLOSE_UNCONFIRMED');return {closed:true,sqlInstallerEnabled:false,operational:false};})();closePromise.catch(()=>{});return closePromise;}
 return Object.freeze({preview,close});
}
module.exports=Object.freeze({createFoundationPreview,capsuleId:M.capsuleId,capsuleHash,ENABLED:false});
