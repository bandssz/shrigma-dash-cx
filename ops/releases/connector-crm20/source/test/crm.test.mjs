import test from 'node:test';
import assert from 'node:assert/strict';
import {Crm,loginCrm} from '../src/crm.mjs';

const user={id:'actor-qa',login:'editor-qa-aristo@shrigma.com.br',brand:'aristo',active:true,crm:true};
const session={cookie:'__Host-shrigma_sid=synthetic-cookie',csrf:'synthetic-csrf',userId:'crm-qa',email:user.login};
function setup(result={campaign:{id:304}},status=200){
 const calls=[],store={user:()=>user,credentials:()=>({crm:session}),claim(){throw Error('NO_CLAIM');},operation(){throw Error('NO_JOURNAL');}};
 const crm=new Crm({store,fetchImpl:async(url,options)=>{calls.push({url:new URL(url),options});return Response.json(result,{status});}});
 return{crm,calls};
}
test('ordinary OAuth actor calls only its CRM with Cookie Origin CSRF and brand',async()=>{
 const{crm,calls}=setup();await crm.call('crm_campaign_create',{brand:'aristo',definition:{brand:'aristo',name:'[QA] chat'}},user.id);
 assert.equal(calls.length,1);const c=calls[0];assert.equal(c.url.origin,'https://crm.shrigma.com.br');assert.equal(c.url.pathname,'/api/campaigns');assert.equal(c.options.headers.Cookie,session.cookie);assert.equal(c.options.headers.Origin,c.url.origin);assert.equal(c.options.headers['X-CSRF-Token'],session.csrf);assert.equal(c.options.headers['X-Shrigma-View-Brand'],'aristo');assert.equal(c.options.redirect,'error');assert.equal(JSON.parse(c.options.body).acao,'campanha_criar');assert.equal(Object.hasOwn(c.options.headers,'Authorization'),false);
});
test('foreign brand fails before any network or local operation',async()=>{
 const{crm,calls}=setup();await assert.rejects(crm.call('crm_campaign_get',{brand:'fish',id:304},user.id),{code:'BRAND_FORBIDDEN'});assert.equal(calls.length,0);
});
test('expired CRM session requests reconnect and never retries a write',async()=>{
 const{crm,calls}=setup({error:'AUTH_REQUIRED'},401);await assert.rejects(crm.call('crm_campaign_create',{brand:'aristo',definition:{}},user.id),{code:'CRM_RECONNECT_REQUIRED'});assert.equal(calls.length,1);
});
test('ambiguous POST result never starts a second HTTP call',async()=>{
 let n=0;const crm=new Crm({store:{user:()=>user,credentials:()=>({crm:session})},fetchImpl:async()=>{n++;throw Error('synthetic timeout');}});
 await assert.rejects(crm.call('crm_campaign_create',{brand:'aristo',definition:{}},user.id),{code:'CRM_RESULT_UNCONFIRMED'});assert.equal(n,1);
});
test('status confirms the same CRM person and strips session secrets',async()=>{
 const{crm}=setup({authenticated:true,user:{id:session.userId,email:user.login,brands:['aristo'],permissions:{growth:{read:true,edit:true}}},csrf:session.csrf});
 const r=await crm.call('crm_status',{},user.id);assert.equal(r.user.id,session.userId);assert.equal(r.operator,'crm');assert.equal(JSON.stringify(r).includes(session.csrf),false);assert.equal(JSON.stringify(r).includes(session.cookie),false);
});
test('wrong CRM person is refused even if the session is authenticated',async()=>{
 const{crm}=setup({authenticated:true,user:{id:'another-person',email:user.login,brands:['aristo']}});await assert.rejects(crm.call('crm_status',{},user.id),{code:'CRM_IDENTITY_REFUSED'});
});
test('model save preserves FirstName and the CRM attempt; recovery is GET',async()=>{
 const{crm,calls}=setup({operation:{state:'completed'}}),key='36c77265-490f-473b-a841-06e78f2991d0',html='<p>Olá {{ .Subscriber.FirstName }}</p>';
 await crm.call('crm_model_save',{brand:'aristo',name:' [QA] chat ',subject:' Olá ',html,idempotency_key:key},user.id);
 const b=JSON.parse(calls[0].options.body);assert.deepEqual(Object.keys(b).sort(),['acao','idempotency_key','rascunho']);assert.equal(b.idempotency_key,key);assert.equal(b.rascunho.corpo,html);assert.equal(b.rascunho.nome,'[QA] chat');assert.equal(b.rascunho.canal,'email');assert.equal(b.rascunho.idioma,'pt_BR');assert.equal(b.rascunho.categoria,'MARKETING');assert.equal(b.rascunho.peca,'campanha');assert.equal(Object.hasOwn(b.rascunho,'formato'),false);
 await crm.call('crm_model_operation',{brand:'aristo',idempotency_key:key},user.id);assert.equal(calls.length,2);assert.equal(calls[1].options.method,'GET');assert.equal(calls[1].url.searchParams.get('idempotency_key'),key);assert.equal(calls[1].url.searchParams.get('operacao'),'rascunho');
});
test('281 and 282 cannot be mutated through the CRM connector',async()=>{
 const{crm,calls}=setup();for(const id of [281,282])await assert.rejects(crm.call('crm_campaign_schedule',{brand:'aristo',id,send_at:'2026-10-21T13:00:00Z',confirm:'agendar'},user.id),{code:'CAMPAIGN_PROTECTED'});assert.equal(calls.length,0);
});
test('CRM OAuth login binds returned session to its own identity and keeps no password',async()=>{
 const calls=[];const credentials=await loginCrm({login:user.login,password:'synthetic-password',brand:'aristo',fetchImpl:async(url,options)=>{calls.push({url,options});return url.endsWith('/auth/login')?Response.json({authenticated:true},{headers:{'set-cookie':session.cookie+'; Secure; HttpOnly; Path=/'}}):Response.json({authenticated:true,user:{id:session.userId,email:user.login,brands:['aristo'],permissions:{growth:{read:true}}},csrf:session.csrf});}});
 assert.equal(calls.length,2);assert.equal(credentials.userId,session.userId);assert.equal(credentials.cookie,session.cookie);assert.equal(Object.hasOwn(credentials,'password'),false);assert(calls.every(c=>new URL(c.url).origin==='https://crm.shrigma.com.br'));
});
