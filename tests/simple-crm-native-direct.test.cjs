'use strict';
const test=require('node:test'),a=require('node:assert/strict'),path=require('node:path');
const runtime=process.env.DASHBOARD_ACCESS_TEST_RUNTIME||path.resolve(__dirname,'../services/dashboard-operational');
const {createDirect,nativeListBrand}=require(runtime+'/simple-crm-native-internal.cjs');
const now=Date.UTC(2026,9,20,18),sendAt='2026-10-21T13:00:00.000Z';
test('native list count reads actual membership only after brand admission and never returns subscribers',async()=>{
 for(const total of [12437,0,null]){
  const calls=[],adapter=createDirect({now:()=>now,authorize:()=>({role:'manager'}),admitted:()=>false,credentials:{fish:{username:'synthetic',token:'synthetic',listIds:[17,284]}},fetchImpl:async(url,options)=>{calls.push({url,method:options.method});const u=new URL(url);return Response.json({data:u.pathname==='/api/lists/284'?{id:284,status:'active',tags:['fish']}:{total,results:[{email:'private@example.invalid'}]}});}});
  for(const list_id of ['284']){await a.rejects(adapter.handle({},'GET',{acao:'campanha_lista_contagem',brand:'fish',list_id}),e=>e.code==='CAMPAIGN_BRAND_REFUSED');a.equal(calls.length,0);}
  const read=()=>adapter.handle({},'GET',{acao:'campanha_lista_contagem',brand:'fish',list_id:284});
  if(total===null)await a.rejects(read,e=>e.code==='LISTMONK_RESPONSE_UNCONFIRMED');else{const r=await read();a.deepEqual(r.body,{brand:'fish',list_id:284,member_count:total,checked_at:new Date(now).toISOString(),source:'listmonk'});a(!JSON.stringify(r).includes('private@example.invalid'));a(!Object.hasOwn(r.body,'eligible_count'));}
  a(calls.every(c=>c.method==='GET'));a.equal(calls.length,2);a.equal(new URL(calls[1].url).searchParams.get('list_id'),'284');a.equal(new URL(calls[1].url).searchParams.get('per_page'),'1');
 }
});
test('inactive native list cannot be counted',async()=>{
 let calls=0;const adapter=createDirect({authorize:()=>({role:'manager'}),admitted:()=>false,credentials:{fish:{username:'synthetic',token:'synthetic',listIds:[17,284]}},fetchImpl:async()=>{calls++;return Response.json({data:{id:284,status:'archived',tags:['fish']}});}});await a.rejects(adapter.handle({},'GET',{acao:'campanha_lista_contagem',brand:'fish',list_id:284}),e=>e.code==='CAMPAIGN_LIST_UNAVAILABLE');a.equal(calls,1);
});
function fixture(brand,{released=true,edit=true,fail=false,boolStatus=false}={}){
 const id=brand==='aristo'?16:17,domain=brand==='aristo'?'oaristocrata.com':'fishermans.com.br',calls=[],source=new Map(),lists=[{id:16,name:'Aristo',status:'active',tags:['aristo']},{id:17,name:'Fish',status:'active',tags:['fish']}];
 const credentials={aristo:{username:'synthetic-aristo',token:'synthetic-aristo-token',listIds:[999]},fish:{username:'synthetic-fish',token:'synthetic-fish-token',listIds:[999]}};
 const adapter=createDirect({now:()=>now,credentials,admitted:()=>released,authorize:(_ctx,b,write)=>{a.equal(b,brand);if(write&&!edit)throw Object.assign(Error('PRODUCT_WRITE_DENIED'),{code:'PRODUCT_WRITE_DENIED',status:403});return{id:'synthetic-editor',role:'manager',permissions:{growth:{read:true,edit}}};},fetchImpl:async(url,options)=>{
  calls.push({url,method:options.method,body:options.body&&JSON.parse(options.body)});a.equal(options.headers.Authorization,'Basic '+Buffer.from(credentials[brand].username+':'+credentials[brand].token).toString('base64'));if(fail)throw Error('A private upstream error must never be returned');
  const u=new URL(url),q=calls.at(-1).body;let result;
  if(options.method==='POST'&&u.pathname==='/api/campaigns'){const row={...q,template_id:q.template_id??1,id:700,lists:q.lists.map(id=>({id})),status:'draft',sent:0,started_at:null,updated_at:'2026-10-20T18:00:00Z'};source.set(row.id,row);result=row;}
  else if(options.method==='POST'&&u.pathname==='/api/campaigns/700/test')result=true;
  else if(options.method==='PUT'&&u.pathname==='/api/campaigns/700/status'){const row=source.get(700);row.status=q.status;result=boolStatus?true:row;}
  else if(options.method==='PUT'&&u.pathname==='/api/campaigns/700'){const row=source.get(700);Object.assign(row,q,{lists:q.lists.map(id=>({id}))});if(row.status==='scheduled'&&q.send_at===null)row.status='draft';result=row;}
  else if(options.method==='GET'&&u.pathname==='/api/campaigns/700')result=source.get(700);
  else if(options.method==='GET'&&u.pathname==='/api/lists')result={total:lists.length,results:lists};
  else if(options.method==='GET'&&u.pathname.startsWith('/api/lists/'))result=lists.find(l=>l.id===Number(u.pathname.split('/').at(-1)));
  else if(options.method==='GET'&&u.pathname==='/api/subscribers')result={total:42,results:[]};
  else if(options.method==='GET'&&u.pathname==='/api/campaigns')result={total:source.size,results:[...source.values()]};
  else throw Error('UNEXPECTED_NATIVE_CALL');
  return Response.json({data:structuredClone(result)});
 }});
 const definition={schema_version:'crm-campaign-v1',brand,channel:'email',name:'[QA] native editor',subject:'Olá {{ .Subscriber.FirstName }}',from_email:'avisos@'+domain,reply_to:'contato@'+domain,list_ids:[id],template_id:1,html:'<p>Olá {{ .Subscriber.FirstName }}</p>',text:'Olá {{ .Subscriber.FirstName }}',initiative:{key:'qa-native',name:'Teste interno'},utm_campaign:'qa-native',tags:['qa'],send_at:sendAt};
 return{adapter,definition,calls,source,id,lists};
}
for(const brand of ['aristo','fish'])test(brand+': external CTA saves and reopens with content warning outside the transport payload',async()=>{
 const f=fixture(brand),url='https://external.example/vip?brand='+brand,html='<a href="'+url+'">VIP</a><a href="{{ UnsubscribeURL }}">Sair</a>',definition={...f.definition,html,text:url,send_at:null},saved=await f.adapter.handle({},'POST',{acao:'campanha_criar',brand,definition});
 a.equal(saved.status,201);a.equal(saved.body.campaign.status,'draft');a.equal(saved.body.campaign.sent,0);a.equal(saved.body.campaign.send_at,null);a.equal(saved.body.campaign.definition.html,html);a.equal(saved.body.campaign.definition.text,url);a(saved.body.campaign.content_diagnostics.some(x=>x.code==='EXTERNAL_CTA'&&x.severity==='warning'));a(!Object.hasOwn(f.calls.find(x=>x.method==='POST').body,'content_diagnostics'));a(!Object.hasOwn(saved.body.campaign.definition,'content_diagnostics'));
 const got=await f.adapter.handle({},'GET',{acao:'campanha_obter',brand,id:700});a.deepEqual(got.body.campaign.content_diagnostics,saved.body.campaign.content_diagnostics);a.equal(got.body.campaign.definition.html,html);const list=await f.adapter.handle({},'GET',{acao:'campanha_listar',brand,page:1});a.equal(Object.hasOwn(list.body.campaigns[0],'content_diagnostics'),false);a(f.calls.every(x=>!x.url.endsWith('/test')&&!x.url.endsWith('/status')));
});
for(const brand of ['aristo','fish'])test(brand+': one native write per action with existing-ID brand reads; no journal or operation key',async()=>{
 const f=fixture(brand),invoke=(acao,fields={})=>f.adapter.handle({},'POST',{acao,brand,...fields});
 let r=await invoke('campanha_criar',{definition:f.definition,audience_id:'synthetic-public',audience_name:'Base inteira'});a.equal(r.status,201);a.equal(r.body.campaign.status,'draft');a.equal(r.body.campaign.send_at,sendAt);a.equal(f.calls.length,2);a.deepEqual(f.calls.at(-1).body.lists,[f.id]);a.equal(r.body.attemptKey,undefined);
 const saved=structuredClone(f.source.get(700));
 r=await invoke('campanha_teste',{id:700,definition:r.body.campaign.definition,recipient:'felipebandeira+codex@oaristocrata.com'});a.equal(r.body.accepted,true);a.equal(f.calls.length,5);a.equal(f.calls.at(-1).method,'POST');a.equal(new URL(f.calls.at(-1).url).pathname,'/api/campaigns/700/test');a.equal(f.calls.at(-1).body.subject,'[TESTE] '+f.definition.subject);a.deepEqual(f.calls.at(-1).body.subscribers,['felipebandeira+codex@oaristocrata.com']);a.equal(f.calls.at(-1).body.send_at,undefined);a.deepEqual(f.source.get(700),saved);
 r=await invoke('campanha_agendar',{id:700,confirm:'agendar',send_at:sendAt});a.equal(r.body.campaign.status,'scheduled');a.equal(f.calls.length,8);a.deepEqual(f.calls.at(-1).body,{status:'scheduled'});
 const attrs={...r.body.campaign.attribs,external:{preserve:true}};
 r=await invoke('campanha_cancelar',{id:700,confirm:'cancelar',list_ids:[f.id],attribs:attrs,media:[42]});a.equal(f.calls.length,11);a.equal(r.body.campaign.status,'draft');a.equal(r.body.campaign.send_at,null);a.equal(r.body.campaign.sent,0);a.deepEqual(f.source.get(700).attribs,attrs);a.deepEqual(f.source.get(700).media,[42]);a.deepEqual(f.calls.at(-1).body,{lists:[f.id],send_at:null,attribs:attrs,media:[42]});
 a.equal(f.calls.filter(c=>c.method!=='GET').length,4);for(const call of f.calls.filter(c=>c.method!=='GET')){for(const key of ['idempotency_key','preview_token','claim_id','audience_review_id','expected_version'])a.equal(Object.hasOwn(call.body,key),false);}
});
for(const brand of ['aristo','fish'])test(brand+': permissions, release, permissions fail before reads; foreign lists and external TEST cannot write',async()=>{
 for(const options of [{released:false},{edit:false}]){const f=fixture(brand,options);await a.rejects(f.adapter.handle({},'POST',{acao:'campanha_criar',brand,definition:f.definition}),e=>e.status===403);a.equal(f.calls.length,0);}
 const f=fixture(brand);await a.rejects(f.adapter.handle({},'POST',{acao:'campanha_criar',brand,definition:{...f.definition,list_ids:[brand==='aristo'?17:16]}}));
 await a.rejects(f.adapter.handle({},'POST',{acao:'campanha_teste',brand,id:700,definition:f.definition,recipient:'customer@example.invalid'}),e=>e.code==='CAMPAIGN_TEST_RECIPIENT');a.equal(f.calls.length,1);a.equal(f.calls.filter(c=>c.method!=='GET').length,0);
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
 let r=await invoke('campanha_salvar',{id:700,definition:f.definition,attribs,media,headers});a.equal(f.calls.length,5);a.equal(r.body.campaign.send_at,sendAt);a.deepEqual(f.calls.at(-1).body.attribs.external,attribs.external);a.equal(f.calls.at(-1).body.attribs.shrigma.other,'kept');a.deepEqual(f.calls.at(-1).body.media,media);a(f.calls.at(-1).body.headers.some(x=>x['X-Campaign']==='preserved'));
 await invoke('campanha_teste',{id:700,definition:r.body.campaign.definition,recipient:'felipebandeira+codex@oaristocrata.com',attribs:r.body.campaign.attribs,media:r.body.campaign.media,headers:r.body.campaign.headers});a.equal(f.calls.length,8);a(f.calls.at(-1).body.headers.some(x=>x['X-Campaign']==='preserved'));a(!f.calls.at(-1).body.headers.some(x=>Object.keys(x).some(k=>['to','cc','bcc'].includes(k.toLowerCase()))));
});
test('an unexpected native status boolean does not invent a campaign or trigger another call',async()=>{
 const f=fixture('fish',{boolStatus:true});await f.adapter.handle({},'POST',{acao:'campanha_criar',brand:'fish',definition:f.definition});await a.rejects(f.adapter.handle({},'POST',{acao:'campanha_agendar',brand:'fish',id:700,confirm:'agendar',send_at:sendAt}),e=>e.code==='LISTMONK_RESPONSE_UNCONFIRMED');a.equal(f.calls.length,5);
});
for(const brand of ['aristo','fish'])test(brand+': catalog delegates default layout without template permissions, SQL catalog or foreign lists',async()=>{
 const f=fixture(brand),r=await f.adapter.handle({},'GET',{acao:'campanha_catalogo',brand});
 a.equal(r.status,200);a.equal(r.body.brand,brand);a.deepEqual(r.body.lists,[{id:f.id,name:brand==='aristo'?'Aristo':'Fish',brand,available:true}]);
 a.equal(r.body.templates.length,1);a.equal(r.body.templates[0].id,null);a.equal(r.body.templates[0].native_default,true);a.equal(r.body.templates[0].name,'Padrão do Listmonk');
 a.equal(new URL(f.calls[0].url).searchParams.get('minimal'),'true');a.equal(new URL(f.calls[0].url).searchParams.get('per_page'),'all');
 a.deepEqual(f.calls.map(x=>[x.method,new URL(x.url).pathname]),[['GET','/api/lists']]);
});
test('opening and saving an older native campaign retains its existing initiative and UTM identity',async()=>{
 const f=fixture('fish');await f.adapter.handle({},'POST',{acao:'campanha_criar',brand:'fish',definition:f.definition});
 const legacy={brand:'fish',policy:'crm-campaign-v1',initiative_key:'old-initiative',initiative_name:'Existing initiative',utm_campaign:'existing-utm'};f.source.get(700).attribs={crm:legacy};
 const read=await f.adapter.handle({},'GET',{acao:'campanha_obter',brand:'fish',id:700}),c=read.body.campaign;
 a.deepEqual(c.definition.initiative,{key:'old-initiative',name:'Existing initiative'});a.equal(c.definition.utm_campaign,'existing-utm');
 const saved=await f.adapter.handle({},'POST',{acao:'campanha_salvar',brand:'fish',id:700,definition:c.definition,attribs:c.attribs,headers:c.headers,media:c.media});
 a.deepEqual(saved.body.campaign.attribs.crm,legacy);a.equal(saved.body.campaign.definition.utm_campaign,'existing-utm');a.equal(f.calls.length,7);
});
test('a campaign with the native null layout keeps Listmonk default selection on Save',async()=>{
 const f=fixture('aristo');await f.adapter.handle({},'POST',{acao:'campanha_criar',brand:'aristo',definition:{...f.definition,template_id:null}});
 const c=(await f.adapter.handle({},'GET',{acao:'campanha_obter',brand:'aristo',id:700})).body.campaign;a.equal(c.definition.template_id,1);a.equal(Object.hasOwn(f.calls.find(c=>c.method==='POST').body,'template_id'),false);
 const saved=await f.adapter.handle({},'POST',{acao:'campanha_salvar',brand:'aristo',id:700,definition:c.definition,attribs:c.attribs,headers:c.headers,media:c.media});
 a.equal(saved.body.campaign.definition.template_id,1);a.equal(f.calls.at(-1).body.template_id,1);a.equal(f.calls.length,7);
});

for(const action of ['campanha_salvar','campanha_teste','campanha_agendar','campanha_cancelar'])test('shared API16 refuses a foreign campaign ID before '+action,async()=>{const f=fixture('fish');await f.adapter.handle({},'POST',{acao:'campanha_criar',brand:'fish',definition:f.definition});const before=structuredClone(f.source.get(700));f.source.get(700).lists=[{id:16}];const calls=f.calls.length;await a.rejects(f.adapter.handle({},'POST',{acao:action,brand:'fish',id:700,definition:f.definition,attribs:{},headers:[],media:[],recipient:'felipebandeira+codex@oaristocrata.com',send_at:sendAt,confirm:action==='campanha_cancelar'?'cancelar':'agendar',list_ids:[17]}),e=>e.code==='CAMPAIGN_BRAND_REFUSED');a.deepEqual(f.calls.slice(calls).map(c=>c.method),['GET','GET']);a.equal(f.source.get(700).status,before.status);});

test('schedule checks the saved instant instead of trusting a different future value from the client',async()=>{const f=fixture('aristo');await f.adapter.handle({},'POST',{acao:'campanha_criar',brand:'aristo',definition:f.definition});await a.rejects(f.adapter.handle({},'POST',{acao:'campanha_agendar',brand:'aristo',id:700,confirm:'agendar',send_at:'2026-10-22T13:00:00Z'}),e=>e.code==='NATIVE_INTERNAL_DATE');a.equal(f.calls.filter(c=>c.method==='PUT').length,0);});

test('native scheduling admits the full seven-day window without a recipient cap',async()=>{const f=fixture('fish'),send_at=new Date(now+7*86400000).toISOString();const created=await f.adapter.handle({},'POST',{acao:'campanha_criar',brand:'fish',definition:{...f.definition,send_at}});const scheduled=await f.adapter.handle({},'POST',{acao:'campanha_agendar',brand:'fish',id:created.body.campaign.id,confirm:'agendar',send_at});a.equal(scheduled.body.campaign.status,'scheduled');a.equal(f.calls.filter(c=>c.method!=='GET').length,2);});

for(const [name,tags,expected] of [
 ['Grupo novo',['fish'],'fish'],['Grupo novo',[' FISHERMANS '],'fish'],['Grupo novo',['aristo'],'aristo'],['Grupo novo',['aristocrata'],'aristo'],
 ['FISH→ARISTO · indicação cruzada',['fish','cross'],'fish'],['ARISTO — nome divergente',['fish'],'fish'],
 ['FISH — novo',[], 'fish'],['FISHERMANS · novo',undefined,'fish'],['O ARISTOCRATA — novo',[],'aristo'],
 ['Base Fishermans - Geral',[],'fish'],['Base Aristocrata - Geral',[],'aristo'],['Novo grupo',['constructor','fish'],'fish'],
 ['FISH — ARISTO · conjunta',[],null],['ARISTO — Olivas · conjunta',[],null],
 ['Texto com Fish no meio',[],null],['FISHING — novo',[],null],['FISH',[],null],['FISH — novo',['fish','aristo'],null],
 ['FISH — novo',['fish','olivas'],null],['FISH — novo',['olivas'],null],['Sem marca',['cross'],null],['FISH — novo','fish',null]
])test('original list classification: '+JSON.stringify({name,tags,expected}),()=>a.equal(nativeListBrand({name,tags}),expected));

for(const brand of ['aristo','fish'])test(brand+': a newly created native list appears and supports the full draft/agenda/cancel path without an ID binding',async()=>{
 const f=fixture(brand),catalog=()=>f.adapter.handle({},'GET',{acao:'campanha_catalogo',brand}),list_id=9001;
 a(!(await catalog()).body.lists.some(l=>l.id===list_id));
 f.lists.push({id:list_id,name:'Lista criada após a abertura do CRM',tags:[brand],status:'active'});
 a((await catalog()).body.lists.some(l=>l.id===list_id&&l.available));
 const count=await f.adapter.handle({},'GET',{acao:'campanha_lista_contagem',brand,list_id});a.equal(count.body.member_count,42);
 const invoke=(acao,fields={})=>f.adapter.handle({},'POST',{acao,brand,...fields});
 const created=await invoke('campanha_criar',{definition:{...f.definition,list_ids:[list_id]}});a.deepEqual(created.body.campaign.definition.list_ids,[list_id]);
 await invoke('campanha_agendar',{id:700,confirm:'agendar',send_at:sendAt});
 const archived=f.lists.find(l=>l.id===list_id);archived.status='archived';
 a.equal((await catalog()).body.lists.find(l=>l.id===list_id).available,false);
 const history=(await f.adapter.handle({},'GET',{acao:'campanha_obter',brand,id:700})).body.campaign;a.equal(history.status,'scheduled');
 await a.rejects(f.adapter.handle({},'GET',{acao:'campanha_lista_contagem',brand,list_id}),e=>e.code==='CAMPAIGN_LIST_UNAVAILABLE');
 const before=f.calls.filter(c=>c.method!=='GET').length;
 await a.rejects(invoke('campanha_agendar',{id:700,confirm:'agendar',send_at:sendAt}),e=>e.code==='CAMPAIGN_LIST_UNAVAILABLE');
 a.equal(f.calls.filter(c=>c.method!=='GET').length,before);
 const canceled=await invoke('campanha_cancelar',{id:700,confirm:'cancelar',list_ids:[list_id],attribs:history.attribs,media:history.media});a.equal(canceled.body.campaign.status,'draft');a.equal(canceled.body.campaign.send_at,null);
 a.equal(f.calls.filter(c=>c.method!=='GET').length,3);
});

for(const action of ['campanha_criar','campanha_salvar','campanha_teste','campanha_agendar','campanha_cancelar','campanha_obter','campanha_listar','campanha_lista_contagem'])test('native brand revocation after a catalog read blocks '+action+' without a write',async()=>{
 const f=fixture('fish');await f.adapter.handle({},'POST',{acao:'campanha_criar',brand:'fish',definition:f.definition});
 await f.adapter.handle({},'GET',{acao:'campanha_catalogo',brand:'fish'});f.lists.find(l=>l.id===17).tags=['aristo'];const before=f.calls.length;
 const fields={acao:action,brand:'fish',id:700,list_id:17,list_ids:[17],definition:f.definition,attribs:{},headers:[],media:[],confirm:action==='campanha_cancelar'?'cancelar':'agendar',send_at:sendAt,recipient:'felipebandeira+codex@oaristocrata.com'};
 if(action==='campanha_listar')a.deepEqual((await f.adapter.handle({},'GET',fields)).body.campaigns,[]);
 else await a.rejects(f.adapter.handle({},['campanha_obter','campanha_lista_contagem'].includes(action)?'GET':'POST',fields),e=>e.code==='CAMPAIGN_BRAND_REFUSED');
 a(f.calls.slice(before).length>0);a(f.calls.slice(before).every(c=>c.method==='GET'));
});

test('mixed-brand campaign lists cannot be read or scheduled even if embedded list tags claim Fish',async()=>{
 const f=fixture('fish');await f.adapter.handle({},'POST',{acao:'campanha_criar',brand:'fish',definition:f.definition});f.source.get(700).lists=[{id:17,tags:['fish']},{id:16,tags:['fish']}];const before=f.calls.length;
 for(const acao of ['campanha_obter','campanha_agendar'])await a.rejects(f.adapter.handle({},acao==='campanha_obter'?'GET':'POST',{acao,brand:'fish',id:700,send_at:sendAt,confirm:'agendar'}),e=>e.code==='CAMPAIGN_BRAND_REFUSED');
 a(f.calls.slice(before).every(c=>c.method==='GET'));
});

test('unavailable or malformed native metadata never falls back to a manual binding or a cached catalog',async()=>{
 for(const unavailable of [true,false]){let fail=false,writes=0;
  const adapter=createDirect({now:()=>now,authorize:()=>({role:'manager',permissions:{growth:{edit:true}}}),admitted:()=>true,credentials:{fish:{username:'synthetic',token:'synthetic',listIds:[17]}},fetchImpl:async(_url,options)=>{if(options.method!=='GET')writes++;if(fail)return unavailable?new Response('{}',{status:503}):Response.json({data:{total:1}});return Response.json({data:[{id:17,tags:['fish'],status:'active'}]});}});
  await adapter.handle({},'GET',{acao:'campanha_catalogo',brand:'fish'});fail=true;
  await a.rejects(adapter.handle({},'GET',{acao:'campanha_catalogo',brand:'fish'}),e=>e.status===502);
  await a.rejects(adapter.handle({},'POST',{acao:'campanha_criar',brand:'fish',definition:fixture('fish').definition}),e=>e.status===502);a.equal(writes,0);
 }
});

test('release removed during the original metadata read prevents the native write',async()=>{
 let released=true,writes=0;const adapter=createDirect({now:()=>now,authorize:()=>({role:'manager',permissions:{growth:{edit:true}}}),admitted:()=>released,credentials:{fish:{username:'synthetic',token:'synthetic'}},fetchImpl:async(_url,options)=>{if(options.method!=='GET')writes++;released=false;return Response.json({data:[{id:17,tags:['fish'],status:'active'}]});}});
 await a.rejects(adapter.handle({},'POST',{acao:'campanha_criar',brand:'fish',definition:fixture('fish').definition}),e=>e.code==='CAMPAIGN_RELEASE_CLOSED');a.equal(writes,0);
});
for(const data of [{total:2,results:[{id:17,name:'Fish',tags:['fish'],status:'active'}]},{total:2,results:[]},{results:[]}])test('an incomplete native catalog is unavailable instead of current: '+JSON.stringify(data),async()=>{
 const adapter=createDirect({authorize:()=>({role:'manager'}),admitted:()=>false,credentials:{fish:{username:'synthetic',token:'synthetic'}},fetchImpl:async()=>Response.json({data})});
 await a.rejects(adapter.handle({},'GET',{acao:'campanha_catalogo',brand:'fish'}),e=>e.code==='LISTMONK_RESPONSE_UNCONFIRMED');
});
