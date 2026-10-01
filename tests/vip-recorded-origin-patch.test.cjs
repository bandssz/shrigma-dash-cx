'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),P=require('../n8n/growth/vip-recorded-origin-patch.cjs');
const copy=v=>JSON.parse(JSON.stringify(v)),edge=node=>({node,type:'main',index:0});
function fixture(){const upsert='Upsert VIP (Listmonk PG)',source='alma',code=`const b = $json.body || {};\nlet email = String(b.email || '').trim().toLowerCase();\nif (!email) return [{ json: { ok: false } }];\nconst corrigido=false;\nreturn [{ json: { ok: true, email, origem: String(b.origem || 'lp').slice(0,64), corrigido } }];\n`;return {id:'fixture',versionId:'fixture-version',activeVersionId:'fixture-version',active:true,settings:{executionOrder:'v1'},nodes:[
 {id:'w',name:'Webhook VIP',type:'n8n-nodes-base.webhook',typeVersion:2,position:[0,0],parameters:{httpMethod:'POST',path:'fixture-vip',responseMode:'onReceived',options:{allowedOrigins:'https://example.invalid'}}},
 {id:'v',name:'Validar e Corrigir',type:'n8n-nodes-base.code',position:[1,0],parameters:{jsCode:code}},{id:'f',name:'Formato OK?',type:'n8n-nodes-base.if',position:[2,0],parameters:{}},{id:'d',name:'DNS MX',type:'n8n-nodes-base.httpRequest',position:[3,0],parameters:{url:'=https://dns.invalid/{{$json.domain}}'}},{id:'c',name:'Checar MX',type:'n8n-nodes-base.code',position:[4,0],parameters:{jsCode:"const original=$('Validar e Corrigir').first().json; return [{json:{...original,mx:true}}];"}},{id:'m',name:'Recebe email?',type:'n8n-nodes-base.if',position:[5,0],parameters:{}},
 {id:'p',name:upsert,type:'n8n-nodes-base.postgres',typeVersion:2,position:[6,0],parameters:{query:`SELECT eligible,reason FROM public.shrigma_crm_vip_subscribe_v1($1,$2,$3::boolean,'${source}');`,options:{queryReplacement:'={{ $json.email }},{{ $json.origem }},{{ $json.corrigido }}'}},credentials:{postgres:{id:'fixture'}}},
 {id:'b',name:'Montar boas-vindas',type:'n8n-nodes-base.code',position:[7,0],parameters:{jsCode:"if ($json.eligible !== true) return [];\nconst checked=$('Checar MX').first().json;return [{json:{...$json,email:checked.email}}];"}},{id:'s',name:'Boas-vindas VIP (Listmonk tx)',type:'transport',position:[8,0],parameters:{policy:'unchanged'},credentials:{httpHeaderAuth:{id:'transport'}}}
 ],connections:{'Webhook VIP':{main:[[edge('Validar e Corrigir')]]},'Validar e Corrigir':{main:[[edge('Formato OK?')]]},'Formato OK?':{main:[[edge('DNS MX')],[]]},'DNS MX':{main:[[edge('Checar MX')]]},'Checar MX':{main:[[edge('Recebe email?')]]},'Recebe email?':{main:[[edge(upsert)],[]]},[upsert]:{main:[[edge('Montar boas-vindas')]]},'Montar boas-vindas':{main:[[edge('Boas-vindas VIP (Listmonk tx)')]]}}};}
const guard=w=>({version:w.versionId,graphHash:P.graphHash(w),nodeHashes:Object.fromEntries(w.nodes.map(n=>[n.name,P.digest(n)]))});
function target(w){const base={source:'alma',producerId:'fixture-producer',baseVersion:w.versionId,baseGraphHash:P.graphHash(w),legacyPath:'fixture-vip',path:'fixture-vip-recorded-v2',upsert:'Upsert VIP (Listmonk PG)',webhookIds:['post-hook','get-hook'],ids:Array.from({length:13},(_,i)=>'id-'+i)};return {...base,producerRevision:P.deriveProducerRevision(w,base,guard(w))};}
const byName=(w,n)=>w.nodes.find(x=>x.name===n),next=(w,n,i=0)=>w.connections[n]?.main?.[i]?.map(x=>x.node)||[];

test('v2 is a separate pinned route and every legacy node and edge remains byte-for-byte unchanged',()=>{
 const w=fixture(),before=copy(w),t=target(w),p=P.transformPinnedWorkflow(w,t,guard(w));assert.deepEqual(w,before);assert.equal(p.nodes.length,w.nodes.length+13);assert.deepEqual(p.nodes.slice(0,w.nodes.length),w.nodes);
 for(const [name,value] of Object.entries(w.connections))assert.deepEqual(p.connections[name],value,name);
 const legacy=byName(p,'Webhook VIP'),v2=byName(p,P.V2.webhook),get=byName(p,P.V2.get);assert.equal(legacy.parameters.path,t.legacyPath);assert.equal(legacy.parameters.responseMode,'onReceived');assert.equal(v2.parameters.path,t.path);assert.equal(v2.parameters.responseMode,'usingRespondToWebhook');assert.notEqual(v2.id,legacy.id);assert.notEqual(get.id,legacy.id);assert.notEqual(get.id,v2.id);assert.equal(v2.webhookId,t.webhookIds[0]);assert.equal(get.webhookId,t.webhookIds[1]);assert.notEqual(v2.webhookId,get.webhookId);
 assert.deepEqual(next(p,'Webhook VIP'),['Validar e Corrigir']);assert.deepEqual(next(p,P.V2.webhook),[P.V2.validate]);
 const legacyUpsert=byName(p,t.upsert),v2Upsert=byName(p,P.V2.upsert);assert.match(legacyUpsert.parameters.query,/shrigma_crm_vip_subscribe_v1/);assert.doesNotMatch(legacyUpsert.parameters.query,/recorded_origin/);assert.match(v2Upsert.parameters.query,/recorded_origin_subscribe_v2/);
 assert.deepEqual(byName(p,'Boas-vindas VIP (Listmonk tx)'),byName(w,'Boas-vindas VIP (Listmonk tx)'));assert.deepEqual(next(p,P.V2.welcome),['Boas-vindas VIP (Listmonk tx)']);
 assert.deepEqual(byName(p,P.V2.dns).parameters,byName(w,'DNS MX').parameters);assert.deepEqual(byName(p,P.V2.dns).credentials,byName(w,'DNS MX').credentials);
 assert.match(byName(p,P.V2.check).parameters.jsCode,/CRM Origem v2 · Validar e Corrigir/);assert.doesNotMatch(byName(p,P.V2.check).parameters.jsCode,/\$\('Validar e Corrigir'\)/);
 assert.match(byName(p,P.V2.welcome).parameters.jsCode,/CRM Origem v2 · Checar MX/);assert.doesNotMatch(byName(p,P.V2.welcome).parameters.jsCode,/\$\('Checar MX'\)/);
 assert.deepEqual(byName(p,P.V2.welcome).parameters,{jsCode:byName(w,'Montar boas-vindas').parameters.jsCode.replace("$('Checar MX')","$('CRM Origem v2 · Checar MX')")});assert.deepEqual(byName(p,P.V2.welcome).credentials,byName(w,'Montar boas-vindas').credentials);
 assert.deepEqual(next(p,P.V2.upsert),[P.V2.post,P.V2.welcome]);assert.deepEqual(next(p,P.V2.format,1),[P.V2.reject]);assert.deepEqual(next(p,P.V2.receives,1),[P.V2.reject]);
 assert.match(byName(p,P.V2.post).parameters.responseBody,/registration_unconfirmed/);assert.doesNotMatch(byName(p,P.V2.post).parameters.responseBody,/\$json\.reason/);assert.equal(P.producerRevisionForPatched(p,t.producerRevision),t.producerRevision);
});

test('legacy requests without event stay on v1 while v2 requires event, receipt ACK and GET on the fixed suffix',()=>{
 const w=fixture(),t=target(w),p=P.transformPinnedWorkflow(w,t,guard(w));
 const legacyPath=['Webhook VIP','Validar e Corrigir','Formato OK?','DNS MX','Checar MX','Recebe email?',t.upsert,'Montar boas-vindas','Boas-vindas VIP (Listmonk tx)'];for(let i=0;i<legacyPath.length-1;i++)assert.deepEqual(next(p,legacyPath[i]),[legacyPath[i+1]]);
 assert.doesNotMatch(byName(p,'Validar e Corrigir').parameters.jsCode,/event_id/);assert.match(byName(p,P.V2.validate).parameters.jsCode,/invalid_event/);assert.match(byName(p,P.V2.upsert).parameters.options.queryReplacement,/event_id/);
 assert.equal(byName(p,P.V2.get).parameters.httpMethod,'GET');assert.equal(byName(p,P.V2.get).parameters.path,t.path);assert.match(byName(p,P.V2.getSql).parameters.query,/recorded_origin_operation_v2/);assert.equal(t.path.endsWith('-recorded-v2'),true);
});

test('version, graph/node drift, legacy topology drift and malformed anchors fail before mutation',()=>{
 for(const mutate of [w=>w.versionId='foreign',w=>w.active=false,w=>w.nodes[0].parameters.path='other',w=>w.nodes.find(n=>n.name==='Validar e Corrigir').parameters.jsCode='return [];',w=>w.nodes.find(n=>n.type==='n8n-nodes-base.postgres').parameters.query='SELECT 1',w=>w.connections['DNS MX'].main[0][0].node='Montar boas-vindas']){const w=fixture(),t=target(w),g=guard(w);mutate(w);assert.throws(()=>P.transformPinnedWorkflow(w,t,g),/VIP_RECORDED_ORIGIN_PATCH_/);}
 const w=fixture(),t=target(w),g=guard(w);g.nodeHashes['Webhook VIP']='0'.repeat(64);assert.throws(()=>P.transformPinnedWorkflow(w,t,g),/NODE_HASH/);
});
