'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createWriterPolicy,WriterPolicyError,POLICY,SCHEMAS}=require('./writer-policy.cjs');
const UUID=n=>n.toString(16).padStart(8,'0')+'-0000-4000-8000-000000000000';
const START=Date.UTC(2026,9,3),PRIVATE='NEVER_A_BEARER_PROTOCOL_FIELD';
const canon=v=>Array.isArray(v)?'['+v.map(canon).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canon(v[k])).join(',')+'}':JSON.stringify(v);
const hash=v=>crypto.createHash('sha256').update(canon(v)).digest('hex');
function fixture(){let clock=START;const config={issuerId:UUID(1),namespaceId:UUID(2),allowedEmailDomains:['synthetic.invalid'],now:()=>clock},p=createWriterPolicy(config);return{p,config,clock:v=>{clock=v;}};}
function args(operationId=UUID(3)){return{operationId,userId:UUID(4),lifecycleId:UUID(5),owner:'manager@synthetic.invalid',brand:'fish',principalId:'dcrmw-'+'a'.repeat(32),keySha256:'b'.repeat(64)};}
function prepared(c){return{schema:SCHEMAS.receipt,issuerId:c.issuerId,namespaceId:c.namespaceId,operationId:c.operationId,action:c.action,requestSha256:hash(c),userId:c.userId,lifecycleId:c.lifecycleId,owner:c.owner,state:'prepared',brand:c.brand,principalId:c.principalId,generation:c.generation,expectedGeneration:c.expectedGeneration,area:c.area,slot:c.slot,role:c.role,caps:[...c.caps],issuedAt:START,candidateExpiresAt:START+600000,expiresAt:START+1209600000};}
const refuses=fn=>assert.throws(fn,e=>e instanceof WriterPolicyError&&e.code==='CRM_WRITER_POLICY_REFUSED'&&!String(e).includes(PRIVATE));
test('writer prepares a distinct closed immutable protocol with digest only, and commits only a locally validated preparation',()=>{
 const {p}=fixture(),c=p.command('prepare_writer',args());assert.equal(c.schema,SCHEMAS.request);assert.equal(c.slot,'growth-campaign');assert.deepEqual(c.caps,['read_content','draft','validate','submit']);assert.ok(Object.isFrozen(c)&&Object.isFrozen(c.caps));assert.equal(Object.hasOwn(c,'bearer'),false);
 const v=p.receipt(prepared(c),c),commit=p.commit({operationId:UUID(6),proof:v});assert.equal(commit.action,'commit_writer');assert.equal(commit.prepareOperationId,c.operationId);assert.equal(commit.generation,1);assert.equal(commit.keySha256,c.keySha256);refuses(()=>p.commit({operationId:UUID(6),proof:JSON.parse(JSON.stringify(v))}));
});
test('read protocol, principal, slot and caps cannot become a writer proof',()=>{
 const {p}=fixture();refuses(()=>p.command('prepare_read',args()));refuses(()=>p.command('prepare_writer',{...args(),principalId:'dcrm-'+'a'.repeat(32)}));
 const c=p.command('prepare_writer',args());for(const changes of [{schema:'crm-manager-provision-receipt-v1'},{slot:'crm-panel-read'},{principalId:'dcrm-'+'a'.repeat(32)},{caps:['read_content','list_history','submission']},{caps:['read_content','draft','validate','submit','edit_content']},{caps:['submit','validate','draft','read_content']}])refuses(()=>p.receipt({...prepared(c),...changes},c));
});
test('receipt cannot cross user, lifecycle, namespace, owner, operation or request content',()=>{
 const {p}=fixture(),c=p.command('prepare_writer',args());for(const changes of [{userId:UUID(7)},{lifecycleId:UUID(7)},{namespaceId:UUID(7)},{issuerId:UUID(7)},{owner:'other@synthetic.invalid'},{operationId:UUID(7)},{requestSha256:'c'.repeat(64)}])refuses(()=>p.receipt({...prepared(c),...changes},c));
});
test('a changed receipt cannot replace an acknowledged proof and a status cannot erase it',()=>{
 const {p}=fixture(),c=p.command('prepare_writer',args()),r=prepared(c);p.receipt(r,c);refuses(()=>p.receipt({...r,issuedAt:START+1,candidateExpiresAt:r.candidateExpiresAt+1,expiresAt:r.expiresAt+1},c));
 refuses(()=>p.status({schema:SCHEMAS.status,issuerId:c.issuerId,namespaceId:c.namespaceId,operationId:c.operationId,found:false},c));
});
test('lost response is recovered only by status for the identical command; reconstructed validated proof can commit after restart',()=>{
 const first=fixture(),c=first.p.command('prepare_writer',args()),r=prepared(c);const fresh=createWriterPolicy(first.config);
 const request=fresh.statusRequest(c);assert.equal(request.action,'writer_status');assert.equal(request.expectedRequestSha256,hash(c));
 const recovered=fresh.status({schema:SCHEMAS.status,issuerId:c.issuerId,namespaceId:c.namespaceId,operationId:c.operationId,found:true,receipt:r},c);assert.equal(recovered.found,true);assert.equal(fresh.commit({operationId:UUID(6),proof:recovered.receipt}).principalId,c.principalId);
 refuses(()=>fresh.status({...request,schema:SCHEMAS.status,found:false},c));
});
test('exact lifetime and preparation expiry are enforced; a historic proof does not extend its validity',()=>{
 const f=fixture(),c=f.p.command('prepare_writer',args());for(const changes of [{candidateExpiresAt:START+600001},{expiresAt:START+1209600001},{issuedAt:START+30001}])refuses(()=>f.p.receipt({...prepared(c),...changes},c));
 const v=f.p.receipt(prepared(c),c);f.clock(START+600000);refuses(()=>f.p.commit({operationId:UUID(6),proof:v}));
});
test('renewal requires the exact next generation; commit receipt proves the old generation was revoked',()=>{
 const {p}=fixture(),a={...args(),generation:3,expectedGeneration:2},c=p.command('renew_writer',a),v=p.receipt(prepared(c),c),commit=p.commit({operationId:UUID(6),proof:v});
 for(const changes of [{generation:2},{expectedGeneration:0},{generation:1000000000,expectedGeneration:999999999}])refuses(()=>p.command('renew_writer',{...a,...changes}));
 const r={...prepared(commit),state:'committed',prepareOperationId:c.operationId,committedAt:START+1,revokedGeneration:2};assert.equal(p.receipt(r,commit).revokedGeneration,2);
 refuses(()=>p.receipt({...r,revokedGeneration:null},commit));
});
test('revocation binds the entire lifecycle and invalidates its known prepared proof',()=>{
 const {p}=fixture(),c=p.command('prepare_writer',args()),v=p.receipt(prepared(c),c),r=p.command('revoke_writer',{operationId:UUID(6),userId:c.userId,lifecycleId:c.lifecycleId,owner:c.owner});
 const receipt={schema:SCHEMAS.receipt,issuerId:r.issuerId,namespaceId:r.namespaceId,operationId:r.operationId,action:r.action,requestSha256:hash(r),userId:r.userId,lifecycleId:r.lifecycleId,owner:r.owner,state:'revoked',revocationMode:'lifecycle',allGenerationsRevoked:true,effectiveAt:START,revokedCount:1};
 refuses(()=>p.receipt({...receipt,allGenerationsRevoked:false},r));p.receipt(receipt,r);refuses(()=>p.commit({operationId:UUID(7),proof:v}));
});
test('foreign domains, raw credential fields, command getters and extra commit/status fields are refused',()=>{
 const {p}=fixture();refuses(()=>p.command('prepare_writer',{...args(),owner:'manager@foreign.invalid'}));refuses(()=>p.command('prepare_writer',{...args(),bearer:PRIVATE}));
 const c=p.command('prepare_writer',args()),v=p.receipt(prepared(c),c);refuses(()=>p.commit({operationId:UUID(6),proof:v,bearer:PRIVATE}));refuses(()=>p.statusRequest({...c,bearer:PRIVATE}));
 const accessor={...c};Object.defineProperty(accessor,'action',{enumerable:true,get(){throw Error(PRIVATE);}});refuses(()=>p.statusRequest(accessor));
 refuses(()=>p.status({schema:SCHEMAS.status,issuerId:c.issuerId,namespaceId:c.namespaceId,operationId:c.operationId,found:false},c,{requireFound:false,bearer:PRIVATE}));
});
test('rejected async clock is refused and observed without an unhandled rejection',async()=>{
 const f=fixture(),p=createWriterPolicy({...f.config,now:()=>Promise.reject(Error(PRIVATE))}),c=p.command('prepare_writer',args());refuses(()=>p.receipt(prepared(c),c));await new Promise(r=>setImmediate(r));
});
test('capability getters and exotic arrays are refused without evaluating them or leaking callback errors',()=>{
 const {p}=fixture(),c=p.command('prepare_writer',args()),r=prepared(c);let invoked=0;const caps=[...r.caps];Object.defineProperty(caps,'2',{enumerable:true,get(){invoked++;throw Error(PRIVATE);}});refuses(()=>p.receipt({...r,caps},c));assert.equal(invoked,0);
 class Other extends Array{}refuses(()=>p.receipt({...r,caps:Other.from(r.caps)},c));
});
