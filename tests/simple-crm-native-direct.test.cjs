'use strict';
const test=require('node:test'),a=require('node:assert/strict'),path=require('node:path');
const runtime=process.env.DASHBOARD_ACCESS_TEST_RUNTIME||path.resolve(__dirname,'../services/dashboard-operational');
const {createDirect}=require(runtime+'/simple-crm-native-internal.cjs');
const now=Date.UTC(2026,9,20,18),sendAt='2026-10-21T13:00:00.000Z';
function fixture(brand,{released=true,edit=true,fail=false,boolStatus=false}={}){
 const id=brand==='aristo'?16:17,domain=brand==='aristo'?'oaristocrata.com':'fishermans.com.br',calls=[],source=new Map();
 const credentials={aristo:{username:'synthetic-aristo',token:'synthetic-aristo-token',listIds:[16]},fish:{username:'synthetic-fish',token:'synthetic-fish-token',listIds:[17]}};
 const adapter=createDirect({now:()=>now,credentials,admitted:()=>released,authorize:(_ctx,b,write)=>{a.equal(b,brand);if(write&&!edit)throw Object.assign(Error('PRODUCT_WRITE_DENIED'),{code:'PRODUCT_WRITE_DENIED',status:403});return{id:'synthetic-editor',role:'manager',permissions:{growth:{read:true,edit}}};},fetchImpl:async(url,options)=>{
  calls.push({url,method:options.method,body:options.body&&JSON.parse(options.body)});a.equal(options.headers.Authorization,'Basic '+Buffer.from(credentials[brand].username+':'+credentials[brand].token).toString('base64'));if(fail)throw Error('A private upstream error must never be returned');
  const u=new URL(url),q=calls.at(-1).body;let result;
  if(options.method==='POST'&&u.pathname==='/api/campaigns'){const row={...q,id:700,lists:q.lists.map(id=>({id})),status:'draft',sent:0,started_at:null,updated_at:'2026-10-20T18:00:00Z'};source.set(row.id,row);result=row;}
  else if(options.method==='POST'&&u.pathname==='/api/campaigns/700/test')result=true;
  else if(options.method==='PUT'&&u.pathname==='/api/campaigns/700/status'){const row=source.get(700);row.status=q.status;result=boolStatus?true:row;}
  else if(options.method==='PUT'&&u.pathname==='/api/campaigns/700'){const row=source.get(700);Object.assign(row,q,{lists:q.lists.map(id=>({id}))});if(row.status==='scheduled'&&q.send_at===null)row.status='draft';result=row;}
  else if(options.method==='GET'&&u.pathname==='/api/campaigns/700')result=source.get(700);
  else if(options.method==='GET'&&u.pathname==='/api/lists')result={total:2,results:[{id:16,name:'Aristo',status:'active'},{id:17,name:'Fish',status:'active'}]};
  else if(options.method==='GET'&&u.pathname==='/api/templates')result=[{id:1,name:'Default campaign template',type:'campaign',is_default:true},{id:14,name:'Outra marca transacional',type:'tx',is_default:false}];
  else throw Error('UNEXPECTED_NATIVE_CALL');
  return Response.json({data:structuredClone(result)});
 }});
 const definition={schema_version:'crm-campaign-v1',brand,channel:'email',name:'[QA] native editor',subject:'Olá {{ .Subscriber.FirstName }}',from_email:'avisos@'+domain,reply_to:'contato@'+domain,list_ids:[id],template_id:1,html:'<p>Olá {{ .Subscriber.FirstName }}</p>',text:'Olá {{ .Subscriber.FirstName }}',initiative:{key:'qa-native',name:'Teste interno'},utm_campaign:'qa-native',tags:['qa'],send_at:sendAt};
 return{adapter,definition,calls,source,id};
}
for(const brand of ['aristo','fish'])test(brand+': one native write per action with existing-ID brand reads; no journal or operation key',async()=>{
 const f=fixture(brand),invoke=(acao,fields={})=>f.adapter.handle({},'POST',{acao,brand,...fields});
 let r=await invoke('campanha_criar',{definition:f.definition,audience_id:'synthetic-public',audience_name:'Base inteira'});a.equal(r.status,201);a.equal(r.body.campaign.status,'draft');a.equal(r.body.campaign.send_at,sendAt);a.equal(f.calls.length,1);a.deepEqual(f.calls[0].body.lists,[f.id]);a.equal(r.body.attemptKey,undefined);
 const saved=structuredClone(f.source.get(700));
 r=await invoke('campanha_teste',{id:700,definition:r.body.campaign.definition,recipient:'felipebandeira+codex@oaristocrata.com'});a.equal(r.body.accepted,true);a.equal(f.calls.length,3);a.equal(f.calls[2].method,'POST');a.equal(new URL(f.calls[2].url).pathname,'/api/campaigns/700/test');a.equal(f.calls[2].body.subject,'[TESTE] '+f.definition.subject);a.deepEqual(f.calls[2].body.subscribers,['felipebandeira+codex@oaristocrata.com']);a.equal(f.calls[2].body.send_at,undefined);a.deepEqual(f.source.get(700),saved);
 r=await invoke('campanha_agendar',{id:700,confirm:'agendar',send_at:sendAt});a.equal(r.body.campaign.status,'scheduled');a.equal(f.calls.length,5);a.deepEqual(f.calls[4].body,{status:'scheduled'});
 const attrs={...r.body.campaign.attribs,external:{preserve:true}};
 r=await invoke('campanha_cancelar',{id:700,confirm:'cancelar',list_ids:[f.id],attribs:attrs,media:[42]});a.equal(f.calls.length,7);a.equal(r.body.campaign.status,'draft');a.equal(r.body.campaign.send_at,null);a.equal(r.body.campaign.sent,0);a.deepEqual(f.source.get(700).attribs,attrs);a.deepEqual(f.source.get(700).media,[42]);a.deepEqual(f.calls[6].body,{lists:[f.id],send_at:null,attribs:attrs,media:[42]});
 a.equal(f.calls.filter(c=>c.method!=='GET').length,4);for(const call of f.calls.filter(c=>c.method!=='GET')){for(const key of ['idempotency_key','preview_token','claim_id','audience_review_id','expected_version'])a.equal(Object.hasOwn(call.body,key),false);}
});
for(const brand of ['aristo','fish'])test(brand+': permissions, release, foreign lists and external TEST fail before a native request',async()=>{
 for(const options of [{released:false},{edit:false}]){const f=fixture(brand,options);await a.rejects(f.adapter.handle({},'POST',{acao:'campanha_criar',brand,definition:f.definition}),e=>e.status===403);a.equal(f.calls.length,0);}
 const f=fixture(brand);await a.rejects(f.adapter.handle({},'POST',{acao:'campanha_criar',brand,definition:{...f.definition,list_ids:[brand==='aristo'?17:16]}}));
 await a.rejects(f.adapter.handle({},'POST',{acao:'campanha_teste',brand,id:700,definition:f.definition,recipient:'customer@example.invalid'}),e=>e.code==='CAMPAIGN_TEST_RECIPIENT');a.equal(f.calls.length,0);
});
test('past or unsaved dates cannot trigger native scheduling; missing metadata cannot clear fields',async()=>{
 const f=fixture('aristo');for(const date of [null,'2026-10-20T17:59:00Z','2026-10-20T18:10:00Z','2026-10-30T13:00:00Z'])await a.rejects(f.adapter.handle({},'POST',{acao:'campanha_agendar',brand:'aristo',id:700,confirm:'agendar',send_at:date}),e=>e.code==='NATIVE_INTERNAL_DATE');
 await a.rejects(f.adapter.handle({},'POST',{acao:'campanha_cancelar',brand:'aristo',id:700,confirm:'cancelar',list_ids:[16]}),e=>e.code==='CAMPAIGN_INPUT');a.equal(f.calls.length,0);
});
test('an uncertain native write is made once and never retried or converted into a local attempt',async()=>{
 const f=fixture('aristo',{fail:true});await a.rejects(f.adapter.handle({},'POST',{acao:'campanha_criar',brand:'aristo',definition:f.definition}),e=>e.code==='LISTMONK_RESULT_UNCONFIRMED'&&!e.message.includes('private'));a.equal(f.calls.length,1);
});
test('direct Save and TEST retain the existing script and redirect protection before the single request',async()=>{
 for(const action of ['campanha_criar','campanha_salvar','campanha_teste'])for(const html of ['<script>alert(1)</script>','<meta http-equiv="refresh" content="0;url=https://outside.invalid/">','<a href="https://fishermans.com.br/discount/QA?redirect=https%3A%2F%2Foutside.invalid%2F">Cupom</a>']){
  const f=fixture('fish');await a.rejects(f.adapter.handle({},'POST',{acao:action,brand:'fish',id:700,definition:{...f.definition,html},attribs:{},media:[],headers:[],recipient:'felipebandeira+codex@oaristocrata.com'}),e=>e.code==='CAMPAIGN_CONTENT_INVALID');a.equal(f.calls.length,0);
 }
});
test('Save preserves native attributes, attachments and ordinary headers; TEST strips recipient headers',async()=>{
 const f=fixture('fish'),invoke=(acao,fields={})=>f.adapter.handle({},'POST',{acao,brand:'fish',...fields});
 await invoke('campanha_criar',{definition:{...f.definition,send_at:null}});
 const attribs={external:{source:'preserved'},shrigma:{other:'kept'}},media=[42],headers=[{'X-Campaign':'preserved'},{To:'external@example.invalid'},{Cc:'external@example.invalid'},{Bcc:'external@example.invalid'},{'Reply-To':'old@example.invalid'}];
 let r=await invoke('campanha_salvar',{id:700,definition:f.definition,attribs,media,headers});a.equal(f.calls.length,3);a.equal(r.body.campaign.send_at,sendAt);a.deepEqual(f.calls[2].body.attribs.external,attribs.external);a.equal(f.calls[2].body.attribs.shrigma.other,'kept');a.deepEqual(f.calls[2].body.media,media);a(f.calls[2].body.headers.some(x=>x['X-Campaign']==='preserved'));
 await invoke('campanha_teste',{id:700,definition:r.body.campaign.definition,recipient:'felipebandeira+codex@oaristocrata.com',attribs:r.body.campaign.attribs,media:r.body.campaign.media,headers:r.body.campaign.headers});a.equal(f.calls.length,5);a(f.calls[4].body.headers.some(x=>x['X-Campaign']==='preserved'));a(!f.calls[4].body.headers.some(x=>Object.keys(x).some(k=>['to','cc','bcc'].includes(k.toLowerCase()))));
});
test('an unexpected native status boolean does not invent a campaign or trigger another call',async()=>{
 const f=fixture('fish',{boolStatus:true});await f.adapter.handle({},'POST',{acao:'campanha_criar',brand:'fish',definition:f.definition});await a.rejects(f.adapter.handle({},'POST',{acao:'campanha_agendar',brand:'fish',id:700,confirm:'agendar',send_at:sendAt}),e=>e.code==='LISTMONK_RESPONSE_UNCONFIRMED');a.equal(f.calls.length,3);
});
for(const brand of ['aristo','fish'])test(brand+': catalog reads native lists and template without the SQL catalog or foreign lists',async()=>{
 const f=fixture(brand),r=await f.adapter.handle({},'GET',{acao:'campanha_catalogo',brand});
 a.equal(r.status,200);a.equal(r.body.brand,brand);a.deepEqual(r.body.lists,[{id:f.id,name:brand==='aristo'?'Aristo':'Fish',brand,available:true}]);
 a.equal(r.body.templates.length,1);a.equal(r.body.templates[0].id,1);a.equal(r.body.templates[0].name,'Default campaign template');
 a.equal(new URL(f.calls[0].url).searchParams.get('minimal'),'true');
 a.equal(new URL(f.calls[1].url).searchParams.get('no_body'),'true');
 a.deepEqual(f.calls.map(x=>[x.method,new URL(x.url).pathname]),[['GET','/api/lists'],['GET','/api/templates']]);
});
test('opening and saving an older native campaign retains its existing initiative and UTM identity',async()=>{
 const f=fixture('fish');await f.adapter.handle({},'POST',{acao:'campanha_criar',brand:'fish',definition:f.definition});
 const legacy={brand:'fish',policy:'crm-campaign-v1',initiative_key:'old-initiative',initiative_name:'Existing initiative',utm_campaign:'existing-utm'};f.source.get(700).attribs={crm:legacy};
 const read=await f.adapter.handle({},'GET',{acao:'campanha_obter',brand:'fish',id:700}),c=read.body.campaign;
 a.deepEqual(c.definition.initiative,{key:'old-initiative',name:'Existing initiative'});a.equal(c.definition.utm_campaign,'existing-utm');
 const saved=await f.adapter.handle({},'POST',{acao:'campanha_salvar',brand:'fish',id:700,definition:c.definition,attribs:c.attribs,headers:c.headers,media:c.media});
 a.deepEqual(saved.body.campaign.attribs.crm,legacy);a.equal(saved.body.campaign.definition.utm_campaign,'existing-utm');a.equal(f.calls.length,4);
});
test('a campaign with the native null layout keeps Listmonk default selection on Save',async()=>{
 const f=fixture('aristo');await f.adapter.handle({},'POST',{acao:'campanha_criar',brand:'aristo',definition:{...f.definition,template_id:null}});
 const c=(await f.adapter.handle({},'GET',{acao:'campanha_obter',brand:'aristo',id:700})).body.campaign;a.equal(c.definition.template_id,null);
 const saved=await f.adapter.handle({},'POST',{acao:'campanha_salvar',brand:'aristo',id:700,definition:c.definition,attribs:c.attribs,headers:c.headers,media:c.media});
 a.equal(saved.body.campaign.definition.template_id,null);a.equal(f.calls.at(-1).body.template_id,null);a.equal(f.calls.length,4);
});

for(const action of ['campanha_salvar','campanha_teste','campanha_agendar','campanha_cancelar'])test('shared API16 refuses a foreign campaign ID before '+action,async()=>{const f=fixture('fish');await f.adapter.handle({},'POST',{acao:'campanha_criar',brand:'fish',definition:f.definition});const before=structuredClone(f.source.get(700));f.source.get(700).lists=[{id:16}];const calls=f.calls.length;await a.rejects(f.adapter.handle({},'POST',{acao:action,brand:'fish',id:700,definition:f.definition,attribs:{},headers:[],media:[],recipient:'felipebandeira+codex@oaristocrata.com',send_at:sendAt,confirm:action==='campanha_cancelar'?'cancelar':'agendar',list_ids:[17]}),e=>e.code==='CAMPAIGN_BRAND_REFUSED');a.deepEqual(f.calls.slice(calls).map(c=>c.method),['GET']);a.equal(f.source.get(700).status,before.status);});

test('schedule checks the saved instant instead of trusting a different future value from the client',async()=>{const f=fixture('aristo');await f.adapter.handle({},'POST',{acao:'campanha_criar',brand:'aristo',definition:f.definition});await a.rejects(f.adapter.handle({},'POST',{acao:'campanha_agendar',brand:'aristo',id:700,confirm:'agendar',send_at:'2026-10-22T13:00:00Z'}),e=>e.code==='NATIVE_INTERNAL_DATE');a.equal(f.calls.filter(c=>c.method==='PUT').length,0);});

test('native scheduling admits the full seven-day window without a recipient cap',async()=>{const f=fixture('fish'),send_at=new Date(now+7*86400000).toISOString();const created=await f.adapter.handle({},'POST',{acao:'campanha_criar',brand:'fish',definition:{...f.definition,send_at}});const scheduled=await f.adapter.handle({},'POST',{acao:'campanha_agendar',brand:'fish',id:created.body.campaign.id,confirm:'agendar',send_at});a.equal(scheduled.body.campaign.status,'scheduled');a.equal(f.calls.filter(c=>c.method!=='GET').length,2);});
