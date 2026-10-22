'use strict';
// Aceite sintético: cliente do navegador (GCA) -> serviço real -> SQL real em PGlite.
// Sem rede, sem transporte nativo real, sem pessoas reais. Um banco por teste.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
global.CampaignContract=require('../campaign-contract');global.CampaignTracking=require('../n8n/growth/campaign-tracking');
const A=require('../growth-campaign-api'),createLocks=require('./campaign-lock-fixture.cjs');
const {createService}=require('../n8n/growth/campaign-service'),{createStore}=require('../n8n/growth/campaign-store'),{createProvider}=require('../n8n/growth/campaign-provider');
const END='https://campaign.example.test/operations',WRITE='synthetic-write-secret',READ='synthetic-read-secret';
const API={capabilities:{campaigns:{contract_version:A.VERSION,brands:['aristo','fish'],read:true,save:true,validate:true,schedule:true,cancel:true,operation:true,audience_review:'listmonk-6.1-regular-v1'},endpoints:{campaigns:END}}};
const AUTH={[WRITE]:{actor:'claude-e2e-manager',caps:['read_content','draft','validate','submit']},[READ]:{actor:'claude-e2e-reader',caps:['read_content']}};
const definition=(brand='fish')=>{const domain=brand==='fish'?'fishermans.com.br':'oaristocrata.com';return {schema_version:'crm-campaign-v1',brand,channel:'email',initiative:{key:'e2e-'+brand,name:'E2E '+brand},utm_campaign:'e2e-'+brand,name:'Disparo '+brand,subject:'Assunto',from_email:'contato@'+domain,reply_to:'contato@'+domain,list_ids:[brand==='fish'?3:7],template_id:brand==='fish'?1:3,html:`<a href="https://${domain}/products/x">x</a>{{ UnsubscribeURL }}`,text:`https://${domain}/products/x {{ UnsubscribeURL }}`,tags:[],send_at:new Date(Date.now()+86400000).toISOString()};};

async function setup(t){
 const control={before:null,after:null,query:null};
 const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite'),db=new PGlite();t.after(()=>db.close());
 for(const f of ['tests/campaign-provider-schema.sql','n8n/growth/campaign-store.sql','n8n/growth/campaign-template-ownership.sql','n8n/growth/campaign-provider.sql','n8n/growth/campaign-write-guard.sql'])await db.exec(read(f));
 // control.query (R1): simula falha de transporte antes do SQL do provider, sem tocar no banco.
 let next=300;const query=(sql,params)=>control.query?control.query(sql,params,db):db.query(sql,params);
 const provider=createProvider({query,validateContent:async({templateVersion})=>({ok:true,templateVersion}),nativeCreate:async payload=>{
  const id=next++;await db.exec('BEGIN');
  await db.query(`INSERT INTO campaigns(id,name,subject,from_email,body,altbody,content_type,headers,status,tags,type,messenger,template_id,sent,attribs)
   VALUES($1,$2,$3,$4,$5,$6,'html',$7::jsonb,'draft','{}','regular','email',$9,0,$8::jsonb)`,[id,payload.name,payload.subject,payload.from_email,payload.body,payload.altbody,JSON.stringify(payload.headers),JSON.stringify(payload.attribs),payload.template_id]);
  for(const list of payload.lists)await db.query('INSERT INTO campaign_lists(campaign_id,list_id,list_name) SELECT $1,id,name FROM lists WHERE id=$2',[id,list]);
  await db.exec('COMMIT');return {id};
 }});
 const service=createService({store:createStore({query}),provider});
 const calls=[];
 // Mesmo contrato do serviço HTTP: GET usa Bearer, POST usa body.k; id do GET vira número.
 async function fetch(url,init){
  const u=new URL(url);let key,request;
  if(init.method==='GET'){request=Object.fromEntries(u.searchParams);if(request.id!==undefined)request.id=Number(request.id);key=init.headers.Authorization.slice(7);}
  else{const {k,...rest}=JSON.parse(init.body);key=k;request=rest;}
  calls.push({method:init.method,request});
  if(control.before)await control.before(request);
  const r=await service.handle(AUTH[key],request);
  if(control.after)await control.after(request,r);
  return {status:r.status,json:async()=>structuredClone(r.body)};
 }
 const browser=(brand='fish')=>{const data=new Map(),locks=createLocks();let n=0;const options={capabilities:A.caps(API),brand,storage:{getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)},fetch,locks,readKey:()=>READ,writeKey:()=>WRITE,uuid:()=>`claude-e2e-${brand}-${data.size}-${++n}-op`,keyFingerprint:async k=>createHash('sha256').update(k).digest('hex')};return {data,options,open:()=>A.createClient(options)};};
 const row=async id=>(await db.query('SELECT status,sent,started_at FROM campaigns WHERE id=$1',[id])).rows[0];
 const operation=async key=>(await db.query('SELECT state,action,provider_id FROM shrigma_campaign_operation WHERE operation_key=$1',[key])).rows[0];
 const posts=action=>calls.filter(c=>c.method==='POST'&&c.request.acao==='campanha_'+action);
 return {db,service,calls,control,browser,row,operation,posts};
}
async function reviewed(f,brand='fish'){
 const b=f.browser(brand),client=b.open(),d=definition(brand);await client.catalog();
 const saved=await client.save(d);await client.validate(saved.campaign.definition);
 const s=client.snapshot();assert.equal(s.validation.ok,true);assert.ok(s.validation.audience.eligible_count>0);
 return {b,client,d:s.campaign.definition,s};
}

test('agendar uma vez com ACK perdido depois do commit: reabrir após reinício consulta o mesmo recibo, sem repetir POST; cancelar e conferir estado final',async t=>{
 for(const brand of ['fish','aristo']){
  const f=await setup(t);
  if(brand==='aristo')await f.db.exec("INSERT INTO subscribers VALUES(50,'enabled');INSERT INTO subscriber_lists VALUES(50,7,'confirmed')");
  const {b,client,d,s}=await reviewed(f,brand),id=s.campaign.id;
  f.control.after=async req=>{if(req.acao==='campanha_agendar')throw Error('synthetic ACK lost after commit');};
  await assert.rejects(()=>client.schedule(d,'agendar',s.validation.audience.review_id));
  f.control.after=null;assert.equal(client.locked(),true);
  const key=client.snapshot().operation.key;assert.equal((await f.row(id)).status,'scheduled');assert.equal((await f.operation(key)).state,'succeeded');
  // Reinício do navegador: o diário volta travado e não aceita outra tentativa.
  const reopened=b.open();assert.equal(reopened.locked(),true);
  await assert.rejects(()=>reopened.schedule(d,'agendar',s.validation.audience.review_id),{code:'OPERATION_PENDING'});
  await reopened.consult();assert.equal(reopened.locked(),false);
  assert.equal(reopened.snapshot().campaign.status,'scheduled');assert.equal(reopened.snapshot().campaign.sent,0);assert.equal(reopened.snapshot().campaign.definition.brand,brand);
  const lookup=f.calls.filter(c=>c.request.acao==='campanha_operacao');assert.equal(lookup.length,1);assert.equal(lookup[0].method,'GET');assert.equal(lookup[0].request.idempotency_key,key);
  assert.equal(f.posts('agendar').length,1);
  const cancelled=await reopened.cancel('cancelar');assert.equal(cancelled.campaign.status,'cancelled');assert.equal(cancelled.campaign.sent,0);assert.equal(cancelled.campaign.started_at,null);
  assert.deepEqual(await f.row(id),{status:'cancelled',sent:0,started_at:null});
  const final=await b.open().reopen(id);assert.equal(final.campaign.status,'cancelled');assert.equal(final.campaign.definition.brand,brand);
  assert.equal(f.posts('agendar').length,1);assert.equal(f.posts('cancelar').length,1);
 }
});

test('timeout antes do commit não muda a campanha, mantém o diário travado e só consulta por GET',async t=>{
 const f=await setup(t),{b,client,d,s}=await reviewed(f),id=s.campaign.id;
 f.control.before=async req=>{if(req.acao==='campanha_agendar')throw Error('synthetic timeout before reaching the service');};
 await assert.rejects(()=>client.schedule(d,'agendar',s.validation.audience.review_id));f.control.before=null;
 assert.equal(client.locked(),true);assert.equal((await f.row(id)).status,'draft');assert.equal(await f.operation(client.snapshot().operation.key),undefined);
 const again=b.open();await assert.rejects(()=>again.consult(),{code:'OPERATION_NOT_FOUND'});assert.equal(again.locked(),true);
 await assert.rejects(()=>again.schedule(d,'agendar',s.validation.audience.review_id),{code:'OPERATION_PENDING'});
 assert.equal(f.posts('agendar').length,1);assert.equal((await f.row(id)).status,'draft');
});

test('duas abas pedindo agendar ao mesmo tempo produzem uma intenção; cancelamento concorrente de outro navegador é recusado sem efeito e a versão atual é relida por GET',async t=>{
 const f=await setup(t),{b,client,d,s}=await reviewed(f),id=s.campaign.id,tab=A.createClient(b.options);
 const results=await Promise.allSettled([client.schedule(d,'agendar',s.validation.audience.review_id),tab.schedule(d,'agendar',s.validation.audience.review_id)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.code,'OPERATION_PENDING');
 assert.equal(f.posts('agendar').length,1);assert.equal((await f.row(id)).status,'scheduled');
 // Outro navegador (diário próprio) abre a mesma campanha agendada.
 const other=f.browser().open();await other.reopen(id);
 const both=await Promise.allSettled([client.cancel('cancelar'),A.createClient(b.options).cancel('cancelar')]);
 assert.equal(both.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.posts('cancelar').length,1);
 // O outro navegador ainda vê a versão agendada: o servidor grava a recusa (409 com operation_id,
 // sem efeito) e o cliente a resolve na hora, sem novo POST; reabrir mostra a versão atual.
 await assert.rejects(()=>other.cancel('cancelar'),e=>e.code==='VERSION_CONFLICT'&&/Nada foi alterado/.test(e.message));assert.equal(other.locked(),false);assert.equal(f.posts('cancelar').length,2);
 assert.equal(other.snapshot().operation.phase,'rejected');assert.equal(other.snapshot().operation.response.status,409);assert.equal((await f.operation(other.snapshot().operation.key)).state,'rejected');
 await other.reopen(id);assert.equal(other.snapshot().campaign.status,'cancelled');
 assert.equal(f.posts('cancelar').length,2);assert.deepEqual(await f.row(id),{status:'cancelled',sent:0,started_at:null});
});

test('histórico do editor: campanha antiga fora do contrato não derruba a lista; marcas não se misturam',async t=>{
 const f=await setup(t);await f.db.exec("INSERT INTO subscribers VALUES(50,'enabled');INSERT INTO subscriber_lists VALUES(50,7,'confirmed')");
 // 100 (fish) e 200 (aristo) são campanhas CRM do fixture SQL sem {{ UnsubscribeURL }}: fora do contrato atual do editor.
 const fish=await reviewed(f,'fish'),aristo=await reviewed(f,'aristo');
 const fishList=await fish.b.open().list(),aristoList=await aristo.b.open().list();
 assert.deepEqual(fishList.map(c=>c.id),[fish.s.campaign.id]);assert.deepEqual(aristoList.map(c=>c.id),[aristo.s.campaign.id]);
 assert.ok(fishList.every(c=>c.definition.brand==='fish'));assert.ok(aristoList.every(c=>c.definition.brand==='aristo'));
 await assert.rejects(()=>fish.b.open().reopen(aristo.s.campaign.id),{code:'CAMPAIGN_NOT_FOUND'});
 // Uma resposta que traga outra marca continua recusada por inteiro.
 f.control.after=async(req,r)=>{if(req.acao==='campanha_listar')r.body.campaigns.push(structuredClone(aristoList[0]));};
 await assert.rejects(()=>fish.b.open().list(),{code:'CAMPAIGNS_UNCONFIRMED'});
});

test('R1: agendar interrompido antes do SQL fica outcome_unknown; o painel prova ausência (recibo final + mesma versão) e libera por ação explícita, sem repetir POST',async t=>{
 for(const brand of ['fish','aristo']){
  const f=await setup(t);
  if(brand==='aristo')await f.db.exec("INSERT INTO subscribers VALUES(50,'enabled');INSERT INTO subscriber_lists VALUES(50,7,'confirmed')");
  const {b,client,d,s}=await reviewed(f,brand),id=s.campaign.id;
  f.control.query=(sql,params,db)=>{if(params?.[0]==='schedule')throw Error('synthetic connection reset before SQL');return db.query(sql,params);};
  await assert.rejects(()=>client.schedule(d,'agendar',s.validation.audience.review_id));f.control.query=null;
  const key=client.snapshot().operation.key;assert.equal(client.locked(),true);assert.equal((await f.operation(key)).state,'outcome_unknown');assert.equal((await f.row(id)).status,'draft');
  const reopened=b.open();await reopened.consult();assert.equal(reopened.locked(),true);assert.equal(reopened.canReleaseUnapplied(),true);
  const released=await reopened.releaseUnapplied('liberar');assert.equal(reopened.locked(),false);
  assert.equal(released.operation.absence.operation_state,'outcome_unknown');assert.equal(released.campaign.version,s.campaign.version);assert.equal(released.validation,null);
  assert.equal(f.posts('agendar').length,1);assert.equal((await f.operation(key)).state,'outcome_unknown','recibo do servidor preservado');
  // Nova tentativa só depois de nova conferência, com nova chave.
  await assert.rejects(()=>reopened.schedule(d,'agendar',s.validation.audience.review_id));
  await reopened.validate(d);const again=await reopened.schedule(d,'agendar',reopened.snapshot().validation.audience.review_id);
  assert.equal(again.campaign.status,'scheduled');assert.equal(f.posts('agendar').length,2);assert.notEqual(f.posts('agendar')[1].request.idempotency_key,key);
 }
});
