/* Recuperação segura de tentativas pendentes · PostgreSQL NATIVO com sessões concorrentes.
   Isolado: exige CRM_PENDING_RECOVERY_TEST_ISOLATED=1 e TEST_DATABASE_URL
   postgresql://postgres@127.0.0.1:<porta≠5432>/listmonk (cluster descartável, sem senha).
   Medido aqui em PostgreSQL 16.15 e 17.10 (tools/claude-native-proofs/run-pg17.sh); aceita 16 e 17.
   Sem rede, sem Listmonk, sem envio: o nativo não é chamado em nenhum cenário. */
'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),{createHash}=require('node:crypto');
const {Client,Pool}=require('pg');
if(process.env.CRM_PENDING_RECOVERY_TEST_ISOLATED!=='1'||!process.env.TEST_DATABASE_URL)throw Error('isolated PostgreSQL required');
const parsed=new URL(process.env.TEST_DATABASE_URL);
// Versão alvo explícita opcional: CRM_PG_EXPECTED_VERSION_NUM=160015|170010 exige exatamente
// a versão informada; sem a variável, aceita 16 ou 17 como antes.
const assertPgVersion=v=>{assert.ok(/^1[67]\d{4}$/.test(v),'PostgreSQL 16 ou 17');const e=process.env.CRM_PG_EXPECTED_VERSION_NUM;if(e){assert.ok(['160015','170010'].includes(e),'CRM_PG_EXPECTED_VERSION_NUM não suportado: '+e);assert.equal(String(v),e);}};
if(parsed.protocol!=='postgresql:'||parsed.hostname!=='127.0.0.1'||parsed.port===''||parsed.port==='5432'||parsed.pathname!=='/listmonk'||parsed.username!=='postgres'||parsed.password)throw Error('isolated PostgreSQL URL required');
const {createServer,PATH}=require('../services/crm-campaign/server.cjs');
const {createAbandonExecutor}=require('../services/crm-campaign/abandon.cjs');
const {createService,hash:requestHash}=require('../n8n/growth/campaign-service'),{createStore}=require('../n8n/growth/campaign-store'),{createProvider}=require('../n8n/growth/campaign-provider');
const ROOT=path.join(__dirname,'..'),read=f=>fs.readFileSync(path.join(ROOT,f),'utf8'),sha=s=>createHash('sha256').update(s).digest('hex');
const ownerUrl=parsed.href,apiParsed=new URL(parsed);apiParsed.username='crm_campaign_api';apiParsed.password='synthetic-password';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const atomic=sql=>`DO $campaign_gateway$ BEGIN EXECUTE $gateway_ddl$${sql}$gateway_ddl$; END $campaign_gateway$;`;
let owner,a,b,pool,actor,otherActor,version,id=900;const reviewIds=new Map();
const connect=async()=>{const c=new Client({connectionString:ownerUrl});await c.connect();return c;};
const one=async(c,sql,params)=>(await c.query(sql,params)).rows[0];
const store=(c,action,p)=>one(c,'SELECT shrigma_campaign_store($1::text,$2::jsonb) AS r',[action,JSON.stringify(p)]).then(x=>x.r);
const provider=(c,action,p)=>one(c,'SELECT shrigma_campaign_provider($1::text,$2::jsonb) AS r',[action,JSON.stringify(action==='schedule'?{audienceReviewId:reviewIds.get(p.id),...p}:p)]).then(x=>x.r);
const abandon=(c,p)=>one(c,'SELECT shrigma_campaign_abandon($1::jsonb) AS r',[JSON.stringify({actor,brand:'fish',...p})]).then(x=>x.r);
const rows=key=>owner.query('SELECT * FROM shrigma_campaign_operation WHERE operation_key=$1',[key]).then(r=>r.rows);
const expire=key=>owner.query("UPDATE shrigma_campaign_operation SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_key=$1",[key]);
// O pid é lido antes: um Client ocupado enfileira consultas e não responderia aqui.
const pids=new Map(),remember=async c=>pids.set(c,(await one(c,'SELECT pg_backend_pid() AS p')).p);
async function waitingOnLock(c){const p=pids.get(c);for(let i=0;i<100;i++){const r=await one(owner,'SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[p]);if(r?.wait_event_type==='Lock')return true;await sleep(20);}return false;}
async function fixture(status){
 const cid=id++;
 await owner.query(`INSERT INTO campaigns(id,name,subject,from_email,body,altbody,content_type,headers,status,tags,type,messenger,template_id,sent,attribs,send_at)
  SELECT $1,name,subject,from_email,body,altbody,content_type,headers,'draft',tags,type,messenger,template_id,0,attribs,NULL FROM campaigns WHERE id=100`,[cid]);
 await owner.query("INSERT INTO campaign_lists(campaign_id,list_id,list_name) VALUES($1,3,'Fish')",[cid]);
 // Recibo atômico compara send_at em milissegundos; o PG nativo tem microssegundos (PGlite não).
 await owner.query("UPDATE campaigns SET status=$2,send_at=date_trunc('milliseconds',clock_timestamp()+interval '1 day') WHERE id=$1",[cid,status]);
 if(status==='draft')reviewIds.set(cid,(await one(owner,'SELECT fixture_audience_review($1) AS v',[cid])).v.audience.review_id);
 return provider(owner,'get',{id:cid});
}
const command=(action,c,key)=>({acao:'campanha_'+action,brand:'fish',id:c.id,expected_version:c.version,confirm:action,...(action==='agendar'?{audience_review_id:reviewIds.get(c.id)}:{}),idempotency_key:key});
const claim=(c,req)=>store(c,'claim',{actor,key:req.idempotency_key,hash:requestHash(req),brand:req.brand,action:req.acao.replace('campanha_','')});

test.before(async()=>{
 owner=await connect();
 version=(await one(owner,'SHOW server_version_num')).server_version_num;
 assertPgVersion(version);
 await owner.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE TABLE crm_dash_chave(chave text PRIMARY KEY,painel text NOT NULL,dono text,ativo boolean DEFAULT true,revogada_em timestamptz,ultimo_uso timestamptz,usos integer DEFAULT 0); CREATE TABLE shrigma_template_key_v2(key_hash text,active boolean,actor text,capabilities jsonb);`);
 for(const f of ['n8n/access/panel-auth.sql','n8n/access/panel-operator.sql','n8n/access/panel-short-keys.sql','tests/campaign-provider-schema.sql','n8n/growth/campaign-store.sql','n8n/growth/campaign-recovery.sql','n8n/growth/campaign-template-ownership.sql','n8n/growth/campaign-provider.sql'])await owner.query(read(f));
 await owner.query("UPDATE campaigns SET body='<p>Fixture</p>{{ UnsubscribeURL }}',altbody='Fixture {{ UnsubscribeURL }}'; INSERT INTO crm_familia_campanha(marca,utm_campaign,familia) VALUES('fish','week','week')");
 for(const [kid,dono,key,caps] of [['synthetic-manager-id','Manager','synthetic-manager-key',['read_content','draft','validate','submit']],['synthetic-other-id','Other','synthetic-other-key',['read_content','draft','validate','submit']],['synthetic-reader-id','Reader','synthetic-reader-key',['read_content']]]){
  await owner.query("INSERT INTO crm_dash_chave(chave,painel,dono,chave_hash,chave_hash_curta) VALUES($1,'growth',$2,$3,$4)",[kid,dono,sha(key),sha(key+'-short')]);
  await owner.query("INSERT INTO shrigma_panel_permission_v1 VALUES($1,'growth',$2::jsonb)",[kid,JSON.stringify(caps)]);
 }
 await owner.query(atomic(read('n8n/growth/crm-campaign-gateway-role.sql')));
 await owner.query("ALTER ROLE crm_campaign_api LOGIN PASSWORD 'synthetic-password'");
 actor=(await one(owner,"SELECT shrigma_crm_campaign_auth_v1('synthetic-manager-key') AS a")).a.actor;
 otherActor=(await one(owner,"SELECT shrigma_crm_campaign_auth_v1('synthetic-other-key') AS a")).a.actor;
 assert.notEqual(actor,otherActor);
 a=await connect();b=await connect();await remember(a);await remember(b);
 // Sessão A já usou as funções (plano/rowtype em cache) ANTES da migração adicionar colunas.
 const warm=await claim(a,{acao:'campanha_agendar',brand:'fish',idempotency_key:'warm-before-install-01'});assert.equal(warm.acquired,true);
 const md5=async()=>(await owner.query("SELECT proname,md5(prosrc) m FROM pg_proc WHERE proname IN ('shrigma_campaign_store','shrigma_campaign_provider','shrigma_campaign_recovery','shrigma_crm_campaign_effect_v1') ORDER BY proname")).rows;
 const before=await md5();
 for(let i=0;i<2;i++){await owner.query(read('n8n/growth/campaign-pending-recovery.sql'));await owner.query(read('n8n/growth/crm-campaign-abandon-gateway.sql'));}
 assert.deepEqual(await md5(),before,'store/provider/recovery/gateway intactos');
 assert.equal((await one(owner,'SELECT enabled FROM shrigma_campaign_pending_recovery_config')).enabled,false);
 // Desligado: sessão aquecida continua funcionando e sem lease.
 const off=await claim(a,{acao:'campanha_agendar',brand:'fish',idempotency_key:'warm-after-install-001'});assert.equal(off.acquired,true);
 assert.equal((await rows('warm-after-install-001'))[0].lease_expires_at,null);
 await assert.rejects(abandon(a,{key:'warm-after-install-001',action:'agendar'}),/ABANDON_DISABLED/);
 await owner.query('UPDATE shrigma_campaign_pending_recovery_config SET enabled=true');
 pool=new Pool({connectionString:apiParsed.href,max:4,statement_timeout:12000,query_timeout:12500});
});
test.afterEach(async()=>{for(const c of [a,b])await c?.query('ROLLBACK').catch(()=>{});});
test.after(async()=>{for(const c of [a,b,owner])await c?.end().catch(()=>{});await pool?.end().catch(()=>{});console.log(JSON.stringify({postgres:version,ci_postgres:'170010',sessions:2,native_calls:0,sends:0}));});

test('corrida lápide × POST atrasado (chave sem registro): o claim espera o lock e recebe conflito, zero efeito',async()=>{
 const c=await fixture('draft'),req=command('agendar',c,'race-missing-key-0001');
 await b.query('BEGIN');const t=await abandon(b,{key:req.idempotency_key,action:'agendar'});assert.equal(t.created,true);
 const late=claim(a,req);assert.equal(await waitingOnLock(a),true,'claim atrasado bloqueado pelo advisory lock da lápide');
 await b.query('COMMIT');const got=await late;
 assert.equal(got.acquired,false);assert.equal(got.state,'rejected');assert.notEqual(got.hash,requestHash(req),'hash sentinela: service devolve IDEMPOTENCY_CONFLICT');
 let writes=0;const service=createService({store:createStore({query:(q,p)=>a.query(q,p)}),provider:createProvider({query:async(q,p)=>{if(['schedule','cancel'].includes(p?.[0]))writes++;return a.query(q,p);},nativeCreate:async()=>{throw Error('native');},validateContent:async()=>{throw Error('native');}})});
 const r=await service.handle({actor,caps:['read_content','submit']},req);assert.equal(r.status,409);assert.equal(r.body.error,'IDEMPOTENCY_CONFLICT');assert.equal(writes,0);
 assert.deepEqual(await provider(owner,'get',{id:c.id}),c);assert.equal((await rows(req.idempotency_key)).length,1);
});

test('corrida lápide × efeito tardio (pending com lease vencido): o provider espera o FOR UPDATE e é recusado',async()=>{
 for(const [action,status,eff] of [['agendar','draft','schedule'],['cancelar','scheduled','cancel']]){
  const c=await fixture(status),req=command(action,c,`race-late-${action}-key01`),op=await claim(a,req);await expire(req.idempotency_key);
  await b.query('BEGIN');assert.equal((await abandon(b,{key:req.idempotency_key,action})).abandoned,true);
  const late=provider(a,eff,{id:c.id,expectedVersion:c.version,operationId:op.id}).then(()=>'applied',e=>e.message);
  assert.equal(await waitingOnLock(a),true,'efeito tardio bloqueado pela lápide em andamento');
  await b.query('COMMIT');assert.equal(await late,'CAMPAIGN_OPERATION_INVALID');
  assert.deepEqual(await provider(owner,'get',{id:c.id}),c,'campanha intacta');
  await assert.rejects(store(a,'finish',{id:op.id,lease:op.lease,state:'succeeded',providerId:c.id,response:{status:200,body:{}}}),/CAMPAIGN_STORE_FINALIZED/);
 }
});

test('efeito em andamento segura o lock: a lápide espera e vê succeeded, mesmo com o lease vencendo durante a espera',async()=>{
 const c=await fixture('draft'),req=command('agendar',c,'inflight-wins-key-001'),op=await claim(a,req);
 await owner.query("UPDATE shrigma_campaign_operation SET lease_expires_at=clock_timestamp()+interval '1 second' WHERE id=$1",[op.id]);
 await a.query('BEGIN');const done=await provider(a,'schedule',{id:c.id,expectedVersion:c.version,operationId:op.id});assert.equal(done.status,'scheduled');
 const pending=abandon(b,{key:req.idempotency_key,action:'agendar'});assert.equal(await waitingOnLock(b),true,'lápide bloqueada pelo efeito');
 await sleep(1300);// o lease vence enquanto o efeito ainda segura a linha
 await a.query('COMMIT');const r=await pending;
 assert.equal(r.abandoned,false);assert.equal(r.operation.state,'succeeded');assert.equal((await provider(owner,'get',{id:c.id})).status,'scheduled');
});

test('lease ainda válido recusa; duplo encerramento concorrente grava um único registro',async()=>{
 const c=await fixture('draft'),req=command('agendar',c,'lease-active-key-0001');await claim(a,req);
 await assert.rejects(abandon(b,{key:req.idempotency_key,action:'agendar'}),/ABANDON_LEASE_ACTIVE/);assert.equal((await rows(req.idempotency_key))[0].state,'pending');
 for(const key of ['double-missing-key-001',req.idempotency_key]){
  if(key===req.idempotency_key)await expire(key);
  await a.query('BEGIN');const first=await abandon(a,{key,action:'agendar'});
  const second=abandon(b,{key,action:'agendar'});assert.equal(await waitingOnLock(b),true);
  await a.query('COMMIT');const s=await second;
  assert.equal(first.abandoned,true);assert.equal(s.abandoned,true);assert.equal(s.created,false);assert.equal(s.operation.id,first.operation.id);
  assert.equal((await rows(key)).length,1);
 }
});

test('rota HTTP com login restrito: marca/ator/capability errados recusam; CREATE recusa por TTL; gate desligado mantém o contrato',async t=>{
 const app=createServer({revision:'b'.repeat(40),enabled:true,abandonEnabled:true,abandonExecutor:createAbandonExecutor({pool}),executor:async()=>{throw Error('runtime não deve ser chamado');}});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>app.stop());
 const post=body=>new Promise((resolve,reject)=>{const bytes=Buffer.from(JSON.stringify(body));const q=http.request({host:'127.0.0.1',port:app.server.address().port,path:PATH,method:'POST',headers:{'Content-Type':'application/json','Content-Length':bytes.length}},res=>{const ch=[];res.on('data',x=>ch.push(x));res.on('end',()=>{try{resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(ch))});}catch(e){reject(e);}});});q.on('error',reject);q.end(bytes);});
 const body=(key,patch={})=>({k:'synthetic-manager-key',acao:'campanha_operacao_abandonar',brand:'fish',idempotency_key:key,operation_action:'agendar',confirm:'abandonar',...patch});
 const ok=await post(body('http-missing-key-0001'));assert.equal(ok.status,200);assert.equal(ok.body.abandoned,true);assert.equal(ok.body.created,true);assert.equal((await rows('http-missing-key-0001'))[0].actor,actor);
 assert.deepEqual((await post(body('http-missing-key-0001'))).body.operation.id,ok.body.operation.id,'repetir é idempotente');
 const c=await fixture('draft'),req=command('agendar',c,'http-identity-key-001');await claim(a,req);await expire(req.idempotency_key);const snap=await rows(req.idempotency_key);
 for(const [patch,status,error] of [[{brand:'aristo'},409,'ABANDON_IDENTITY_MISMATCH'],[{operation_action:'cancelar'},409,'ABANDON_IDENTITY_MISMATCH'],[{k:'synthetic-other-key'},409,'ABANDON_IDENTITY_MISMATCH'],[{k:'synthetic-reader-key'},403,'CAPABILITY_MISSING'],[{k:'unknown-key'},401,'UNAUTHORIZED']]){
  const r=await post(body(req.idempotency_key,patch));assert.equal(r.status,status,JSON.stringify(patch));assert.equal(r.body.error,error);
 }
 assert.deepEqual(await rows(req.idempotency_key),snap,'recusas não gravam nada');
 const create=await claim(a,{acao:'campanha_salvar',brand:'fish',definition:{},idempotency_key:'http-create-key-00001'});
 await owner.query("UPDATE shrigma_campaign_operation SET lease_expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1",[create.id]);
 assert.equal((await post(body('http-create-key-00001'))).body.error,'ABANDON_ACTION_UNSUPPORTED');
 assert.equal((await post(body('http-create-key-00001',{operation_action:'salvar'}))).status,422);
 assert.equal((await rows('http-create-key-00001'))[0].state,'pending','CREATE continua em conciliação própria');
 const good=await post(body(req.idempotency_key));assert.equal(good.status,200);assert.equal(good.body.abandoned,true);
 // Login restrito não alcança a função interna nem a tabela.
 const api=new Client({connectionString:apiParsed.href});await api.connect();t.after(()=>api.end());
 await assert.rejects(api.query("SELECT shrigma_campaign_abandon('{}'::jsonb)"),/permission denied/);
 await assert.rejects(api.query('SELECT * FROM shrigma_campaign_operation'),/permission denied/);
 await assert.rejects(api.query('SELECT * FROM shrigma_campaign_pending_recovery_config'),/permission denied/);
 // Gate do serviço desligado: mesma resposta de antes (campo desconhecido), nada executado.
 const offApp=createServer({revision:'b'.repeat(40),enabled:true,abandonExecutor:createAbandonExecutor({pool}),executor:async()=>{throw Error('runtime não deve ser chamado');}});
 await new Promise(r=>offApp.server.listen(0,'127.0.0.1',r));t.after(()=>offApp.stop());
 const offRes=await new Promise((resolve,reject)=>{const bytes=Buffer.from(JSON.stringify(body('http-off-key-00000001')));const q=http.request({host:'127.0.0.1',port:offApp.server.address().port,path:PATH,method:'POST',headers:{'Content-Type':'application/json','Content-Length':bytes.length}},res=>{const ch=[];res.on('data',x=>ch.push(x));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(ch))}));});q.on('error',reject);q.end(bytes);});
 assert.equal(offRes.status,422);assert.equal(offRes.body.error,'REQUEST_FIELD_INVALID');assert.equal((await rows('http-off-key-00000001')).length,0);
});
