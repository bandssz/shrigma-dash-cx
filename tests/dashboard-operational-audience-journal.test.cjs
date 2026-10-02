'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {createAuth,AuthError}=require('../services/dashboard-operational/auth.cjs');

const hosts={manager:'dashboard.shrigma.test',growth:'crm.shrigma.test',organico:'organico.shrigma.test',influs:'influs.shrigma.test'};
const bootstrap='synthetic-audience-bootstrap-token';
const password='synthetic-audience-owner-password';
const managerPassword='synthetic-audience-manager-password';
const payloadHash='a'.repeat(64);
const actorHash='b'.repeat(64);
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const origin=host=>'https://'+host;
const cookieHeader=value=>value.split(';')[0];
const error=(code,status)=>e=>e instanceof AuthError&&e.code===code&&e.status===status;

function fixture(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dashboard-audience-journal-')),dbPath=path.join(dir,'identity.sqlite');
 const config={dbPath,managerHost:hosts.manager,areaHosts:{growth:hosts.growth,organico:hosts.organico,influs:hosts.influs},
  allowedEmailDomains:['shrigma.test'],bootstrapAdminEmail:'owner@shrigma.test',bootstrapTokenSha256:hash(bootstrap),encryptionKey:Buffer.alloc(32,19)};
 let auth=createAuth(config);
 return {config,dbPath,get auth(){return auth;},restart(){auth.close();auth=createAuth(config);return auth;},close(){auth.close();fs.rmSync(dir,{recursive:true,force:true});}};
}
async function admin(f){
 const activation={email:'owner@shrigma.test',token:bootstrap,host:hosts.manager,origin:origin(hosts.manager)};
 await f.auth.completeBootstrap({...activation,password});
 return login(f.auth,activation.email,password,hosts.manager);
}
async function login(auth,email,pass,host){
 const result=await auth.login({email,password:pass,host,origin:origin(host),ip:'192.0.2.90'});
 return {result,context:{cookieHeader:cookieHeader(result.cookie),host,origin:origin(host),method:'POST',csrf:result.csrf}};
}

test('audience journal survives lost ACK, restart and relogin; only a matching terminal receipt unlocks another write',async()=>{
 const f=fixture();try{
  const first=await admin(f);
  f.auth.setGrants({context:first.context,userId:first.result.user.id,permissions:{growth:{read:true,edit:true},organico:{read:true,edit:false},influs:{read:true,edit:false}}});
  const writer=await login(f.auth,'owner@shrigma.test',password,hosts.manager);
  const key=crypto.randomUUID(),nextKey=crypto.randomUUID(),segmentId=crypto.randomUUID(),ctx=writer.context,userId=writer.result.user.id;
  assert.equal(f.auth.audienceDraft({...ctx,method:'GET'},'fish'),null);
  assert.throws(()=>f.auth.audienceDraft({...ctx,method:'GET',csrf:undefined},'fish'),error('CSRF_DENIED',403));
  assert.throws(()=>f.auth.audienceDraft({...ctx,method:'GET',origin:'https://other.test'},'fish'),error('ORIGIN_DENIED',403));
  assert.throws(()=>f.auth.reserveAudienceDraft({...ctx,method:'GET'},'fish',key,'segmento_criar',payloadHash,actorHash),error('METHOD_DENIED',405));
  assert.throws(()=>f.auth.reserveAudienceDraft({...ctx,csrf:'invalid'},'fish',key,'segmento_criar',payloadHash,actorHash),error('CSRF_DENIED',403));
  assert.throws(()=>f.auth.reserveAudienceDraft({...ctx,origin:'https://other.test'},'fish',key,'segmento_criar',payloadHash,actorHash),error('ORIGIN_DENIED',403));
  assert.throws(()=>f.auth.reserveAudienceDraft(ctx,'fish','customer@example.test','segmento_criar',payloadHash,actorHash),error('OPERATION_KEY_INVALID',400));
  assert.throws(()=>f.auth.reserveAudienceDraft(ctx,'fish',key,'segmento_contar',payloadHash,actorHash),error('OPERATION_INVALID',400));
  assert.throws(()=>f.auth.reserveAudienceDraft(ctx,'fish',key,'segmento_criar','invalid',actorHash),error('OPERATION_HASH_INVALID',400));
  assert.equal(f.auth.reserveAudienceDraft(ctx,'fish',key,'segmento_criar',payloadHash,actorHash),userId);
  assert.equal(f.auth.audiencePayloadMatches(f.auth.audienceDraft({...ctx,method:'GET'},'fish').payloadMac,payloadHash),true);
  assert.equal(f.auth.audiencePayloadMatches(f.auth.audienceDraft({...ctx,method:'GET'},'fish').payloadMac,'b'.repeat(64)),false);
  assert.equal(f.auth.audienceActorMatches(f.auth.audienceDraft({...ctx,method:'GET'},'fish').actorMac,actorHash),true);
  assert.equal(f.auth.audienceDraft({...ctx,method:'GET'},'fish').phase,'pending');
  assert.throws(()=>f.auth.reserveAudienceDraft(ctx,'fish',nextKey,'segmento_salvar',payloadHash,actorHash),error('AUDIENCE_RECONCILIATION_REQUIRED',409));
  // The upstream may have committed even though its acknowledgement was lost.
  assert.equal(f.auth.audienceDraftOutcome(userId,'fish',key,'segmento_criar','uncertain'),true);
  f.restart();
  const again=await login(f.auth,'owner@shrigma.test',password,hosts.manager);
  assert.notEqual(again.result.uiKey,writer.result.uiKey);
  const saved=f.auth.audienceDraft({...again.context,method:'GET'},'fish');
  assert.equal(saved.operationKey,key);assert.equal(saved.phase,'uncertain');assert.equal(saved.receiptStatus,null);
  assert.throws(()=>f.auth.reserveAudienceDraft(again.context,'fish',nextKey,'segmento_salvar',payloadHash,actorHash),error('AUDIENCE_RECONCILIATION_REQUIRED',409));
  assert.throws(()=>f.auth.audienceDraftOutcome(userId,'fish',key,'segmento_criar','rejected',{receiptStatus:404,receiptCode:'SEGMENT_OPERATION_UNCONFIRMED'}),error('OPERATION_INVALID',500));
  assert.equal(f.auth.audienceDraft({...again.context,method:'GET'},'fish').phase,'uncertain');
  assert.throws(()=>f.auth.audienceDraftOutcome(userId,'fish',key,'segmento_salvar','succeeded',{receiptStatus:200,segmentId,segmentVersion:1}),error('OPERATION_CHANGED',409));
  assert.equal(f.auth.audienceDraftOutcome(userId,'fish',key,'segmento_criar','succeeded',{receiptStatus:201,segmentId,segmentVersion:1}),true);
  assert.equal(f.auth.audienceDraftOutcome(userId,'fish',key,'segmento_criar','uncertain'),false);
  assert.equal(f.auth.audienceDraftOutcome(userId,'fish',key,'segmento_criar','succeeded',{receiptStatus:201,segmentId,segmentVersion:1}),false);
  assert.throws(()=>f.auth.audienceDraftOutcome(userId,'fish',key,'segmento_criar','succeeded',{receiptStatus:201,segmentId:crypto.randomUUID(),segmentVersion:1}),error('OPERATION_CHANGED',409));
  assert.equal(f.auth.reserveAudienceDraft(again.context,'fish',nextKey,'segmento_salvar',payloadHash,actorHash),userId);
  assert.throws(()=>f.auth.audienceDraftOutcome(userId,'fish',key,'segmento_criar','succeeded',{receiptStatus:201,segmentId,segmentVersion:1}),error('OPERATION_CHANGED',409));
  assert.equal(f.auth.audienceDraft({...again.context,method:'GET'},'fish').operationKey,nextKey);
  assert.equal(f.auth.audienceDraft({...again.context,method:'GET'},'fish').phase,'pending');
 }finally{f.close();}
});

test('an uncertain audience write blocks write-key rotation and re-grant but permits immediate revocation',async()=>{
 const f=fixture();try{
  const owner=await admin(f),invite=f.auth.createInvite({context:owner.context,email:'editor@shrigma.test',areas:['growth'],permissions:{growth:{read:true,edit:true}}});
  await f.auth.acceptInvite({token:invite.token,password:managerPassword,host:hosts.growth,origin:origin(hosts.growth)});
  const editor=await login(f.auth,'editor@shrigma.test',managerPassword,hosts.growth),key=crypto.randomUUID();
  f.auth.setUpstreamCredential({context:owner.context,userId:invite.userId,slot:'growth-audience',bearer:'synthetic-individual-audience-key-1'});
  assert.equal(f.auth.reserveAudienceDraft(editor.context,'aristo',key,'segmento_arquivar',payloadHash,actorHash),invite.userId);
  f.auth.audienceDraftOutcome(invite.userId,'aristo',key,'segmento_arquivar','uncertain');
  assert.throws(()=>f.auth.setUpstreamCredential({context:owner.context,userId:invite.userId,slot:'growth-audience',bearer:'synthetic-individual-audience-key-2'}),error('AUDIENCE_RECONCILIATION_REQUIRED',409));
  assert.throws(()=>f.auth.setGrants({context:owner.context,userId:invite.userId,permissions:{growth:{read:true,edit:true}}}),error('AUDIENCE_RECONCILIATION_REQUIRED',409));
  assert.throws(()=>f.auth.setRequestedAccess({context:owner.context,userId:invite.userId,requestedAccess:'read'}),error('AUDIENCE_RECONCILIATION_REQUIRED',409));
  assert.deepEqual(f.auth.revokeUser({context:owner.context,userId:invite.userId}),{ok:true});
  assert.equal(f.auth.session({cookieHeader:editor.context.cookieHeader,host:hosts.growth}).authenticated,false);
  assert.throws(()=>f.auth.audienceDraft({...editor.context,method:'GET'},'aristo'),error('SESSION_REQUIRED',401));
  const db=new DatabaseSync(f.dbPath);try{
   const row=db.prepare('SELECT phase,operation_key,action,receipt_status FROM audience_draft_operations WHERE user_id=? AND brand=?').get(invite.userId,'aristo');
   assert.deepEqual({...row},{phase:'uncertain',operation_key:key,action:'segmento_arquivar',receipt_status:null});
   assert.equal(db.prepare('SELECT COUNT(*) AS n FROM upstream_credentials WHERE user_id=?').get(invite.userId).n,0);
  }finally{db.close();}
  assert.throws(()=>f.auth.createInvite({context:owner.context,email:'editor@shrigma.test',areas:['growth'],permissions:{growth:{read:true,edit:true}}}),error('AUDIENCE_RECONCILIATION_REQUIRED',409));
  assert.throws(()=>f.auth.createInvite({context:owner.context,email:'editor@shrigma.test',areas:['growth']}),error('AUDIENCE_RECONCILIATION_REQUIRED',409));
  // A late verified receipt is still recorded after revocation, without
  // restoring the disabled account or its credential.
  assert.equal(f.auth.audienceDraftOutcome(invite.userId,'aristo',key,'segmento_arquivar','succeeded',{receiptStatus:200,segmentId:crypto.randomUUID(),segmentVersion:2}),true);
  assert.equal(f.auth.users({context:owner.context}).find(u=>u.id===invite.userId).status,'disabled');
 }finally{f.close();}
});

test('journal stores only generated identifiers and receipt metadata; brands remain independent',async()=>{
 const f=fixture();try{
  const first=await admin(f);
  f.auth.setGrants({context:first.context,userId:first.result.user.id,permissions:{growth:{read:true,edit:true},organico:{read:true,edit:false},influs:{read:true,edit:false}}});
  const writer=await login(f.auth,'owner@shrigma.test',password,hosts.manager),keyFish=crypto.randomUUID(),keyAristo=crypto.randomUUID();
  f.auth.reserveAudienceDraft(writer.context,'fish',keyFish,'segmento_criar',payloadHash,actorHash);
  f.auth.reserveAudienceDraft(writer.context,'aristo',keyAristo,'segmento_salvar',payloadHash,actorHash);
  assert.throws(()=>f.auth.audienceDraftOutcome(writer.result.user.id,'fish',keyFish,'segmento_criar','succeeded',{receiptStatus:201,segmentId:'person@example.test',segmentVersion:1}),error('OPERATION_INVALID',500));
  assert.equal(f.auth.audienceDraftOutcome(writer.result.user.id,'fish',keyFish,'segmento_criar','rejected',{receiptStatus:422,receiptCode:'SEGMENT_SHAPE'}),true);
  assert.equal(f.auth.audienceDraft({...writer.context,method:'GET'},'aristo').phase,'pending');
  const db=new DatabaseSync(f.dbPath);try{
   const columns=db.prepare('PRAGMA table_info(audience_draft_operations)').all().map(x=>x.name);
   assert.deepEqual(columns,['user_id','brand','operation_key','payload_mac','actor_mac','action','phase','receipt_status','receipt_code','segment_id','segment_version','updated_at']);
   const rows=db.prepare('SELECT * FROM audience_draft_operations ORDER BY brand').all();
   assert.equal(rows.length,2);assert.equal(JSON.stringify(rows).includes('@'),false);
   assert.equal(JSON.stringify(rows).includes(payloadHash),false);
   assert.equal(JSON.stringify(rows).includes(actorHash),false);
   assert.equal(JSON.stringify(rows).includes('definition'),false);
   assert.equal(JSON.stringify(rows).includes('synthetic-individual-audience-key'),false);
  }finally{db.close();}
 }finally{f.close();}
});
