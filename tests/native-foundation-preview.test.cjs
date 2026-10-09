'use strict';
const test=require('node:test'),a=require('node:assert/strict'),{EventEmitter}=require('node:events'),crypto=require('node:crypto');
const {createFoundationPreview,capsuleId,capsuleHash}=require('../services/dashboard-operational/native-foundation-preview.cjs');
const {RESOURCE,PURPOSE,canonical}=require('../services/dashboard-operational/native-database-vault.cjs');
const Q=require('../services/dashboard-operational/own-foundation/sql.cjs'),PEER=require('../services/dashboard-operational/native-database-inventory.cjs').PEER;
const sha=x=>crypto.createHash('sha256').update(x).digest('hex'),args={migrationId:capsuleId,expectedSha256:capsuleHash},context={ownerId:'synthetic-original-master',connectionId:'synthetic-existing-native'};
function fixture(options={}){
 let revision=1,revoked=false;const created=[],seen=[];
 const profile=()=>({schema:'shrigma-private-database-credential-v1',revision,ownerId:context.ownerId,username:'synthetic_pg_owner',password:'Synthetic-Only-Private-PG!',resource:RESOURCE,transport:{mode:'admitted-private-network'}});
 const binding=()=>{if(revoked)throw Object.assign(Error('DB_PRIVATE_CREDENTIAL_REQUIRED'),{code:'DB_PRIVATE_CREDENTIAL_REQUIRED'});const {password,...pub}=profile();return {profileRevision:revision,credentialBindingHash:sha(canonical(pub)),resourceHash:sha(canonical(RESOURCE))};};
 const vault={getPrivateCredential:({ownerId})=>{a.equal(ownerId,context.ownerId);binding();return profile();},inspectionBinding:binding,admitInspection:p=>{const b=binding();a.equal(p.ownerId,context.ownerId);a.equal(p.purpose,PURPOSE);a.equal(p.profileRevision,b.profileRevision);if(p.phase==='catalog')a.equal(p.peer.database,'listmonk');return {admitted:true,ownerId:p.ownerId,...b,purpose:PURPOSE};}};
 class Client extends EventEmitter{
  constructor(config){super();this.connection=new EventEmitter();this.connection.stream={encrypted:false};this.processID=19017;this.config=config;this.closed=false;created.push(this);}
  ready(status){this.connection.emit('readyForQuery',{status});}
  async connect(){this.ready('I');}
  async query(text){seen.push(text);const status=text===Q.BEGIN_READ?'T':text===Q.ROLLBACK||text===PEER?'I':'T';let result;
   if(text===PEER)result={command:'SELECT',rowCount:1,rows:[{database:options.foreign?'other_database':'listmonk',sessionRole:'synthetic_pg_owner',currentRole:'synthetic_pg_owner',pid:this.processID,engine:170011,port:5432,ssl:false,read_only:'on'}]};
   else if(text===Q.INVENTORY){if(options.onInventory)await options.onInventory({rebind:()=>revision++,revoke:()=>{revoked=true;}});result={command:'SELECT',rowCount:1,rows:[{database:'listmonk',sessionRole:'synthetic_pg_owner',currentRole:'synthetic_pg_owner',pid:this.processID,engine:170011,port:5432,ssl:false,readOnly:'on',installerSuperuser:true,installerCreateRole:true,installerDatabaseCreate:true,schemaPresent:false,runtimePresent:false,eventTriggers:0,unsafeDefaultAcls:0,publicThirdPartyPrivileges:options.publicPrivileges||0}]};}
   else result={command:text===Q.BEGIN_READ?'BEGIN':'ROLLBACK',rowCount:null,rows:[]};
   if(options.badAck&&text===Q.INVENTORY)result.command='INSERT';
   this.ready(status);return result;
  }
  async end(){this.closed=true;if(!options.noEndEvent)this.emit('end');}
 }
 const driver={Client,version:'8.23.1',packageSha256:'a'.repeat(64)},p=createFoundationPreview({enabled:true,driver,vault});
 return {p,created,seen,driver,vault};
}
test('native preview is default OFF and refuses foreign capsules or model authority before connecting',async()=>{
 const off=createFoundationPreview();await a.rejects(off.preview(args,context),e=>e.code==='FOUNDATION_PREVIEW_OFF');
 const f=fixture();for(const q of [{...args,migrationId:'historical-read-provision'},{...args,expectedSha256:'b'.repeat(64)},{...args,sql:'CREATE ROLE forged'}])await a.rejects(f.p.preview(q,context),e=>e.code==='FOUNDATION_PREVIEW_CAPSULE_REFUSED');
 await a.rejects(f.p.preview(args,{ownerId:context.ownerId}),e=>e.code==='FOUNDATION_PREVIEW_OWNER_REQUIRED');a.equal(f.created.length,0);await f.p.close();
});
test('preview uses existing custody and only four fixed read queries, closes physical connection and exposes no secret or admission',async()=>{
 const f=fixture();try{const r=await f.p.preview(args,context);a.equal(r.catalogEligible,true);a.equal(r.applyAdmitted,false);a.equal(r.recoveryReady,false);a.equal(r.sqlInstallerEnabled,false);a.equal(r.physicalSessionClosed,true);a.equal(r.operational,false);a.equal(JSON.stringify(r).includes('Synthetic-Only-Private-PG!'),false);a.equal(f.created[0].config.database,'listmonk');a.equal(f.created[0].config.host,'comunicacao_postgres');a.match(f.created[0].config.options,/default_transaction_read_only=on/);a.deepEqual(f.seen,[PEER,Q.BEGIN_READ,Q.INVENTORY,Q.ROLLBACK]);a.equal(f.created[0].closed,true);}finally{await f.p.close();}
});
test('public third-party access is reported as a blocker without changing any legacy grant',async()=>{
 const f=fixture({publicPrivileges:4});try{const r=await f.p.preview(args,context);a.equal(r.catalogEligible,false);a(r.blockers.includes('PUBLIC_THIRD_PARTY_PRIVILEGES'));a(r.blockers.includes('ROOT_APPLY_ADMISSION_AND_RECOVERY_REQUIRED'));a.equal(f.seen.some(s=>/^(CREATE|GRANT|REVOKE|ALTER|INSERT)/.test(s)),false);}finally{await f.p.close();}
});
test('authenticated foreign peer is refused and the only attempted query is read-only',async()=>{
 const f=fixture({foreign:true});await a.rejects(f.p.preview(args,context),e=>e.code==='FOUNDATION_PREVIEW_PEER_REFUSED');a.deepEqual(f.seen,[PEER]);a.equal(f.created[0].closed,true);await f.p.close();
});
test('credential rotation during catalog lookup discards the result and closes the original physical session',async()=>{
 const f=fixture({onInventory:async x=>x.rebind()});await a.rejects(f.p.preview(args,context));a.equal(f.created[0].closed,true);a.equal(f.seen.includes(Q.COMMIT),false);await f.p.close();
});
test('credential revocation during catalog lookup never returns an accepted preview',async()=>{
 const f=fixture({onInventory:async x=>x.revoke()});await a.rejects(f.p.preview(args,context));a.equal(f.created[0].closed,true);await f.p.close();
});
test('unknown catalog ACK is refused with physical closure and no automatic re-execution',async()=>{
 const f=fixture({badAck:true});await a.rejects(f.p.preview(args,context),e=>e.code==='FOUNDATION_ACK_UNKNOWN');a.equal(f.created.length,1);a.equal(f.created[0].closed,true);a.equal(f.seen.filter(s=>s===Q.INVENTORY).length,1);await f.p.close();
});
test('concurrent preview cannot borrow the active physical session',async()=>{
 let release,entered;const enteredPromise=new Promise(r=>entered=r),hold=new Promise(r=>release=r),f=fixture({onInventory:async()=>{entered();await hold;}});
 const first=f.p.preview(args,context);await enteredPromise;await a.rejects(f.p.preview(args,context),e=>e.code==='FOUNDATION_PREVIEW_BUSY');release();await first;a.equal(f.created.length,1);await f.p.close();
});
test('missing end acknowledgment blocks subsequent physical sessions',async()=>{
 const f=fixture({noEndEvent:true});await a.rejects(f.p.preview(args,context),e=>e.code==='FOUNDATION_PREVIEW_CLOSE_UNCONFIRMED');await a.rejects(f.p.preview(args,context),e=>e.code==='FOUNDATION_PREVIEW_UNAVAILABLE');a.equal(f.created.length,1);await a.rejects(f.p.close(),e=>e.code==='FOUNDATION_PREVIEW_CLOSE_UNCONFIRMED');
});
