'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const F=require('./graph-worker-access-fixture.cjs'),D=require('../tools/graph-worker-credential/deploy.cjs'),G=require('../tools/graph-install/deploy.cjs');
const ROOT=path.join(__dirname,'..'),copy=F.clone;
function fixture(t){
 const f=F.fixture(),keyBytes=Buffer.alloc(192,42),key={public_key_b64:keyBytes.toString('base64'),key_sha256:D.shaBytes(keyBytes),key_fingerprint:'a'.repeat(40),nonce:F.id(33)};
 key.validation_receipt_hash=D.sha({contract:D.KEY_CONTRACT,version:1,role:'crm_graph_worker',database:'listmonk',nonce:key.nonce,key_sha256:key.key_sha256,key_fingerprint:key.key_fingerprint});
 const common={owner_oid:'10',language:'c',binary:'$libdir/pgcrypto',definer:false,strict:true,volatility:'v',parallel:'s',kind:'f',returns:'bytea',settings:null,acl:null,definition_hash:F.h(6),extension_member:true};
 let metadata={database:'listmonk',role:'postgres',role_oid:'10',superuser:true,server_version_num:170010,standard_strings:'on',search_schemas:['pg_catalog','public'],event_triggers:[],transaction_isolation:'read committed',transaction_read_only:'off',statement_timeout_ms:20000,graph:copy(f.baseAnchor.metadata),off:{cart_off:true,epochs:'0',owners:'0',sources:'0',clones:'0'},worker_identity:copy(f.base.role_identity),auth:{password_null:true,scram:false,auth_proof_hash:F.h(1)},crypto:{oid:'16000',name:'pgcrypto',version:'1.3',schema:'public',owner_oid:'10',functions:[{...common,oid:'16001',name:'gen_random_bytes',arguments:'integer',symbol:'pg_random_bytes'},{...common,oid:'16002',name:'pgp_pub_encrypt',arguments:'text, bytea, text',symbol:'pgp_pub_encrypt_text'}]},hooks:{shared_preload_libraries:'',session_preload_libraries:'',local_preload_libraries:'',pgaudit_log:null,auto_explain_log_min_duration:null},default_acls:[],database_inventory:F.inventory(),receipt_schema:null};
 const scope=F.scope(),inputs={predecessor:{baseAnchor:f.baseAnchor,txReceipt:null},scopeReview:{connection_scope:scope,scope_hash:D.sha(scope),database_inventory:F.inventory(),diagnostic_read_exceptions:[]},publicKey:key};
 let identity={target:{database:'listmonk',role:'postgres',isolated:true,transport_source_hash:F.h(2)},workflows:G.WORKFLOWS.map(id=>({id,version:'synthetic-v1',hash:F.h(3),pg_ids:['fixture-pg']})),utility:{ids:['fixture-pg'],version:'synthetic-util-v1',node_hash:F.h(4)}};
 let receipt=null,writes=0,lose=false,effect=true,pid=9001,readPid=9002;
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'crm-credential-protocol-'));t?.after(()=>fs.rmSync(directory,{recursive:true,force:true}));const store=new D.FileStore(directory);
 const io={snapshot:async()=>copy({metadata,identity,session_pid:pid}),sql:async sql=>{
  writes++;const plan=store.read('plan');if(!store.has('provision-intent')||sql!==plan.migration.sql)throw Error('MISSING_INTENT');
  if(effect){const before=copy(metadata),cipher=Buffer.from('synthetic encrypted receipt only');metadata={...metadata,auth:{password_null:false,scram:true,auth_proof_hash:F.h(5)},receipt_schema:{oid:'17010',owner_oid:'10',acl:['postgres=UC/postgres'],functions:0,relations:[{name:'receipt',kind:'r',owner_oid:'10'},{name:'receipt_nonce_key',kind:'i',owner_oid:'10'},{name:'receipt_pkey',kind:'i',owner_oid:'10'}],unexpected_acl:0,shape:F.m(6)}};
   receipt={contract:D.CONTRACT,nonce:key.nonce,role_oid:metadata.worker_identity.oid,key_sha256:key.key_sha256,key_fingerprint:key.key_fingerprint,validation_receipt_hash:key.validation_receipt_hash,predecessor_hash:plan.migration.predecessor_hash,scope_hash:plan.migration.scope_hash,before_state:before,after_state:copy(metadata),ciphertext:cipher.toString('base64'),ciphertext_sha256:D.shaBytes(cipher),auth_proof_hash:metadata.auth.auth_proof_hash,completed_at:'2026-09-28T05:00:00.000Z'};
  }
  if(lose)throw Error('PRIVATE ERROR THAT MUST NEVER BE PERSISTED');return {untrusted:'RAW RESPONSE MUST NEVER BE PERSISTED'};
 },independentReadback:async()=>copy({metadata,identity,session_pid:readPid,receipt})};
 const preparer=new D.Preparer({root:ROOT,io,store});
 return {preparer,store,io,inputs,directory,metadata:()=>copy(metadata),identity:()=>copy(identity),receipt:()=>copy(receipt),writes:()=>writes,change:fn=>{metadata=fn(metadata);},changeIdentity:fn=>{identity=fn(identity);},changeReceipt:fn=>{receipt=fn(receipt);},lose:(hasEffect=true)=>{lose=true;effect=hasEffect;},sameReadSession:()=>{readPid=pid;},prepare:async()=>preparer.prepare({snapshot_sha256:D.sha(await io.snapshot()),...inputs})};
}
module.exports={fixture,ROOT,copy,D,F};
