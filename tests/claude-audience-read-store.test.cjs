'use strict';
// Leitura isolada de públicos (agente K). PGlite: um banco por teste.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const X=require('./claude-audience-read-fixture.cjs'),R=require('../services/crm-audience/read-store.cjs');
const S=require('../n8n/growth/segment-audience-store.cjs'),GCAC=require('../growth-campaign-audience-client.js');
const Bridge=require('../services/dashboard-operational/crm-audience-read-bridge.cjs');
const {createReadServer}=require('../services/crm-audience/read-server.cjs'),{start}=require('../services/crm-audience/read-main.cjs');
const AUTH='Bearer '+X.KEY;
async function fixture(t,options){const db=new PGlite();t.after(()=>db.close());const f=await X.install(db);const pool=X.pglitePool(db,options),transaction=R.createReadTransaction({pool}),store=R.createAudienceReadStore({transaction});
 const read=(query,authorization=AUTH)=>store.handle({authorization,query});return {db,f,pool,transaction,store,read};}
// O contrato aceito pelo BFF é conferido sobre a resposta real do serviço.
function bridgeAccepts(route,query,body){const d=Bridge.decision(route,'GET',new URLSearchParams(query));Bridge.responseShape(d,JSON.parse(JSON.stringify(body)));return true;}
const WRITES=/refresh_native_catalog|FOR (SHARE|UPDATE)|^\s*(INSERT|UPDATE|DELETE)|touch_campaign|lock_campaign_dependencies|campaign_snapshot|config_snapshot\(\$1::text\)$/i;
function noWriteStatements(log){for(const text of log)assert.ok(!WRITES.test(text.replace('crm_audience_read.config_snapshot','RO'))||/^SET LOCAL ROLE/.test(text),text);}

test('campanha só-lista nas duas marcas, sem público salvo: vínculo nulo confirmado, listas nomeadas e zero efeitos',async t=>{
 const {db,pool,read}=await fixture(t);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM crm_audience_v2.audience')).rows[0].n,0);
 const before=await X.snapshot(db);
 for(const [brand,ids]of [['fish',[100,300]],['aristo',[200]]]){
  const lists=await read({acao:'publicos_listas',brand});assert.equal(lists.status,200);assert.ok(lists.body.lists.length>0);assert.ok(lists.body.lists.every(l=>l.brand===brand));
  assert.equal(lists.body.freshness.schedule_proof,false);assert.equal(lists.body.freshness.current,true);assert.ok(bridgeAccepts('segments',{acao:'publicos_listas',brand},lists.body));
  const segs=await read({acao:'segmentos_listar',brand,limit:'50',offset:'0'});assert.equal(segs.status,200);assert.deepEqual(segs.body.segments,[]);assert.deepEqual(segs.body.capabilities,{draft:false,count:false,send:false});
  assert.ok(bridgeAccepts('segments',{acao:'segmentos_listar',brand,offset:'0',limit:'50'},segs.body));
  for(const id of ids){
   const ctx=await read({acao:'campanha_publico_contexto',brand,campaign_id:String(id)});assert.equal(ctx.status,200,JSON.stringify(ctx));
   assert.equal(ctx.body.binding,null);assert.equal(ctx.body.binding_state,'none');assert.equal(ctx.body.list_only,true);assert.equal(ctx.body.schedule_proof,false);assert.equal(ctx.body.execution_blocked,true);
   assert.ok(ctx.body.list_ids.length===1&&ctx.body.lists[0].in_brand&&typeof ctx.body.lists[0].name==='string');assert.ok(bridgeAccepts('campaign_audience',{acao:'campanha_publico_contexto',brand,campaign_id:String(id)},ctx.body));
   const b=await read({acao:'campanha_publico_obter',brand,campaign_id:String(id)});assert.equal(b.status,200);assert.equal(b.body.binding,null);
   assert.equal(GCAC.validation.readBody(b.body,brand,id),true,'o cliente do painel aceita o corpo sem público salvo');assert.ok(bridgeAccepts('campaign_audience',{acao:'campanha_publico_obter',brand,campaign_id:String(id)},b.body));
  }
 }
 // Negação cruzada de marca e campanha fora do escopo CRM (olivas).
 for(const [brand,id]of [['aristo',100],['fish',200],['aristo',300],['fish',400],['aristo',400],['fish',999]])for(const acao of ['campanha_publico_obter','campanha_publico_contexto'])
  assert.deepEqual(await read({acao,brand,campaign_id:String(id)}),{status:404,body:{error:'SEGMENT_BINDING_CAMPAIGN_NOT_FOUND'}});
 for(const q of [{acao:'publicos_listas',brand:'olivas'},{acao:'segmento_criar',brand:'fish'},{acao:'segmento_operacao',brand:'fish',idempotency_key:'x'.repeat(10)},{acao:'campanha_publico_validar',brand:'fish',campaign_id:'100'},{acao:'publicos_listas',brand:'fish',actor:'panel:x'},{acao:'segmentos_listar',brand:'fish',limit:'101'}])assert.equal((await read(q)).status,400,JSON.stringify(q));
 assert.deepEqual(await X.snapshot(db),before,'nenhuma linha, xmin ou xmax mudou');
 noWriteStatements(pool.log);assert.equal(pool.log.filter(x=>x==='ROLLBACK').length>0,true);assert.equal(pool.log.includes('COMMIT'),false);
 // HTTP ligado sobre o mesmo banco: só GET sem Origin, uma autorização.
 const app=createReadServer({handler:R.createAudienceReadStore({transaction:R.createReadTransaction({pool})}),revision:'1'.repeat(40),enabled:true});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>app.stop());const base='http://127.0.0.1:'+app.server.address().port;
 let r=await fetch(base+'/audience-read?acao=campanha_publico_contexto&brand=aristo&campaign_id=200',{headers:{Authorization:AUTH}});assert.equal(r.status,200);assert.equal((await r.json()).list_only,true);
 assert.equal((await fetch(base+'/audience-read?acao=publicos_listas&brand=fish',{method:'POST',headers:{Authorization:AUTH}})).status,405);
 assert.equal((await fetch(base+'/audience-read?acao=publicos_listas&brand=fish',{headers:{Authorization:AUTH,Origin:'https://bandssz.github.io'}})).status,403);
 assert.equal((await fetch(base+'/audience-read?acao=publicos_listas&brand=fish&brand=aristo',{headers:{Authorization:AUTH}})).status,400);
 assert.equal((await fetch(base+'/segments?acao=segmentos_listar&brand=fish',{headers:{Authorization:AUTH}})).status,404,'rotas legadas não existem neste listener');
 assert.deepEqual(await X.snapshot(db),before);
});

test('públicos salvos e vínculo nas duas marcas; catálogo velho é informado e nunca vira prova; legado bloqueia linhas',async t=>{
 const {db,f,pool,read}=await fixture(t);
 const fishAudience=await f.createAudience('fish','lido-fish'),aristoAudience=await f.createAudience('aristo','lido-aristo');
 const intent=(await f.inspect('fish',100,fishAudience)).body.intent,bound=await f.bind(intent,'bind-read-fish');assert.equal(bound.status,201);
 let before=await X.snapshot(db);
 for(const [brand,a,other]of [['fish',fishAudience,aristoAudience],['aristo',aristoAudience,fishAudience]]){
  const list=await read({acao:'segmentos_listar',brand,limit:'10',offset:'0'});assert.equal(list.status,200);assert.deepEqual(list.body.segments.map(s=>s.id),[a.id]);assert.equal(list.body.segments[0].semantic_context.current,true);
  const one=await read({acao:'segmento_obter',brand,id:a.id.toUpperCase()});assert.equal(one.status,200);assert.equal(one.body.segment.id,a.id);assert.ok(bridgeAccepts('segments',{acao:'segmento_obter',brand,id:a.id},one.body));
  assert.deepEqual(await read({acao:'segmento_obter',brand,id:other.id}),{status:404,body:{error:'SEGMENT_NOT_FOUND'}},'público da outra marca não vaza');
 }
 const b=await read({acao:'campanha_publico_obter',brand:'fish',campaign_id:'100'});assert.equal(b.status,200);assert.equal(b.body.binding.audience_id,fishAudience.id);assert.equal(GCAC.validation.readBody(b.body,'fish',100),true);
 const ctx=await read({acao:'campanha_publico_contexto',brand:'fish',campaign_id:'100'});assert.equal(ctx.body.binding_state,'bound');assert.equal(ctx.body.list_only,false);assert.deepEqual(ctx.body.binding,b.body.binding);assert.ok(bridgeAccepts('campaign_audience',{acao:'campanha_publico_contexto',brand:'fish',campaign_id:'100'},ctx.body));
 assert.equal((await read({acao:'campanha_publico_contexto',brand:'aristo',campaign_id:'200'})).body.list_only,true,'aristo continua só-lista mesmo com público salvo');
 assert.deepEqual(await X.snapshot(db),before);

 // Catálogo vencido: a leitura informa idade e não é prova; nada é renovado.
 await db.query("UPDATE crm_audience_v2.config SET checked_at=clock_timestamp()-interval '10 minutes',expires_at=clock_timestamp()-interval '6 minutes'");
 before=await X.snapshot(db);const config=(await db.query('SELECT brand,checked_at,expires_at,revision FROM crm_audience_v2.config ORDER BY brand')).rows;
 for(const brand of ['fish','aristo']){
  const l=await read({acao:'segmentos_listar',brand,limit:'10',offset:'0'}),fr=l.body.freshness;
  assert.equal(fr.stale,true);assert.equal(fr.current,false);assert.equal(fr.schedule_proof,false);assert.ok(fr.catalog_age_seconds>=599);assert.equal(l.body.catalog.current,false);assert.ok(l.body.segments.every(s=>s.semantic_context.current===false));
  assert.ok(bridgeAccepts('segments',{acao:'segmentos_listar',brand,offset:'0',limit:'10'},l.body));
  const lists=await read({acao:'publicos_listas',brand});assert.equal(lists.body.freshness.stale,true);
 }
 const stale=await read({acao:'campanha_publico_contexto',brand:'fish',campaign_id:'100'});assert.equal(stale.body.freshness.stale,true);assert.equal(stale.body.binding.semantic_context.current,false);assert.equal(stale.body.schedule_proof,false);
 assert.ok(bridgeAccepts('campaign_audience',{acao:'campanha_publico_contexto',brand:'fish',campaign_id:'100'},stale.body));
 // Um corpo que alegue catálogo velho como atual é recusado pelo BFF.
 assert.throws(()=>bridgeAccepts('campaign_audience',{acao:'campanha_publico_contexto',brand:'fish',campaign_id:'100'},{...stale.body,binding:{...stale.body.binding,semantic_context:{...stale.body.binding.semantic_context,current:true}}}),{code:'AUDIENCE_READ_RESPONSE_DENIED'});
 assert.throws(()=>bridgeAccepts('campaign_audience',{acao:'campanha_publico_contexto',brand:'fish',campaign_id:'100'},{...stale.body,schedule_proof:true}),{code:'AUDIENCE_READ_RESPONSE_DENIED'});
 assert.deepEqual((await db.query('SELECT brand,checked_at,expires_at,revision FROM crm_audience_v2.config ORDER BY brand')).rows,config,'catálogo não foi renovado');
 assert.deepEqual(await X.snapshot(db),before);noWriteStatements(pool.log);

 // Liberação: vínculo liberado volta a ser só-lista na leitura.
 await db.query("UPDATE crm_audience_v2.config SET checked_at=clock_timestamp()-interval '1 second',expires_at=clock_timestamp()+interval '4 minutes'");
 const released=await f.release('fish',100,bound.body.binding,'release-read-fish');assert.equal(released.status,200,JSON.stringify(released));
 const after=await read({acao:'campanha_publico_contexto',brand:'fish',campaign_id:'100'});assert.equal(after.body.binding_state,'released');assert.equal(after.body.binding,null);assert.equal(after.body.list_only,true);

 // Contraste: o GET legado bloqueia linhas (FOR SHARE) e por isso não é leitura pura.
 before=await X.snapshot(db);assert.equal((await f.call({acao:'segmentos_listar',brand:'fish',limit:50,offset:0})).status,200);
 assert.notDeepEqual(await X.snapshot(db),before,'o GET legado altera xmax (bloqueio de linha)');
});

test('papel de leitura sem escrita; READ ONLY recusa o catálogo legado; allowlist, papel e xid conferidos',async t=>{
 const {db}=await fixture(t);
 for(const sql of ["INSERT INTO crm_audience_v2.request(actor,operation_key,brand,payload,payload_hash,response) VALUES('panel:x','abcdefgh','fish','{}','"+'a'.repeat(64)+"','{}')",
  "UPDATE crm_audience_v2.config SET revision=revision+1","DELETE FROM crm_audience_v2.campaign_binding","SELECT * FROM crm_audience_v2.config_snapshot('fish')","SELECT * FROM crm_audience_v2.catalog_lists('fish')",
  'SELECT * FROM crm_audience_v2.campaign_snapshot(100,false)','SELECT crm_audience_v2.touch_campaign(100)',"SELECT public.shrigma_campaign_provider('list','{\"brand\":\"fish\"}')",'SELECT * FROM crm_audience_v2.request','SELECT * FROM crm_dash_chave'])
  await assert.rejects(db.transaction(async tx=>{await tx.query('SET LOCAL ROLE crm_audience_reader');await tx.query(sql);}),e=>e.code==='42501',sql);
 // Mesmo como owner, uma transação READ ONLY recusa o catálogo legado (FOR SHARE).
 await assert.rejects(db.transaction(async tx=>{await tx.query('SET TRANSACTION READ ONLY');await S.readCatalog((q,v)=>tx.query(q,v),'fish');}),e=>e.code==='25006'&&/FOR SHARE/.test(e.message));
 // E nenhuma escrita passa pelo papel numa transação READ ONLY.
 await assert.rejects(db.transaction(async tx=>{await tx.query('SET TRANSACTION READ ONLY');await tx.query('SET LOCAL ROLE crm_audience_reader');await tx.query('SELECT crm_audience_read.campaign_current(100)');await tx.query("UPDATE crm_audience_v2.config SET revision=revision");}),e=>['25006','42501'].includes(e.code));
 assert.equal((await db.query("SELECT rolcanlogin,rolsuper,rolinherit FROM pg_roles WHERE rolname='crm_audience_reader'")).rows[0].rolcanlogin,false);

 const fake=(rows={})=>{const log=[];return {log,pool:{async connect(){return {async query(q){const text=typeof q==='string'?q:q.text;log.push(text);
  if(text.startsWith('SELECT current_user'))return {rows:[{role:rows.role??'crm_audience_reader',read_only:rows.readOnly??'on'}]};if(text.includes('txid_current_if_assigned'))return {rows:[{xid:rows.xid??null}]};return {rows:[]};},release(){}};}}};};
 let p=fake({xid:'731'});await assert.rejects(R.createReadTransaction({pool:p.pool})(async()=>1),{code:'CRM_AUDIENCE_READ_WRITE_DETECTED'});assert.equal(p.log.at(-1),'ROLLBACK');
 p=fake({role:'crm_audience_api'});await assert.rejects(R.createReadTransaction({pool:p.pool})(async()=>1),{code:'CRM_AUDIENCE_READ_ROLE'});
 p=fake({readOnly:'off'});await assert.rejects(R.createReadTransaction({pool:p.pool})(async()=>1),{code:'CRM_AUDIENCE_READ_ROLE'});
 p=fake();await assert.rejects(R.createReadTransaction({pool:p.pool})(tx=>tx.query("UPDATE crm_audience_v2.config SET enabled=false")),{code:'CRM_AUDIENCE_READ_STATEMENT_DENIED'});
 await assert.rejects(R.createReadTransaction({pool:p.pool})(tx=>tx.query(S.SQL.config,['fish'])),{code:'CRM_AUDIENCE_READ_STATEMENT_DENIED'},'catálogo legado com FOR SHARE fora da allowlist');
 assert.equal(p.log[0],'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');assert.equal(p.log.includes('COMMIT'),false);
 assert.throws(()=>R.createReadTransaction({pool:p.pool,role:'crm_audience_api'}),{code:'CRM_AUDIENCE_READ_TRANSACTION_CONFIG'});
});

test('principal revogado, expirado, sem capacidade ou trocado no meio: recusa sem dado; entrada inválida não abre conexão',async t=>{
 let swap=null;const {db,pool,read}=await fixture(t,{hook:async(text,values)=>{if(swap&&text===S.SQL.auth&&++swap.n===2)return {text,values:[swap.key]};}});
 const before=await X.snapshot(db),connects=pool.stats.connects;
 for(const [authorization,status]of [['Bearer x',401],['Basic '+X.KEY,401],[null,401],[AUTH+' ',401]])assert.equal((await read({acao:'publicos_listas',brand:'fish'},authorization)).status,status);
 assert.equal((await read({acao:'publicos_listas',brand:'fish',extra:'1'})).status,400);assert.equal(pool.stats.connects,connects,'nenhuma conexão para entrada inválida');
 assert.deepEqual(await read({acao:'publicos_listas',brand:'fish'},'Bearer '+'c'.repeat(64)),{status:401,body:{error:'SEGMENT_UNAUTHORIZED'}});
 await db.query('UPDATE crm_dash_chave SET revogada_em=now() WHERE chave=$1',[X.PRINCIPAL]);
 assert.deepEqual(await read({acao:'segmentos_listar',brand:'fish'}),{status:401,body:{error:'SEGMENT_UNAUTHORIZED'}});
 await db.query("UPDATE crm_dash_chave SET revogada_em=NULL,expira_em=now()-interval '1 second' WHERE chave=$1",[X.PRINCIPAL]);
 assert.deepEqual(await read({acao:'campanha_publico_obter',brand:'aristo',campaign_id:'200'}),{status:401,body:{error:'SEGMENT_UNAUTHORIZED'}});
 await db.query("UPDATE crm_dash_chave SET expira_em=now()+interval '14 days' WHERE chave=$1",[X.PRINCIPAL]);
 await db.query("UPDATE shrigma_panel_permission_v1 SET caps='[\"submission\"]' WHERE principal_id=$1",[X.PRINCIPAL]);
 assert.deepEqual(await read({acao:'publicos_listas',brand:'fish'}),{status:403,body:{error:'SEGMENT_ACCESS_DENIED'}});
 await db.query("UPDATE shrigma_panel_permission_v1 SET caps='[\"read_content\",\"list_history\",\"submission\"]' WHERE principal_id=$1",[X.PRINCIPAL]);
 assert.equal((await read({acao:'publicos_listas',brand:'fish'})).status,200);
 // A reautenticação do fim da transação vê outro ator: nenhum dado sai.
 swap={n:0,key:'synthetic-manager-key'};assert.deepEqual(await read({acao:'segmentos_listar',brand:'aristo'}),{status:401,body:{error:'SEGMENT_UNAUTHORIZED'}});swap=null;
 const changed=await X.snapshot(db);for(const k of Object.keys(before))if(!['public.crm_dash_chave','public.shrigma_panel_permission_v1'].includes(k))assert.equal(changed[k],before[k],k);
});

test('flag OFF: 503 sem pool, sem conexão e sem chamar o handler; healthz informa desligado',async t=>{
 class Pool{constructor(){assert.fail('pool não pode ser criado com a leitura desligada');}}
 const app=start({CRM_AUDIENCE_REVISION:'a'.repeat(40)},{Pool,port:0,host:'127.0.0.1'});t.after(()=>app.stop());
 await new Promise(r=>app.app.server.listening?r():app.app.server.once('listening',r));const base='http://127.0.0.1:'+app.app.server.address().port;
 assert.equal(app.pool,null);
 let r=await fetch(base+'/audience-read?acao=publicos_listas&brand=fish',{headers:{Authorization:AUTH}});assert.equal(r.status,503);assert.deepEqual(await r.json(),{error:'CRM_AUDIENCE_READ_DISABLED'});
 r=await fetch(base+'/healthz');assert.deepEqual(await r.json(),{service:'crm-audience-read',revision:'a'.repeat(40),enabled:false,stopping:false});
 const handler={handle(){assert.fail('handler não pode ser chamado desligado');}},off=createReadServer({handler,revision:'b'.repeat(40),enabled:false});
 await new Promise(r=>off.server.listen(0,'127.0.0.1',r));t.after(()=>off.stop());
 assert.equal((await fetch('http://127.0.0.1:'+off.server.address().port+'/audience-read?acao=publicos_listas&brand=fish',{headers:{Authorization:AUTH}})).status,503);
 const {config}=require('../services/crm-audience/read-config.cjs');
 assert.throws(()=>config({CRM_AUDIENCE_REVISION:'a'.repeat(40),CRM_AUDIENCE_READ_ENABLED:'true',CRM_PG_HOST:'db',CRM_PG_USER:'crm_audience_api',CRM_PG_PASSWORD:'x',CRM_PG_DATABASE:'listmonk'}),/CRM_AUDIENCE_READ_CONFIG/,'papel de escrita recusado');
 assert.throws(()=>config({CRM_AUDIENCE_REVISION:'a'.repeat(40),CRM_AUDIENCE_READ_ENABLED:'yes'}),/CRM_AUDIENCE_READ_CONFIG/);
 assert.equal(config({CRM_AUDIENCE_REVISION:'a'.repeat(40),CRM_AUDIENCE_READ_ENABLED:'true',CRM_PG_HOST:'db',CRM_PG_USER:'crm_audience_reader',CRM_PG_PASSWORD:'x',CRM_PG_DATABASE:'listmonk'}).pg.user,'crm_audience_reader');
});
