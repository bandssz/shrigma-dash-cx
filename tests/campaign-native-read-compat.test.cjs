'use strict';
const test=require('node:test'),a=require('node:assert/strict');
const {createNativeRead,version}=require('../services/crm-campaign/native-read.cjs');
const {createNativeReadTransport}=require('../services/crm-campaign/native-read-transport.cjs');
const {createExecutor}=require('../services/crm-campaign/transport.cjs');
function campaign(id=1,brand='fish'){
 return {id,created_at:'2026-10-20T13:00:00Z',updated_at:'2026-10-21T13:00:00Z',name:'Synthetic campaign',subject:'Synthetic subject',body:'<p>Synthetic body</p>',altbody:'Synthetic text',from_email:'avisos@'+(brand==='fish'?'fishermans.com.br':'oaristocrata.com'),template_id:1,status:'draft',sent:0,started_at:null,send_at:null,lists:[{id:brand==='fish'?17:16}],tags:[],headers:[{'Reply-To':'internal@synthetic.invalid'}],media:[{id:42}],attribs:{crm:{policy:'crm-campaign-v1',brand,initiative_key:'synthetic',initiative_name:'Synthetic',utm_campaign:'synthetic'},external:{retained:true}}};
}
function fixture({brand='fish',caps=['read_content','list_history','submission'],after,row=campaign(1,brand),pages}={}){
 const auth={actor:'panel:synthetic-read-original',caps},calls=[];
 const adapter=createNativeRead({authenticate:async key=>{calls.push({auth:key});return after===undefined?structuredClone(auth):after;},request:async path=>{
  calls.push({path});if(path==='/api/lists?minimal=true&per_page=all')return [{id:16,tags:['aristo']},{id:17,tags:['fish']},{id:99,tags:['fish','aristo']}];
  if(path==='/api/campaigns/1')return structuredClone(row);
  if(pages)return pages(Number(new URL('https://synthetic.invalid'+path).searchParams.get('page')));
  throw Error('UNEXPECTED_READ');
 }});
 return {calls,auth,adapter,execute:command=>adapter.execute({key:'synthetic-original-key',auth,command:{brand,acao:'campanha_obter',id:1,...command}})};
}
for(const brand of ['aristo','fish'])test(brand+': original READ identity and full DTO preserved with no writer capability',async()=>{
 const f=fixture({brand}),r=await f.execute();a.equal(r.status,200);a.equal(r.body.campaign.definition.html,'<p>Synthetic body</p>');a.equal(r.body.campaign.definition.template_id,1);a.equal(r.body.campaign.definition.brand,brand);a.match(r.body.campaign.version,/^[a-f0-9]{32}$/);a.deepEqual(f.auth.caps,['read_content','list_history','submission']);a(!f.auth.caps.includes('submit'));a.equal(f.calls.filter(c=>c.path).length,2);a.equal(f.calls.filter(c=>c.auth).length,1);
});
test('submission never authorizes READ and missing READ makes no API request',async()=>{
 const f=fixture({caps:['submission']});await a.rejects(f.execute(),e=>e.status===403&&e.body.error==='CAPABILITY_MISSING');a.deepEqual(f.calls,[]);
});
for(const after of [null,{actor:'panel:other-actor',caps:['read_content','list_history','submission']},{actor:'panel:synthetic-read-original',caps:[]}])test('revocation or principal change during native reads prevents disclosure '+JSON.stringify(after),async()=>{
 const f=fixture({after});await a.rejects(f.execute(),e=>[401,403].includes(e.status));
});
test('foreign brand, unclassified lists and missing layouts never become guessed DTOs',async()=>{
 for(const change of [c=>c.attribs.crm.brand='aristo',c=>c.lists=[{id:16}],c=>c.lists=[{id:99}],c=>c.template_id=null,c=>delete c.body]){const row=campaign();change(row);const f=fixture({row});await a.rejects(f.execute(),e=>[404,503].includes(e.status));}
});
test('legacy list reads every page with bodies and filters the original CRM policy',async()=>{
 const first=Array.from({length:100},(_,i)=>campaign(i+1));first[1]=campaign(2,'aristo');first[2].attribs.crm.policy='other-policy';
 const f=fixture({pages:page=>({total:101,results:page===1?first:[campaign(101)]})}),r=await f.execute({acao:'campanha_listar'});a.equal(r.body.campaigns.length,99);a(r.body.campaigns.every(c=>c.definition.html==='<p>Synthetic body</p>'));a(f.calls.some(c=>c.path==='/api/campaigns?no_body=false&per_page=100&page=2'));
});
test('a moving page snapshot or missing rows fail instead of appearing complete',async()=>{
 const first=Array.from({length:100},(_,i)=>campaign(i+1));
 for(const pages of [p=>({total:p===1?101:102,results:p===1?first:[campaign(101),campaign(102)]}),p=>({total:101,results:p===1?first:[]}),p=>({total:101,results:p===1?first:[campaign(1)]})]){const f=fixture({pages});await a.rejects(f.execute({acao:'campanha_listar'}),e=>e.status===503);}
});
test('native optimistic version is stable across key ordering and changes with content',()=>{
 a.equal(version({a:1,b:{d:2,c:3}}),version({b:{c:3,d:2},a:1}));a.notEqual(version(campaign()),version({...campaign(),body:'changed'}));
});
test('unsupported mutations, validation, history and recovery remain explicit dependencies',()=>{
 const f=fixture();for(const acao of ['campanha_catalogo','campanha_salvar','campanha_validar','campanha_operacao','campanha_recuperar','campanha_agendar','campanha_cancelar'])a.equal(f.adapter.supports({acao}),false);
});
test('original transport dispatch retains the verified actor and does not enter SQL effect runtime',async()=>{
 const auth={actor:'template:synthetic-original',caps:['read_content']};let entered=0;
 const executor=createExecutor({pool:{query:async()=>({rows:[{auth}]})},native:()=>a.fail('native write'),nativeReads:{supports:()=>true,execute:async input=>{a.equal(input.auth,auth);a.equal(input.key,'synthetic-template-key');entered++;return {status:200,body:{campaigns:[]}};}},runtimeFactory:()=>a.fail('legacy runtime must not create claims')});
 a.deepEqual(await executor({key:'synthetic-template-key',command:{acao:'campanha_listar',brand:'fish'}}),{status:200,body:{campaigns:[]}});a.equal(entered,1);
});
test('GET-only API16 transport rejects arbitrary paths before I/O and never retries',async()=>{
 let calls=0;const read=createNativeReadTransport({origin:'https://email.shrigma.com.br/',username:'synthetic-api16',token:'synthetic-token',fetchFn:async(_url,q)=>{calls++;a.equal(q.method,'GET');throw Error('private upstream details');}});
 for(const path of ['/api/subscribers','https://other.invalid/','/api/campaigns/1/status','/api/campaigns/../subscribers','/api/campaigns?no_body=true&per_page=100&page=1'])await a.rejects(read(path),/NATIVE_READ_PATH_INVALID/);a.equal(calls,0);
 await a.rejects(read('/api/campaigns/1'),e=>e.message==='NATIVE_READ_UNAVAILABLE');a.equal(calls,1);
});
