'use strict';
const {test}=require('node:test'),a=require('node:assert/strict'),crypto=require('node:crypto'),path=require('node:path'),runtime=process.env.DASHBOARD_ACCESS_TEST_RUNTIME||path.resolve(__dirname,'../services/dashboard-operational'),A=require(runtime+'/crm-campaign-editorial-admission.cjs'),{fixture,campaignDefinition}=require('./consent19/gateway-fixture.cjs');
for(const brand of ['aristo','fish'])for(const qa of [true,false])test(brand+': callback binds original journal, author and command; '+(qa?'QA admitted':'ordinary editor stays legacy'),async t=>{
 const f=await fixture(t,{email:qa?'qa.crm+'+brand+'.edicao@shrigma.com.br':'analyst@oaristocrata.com',brands:[brand]}),checks=[];let failure;
 f.hooks.afterCampaignPost=async()=>{
  try{
  const {k,...command}=f.calls.at(-1).body,q={schema:'crm-editorial-admission-request-v1',brand,operationKey:command.idempotency_key,commandSha256:A.hash(command),sourceActor:'panel:synthetic-principal-2026'};
  const invoke=(input=q,bearer=f.key)=>f.auth.campaignEditorialAdmission({input,bearer});
  a.equal(invoke().mode,qa?'gateway':'legacy');
  const http=await f.request('/internal/crm-campaign-editorial-admission',{method:'POST',body:q,csrf:false,extraHeaders:{Cookie:undefined,Origin:undefined,Authorization:'Bearer '+f.key}});a.equal(http.status,200);a.equal(http.body.mode,qa?'gateway':'legacy');
  for(const [input,bearer]of [[{...q,commandSha256:'e'.repeat(64)},f.key],[{...q,brand:brand==='fish'?'aristo':'fish'},f.key],[{...q,sourceActor:'panel:other-principal-2026'},f.key],[q,'synthetic-wrong-private-key'],[{...q,current:{id:701,version:'a'.repeat(32),definition:campaignDefinition(brand)}},f.key]])a.throws(()=>invoke(input,bearer),{code:'EDITORIAL_AUTHORITY_REFUSED'});
  f.dbQuery(db=>{const row=db.prepare('SELECT * FROM crm_campaign_create_v1 WHERE remote_key=?').get(q.operationKey);a.equal(row.phase,'uncertain');
   for(const [field,value]of [['phase','queued'],['payload_sha256','e'.repeat(64)],['normalized_sha256','e'.repeat(64)],['catalog_sha256','e'.repeat(64)],['credential_mac','e'.repeat(64)],['input_ciphertext','invalid']]){db.prepare('UPDATE crm_campaign_create_v1 SET '+field+'=? WHERE remote_key=?').run(value,q.operationKey);try{a.throws(()=>invoke(),{code:'EDITORIAL_AUTHORITY_REFUSED'});}finally{db.prepare('UPDATE crm_campaign_create_v1 SET '+field+'=? WHERE remote_key=?').run(row[field],q.operationKey);}}
   for(const id of [row.user_id,db.prepare("SELECT id FROM users WHERE role='superadmin'").get().id]){const grant=db.prepare("SELECT can_edit FROM grants WHERE user_id=? AND area='growth'").get(id);db.prepare("UPDATE grants SET can_edit=0 WHERE user_id=? AND area='growth'").run(id);try{a.throws(()=>invoke(),{code:'EDITORIAL_AUTHORITY_REFUSED'});}finally{db.prepare("UPDATE grants SET can_edit=? WHERE user_id=? AND area='growth'").run(grant.can_edit,id);}}
  });checks.push(true);
  }catch(error){failure=error;}
 };
 const result=await f.request('/api/campaigns',{method:'POST',viewBrand:brand,body:{acao:'campanha_criar',brand,definition:campaignDefinition(brand),idempotency_key:crypto.randomUUID()}});if(failure)throw failure;a.equal(result.status,200,JSON.stringify({body:result.body,actions:f.calls.map(c=>c.action)}));a.equal(checks.length,1);
});
test('unknown callback operation only grants the complete legacy path; no browser fields can approve content',async t=>{
 const f=await fixture(t),q={schema:'crm-editorial-admission-request-v1',brand:'aristo',operationKey:'bff-'+ 'a'.repeat(64),commandSha256:'b'.repeat(64),sourceActor:'panel:synthetic-principal-2026'};
 a.equal(f.auth.campaignEditorialAdmission({bearer:f.key,input:q}).mode,'legacy');for(const extra of [{approved:true},{mode:'gateway'},{key:f.key}])a.throws(()=>f.auth.campaignEditorialAdmission({bearer:f.key,input:{...q,...extra}}),{code:'EDITORIAL_AUTHORITY_REFUSED'});
 const r=await f.request('/internal/crm-campaign-editorial-admission',{method:'POST',body:q,extraHeaders:{Authorization:'Bearer '+f.key}});a.equal(r.status,403);
});
