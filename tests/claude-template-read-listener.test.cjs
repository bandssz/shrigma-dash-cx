'use strict';
// Listener somente leitura de templates (services/crm-template-read), contrato
// crm-template-read-v1. PGlite com o SQL proposto n8n/growth/crm-template-read-access.sql
// (não executado em ambiente real). Prova OFF sem pool/segredo, pedido canônico,
// cadeia ponte→listener→SQL nas duas marcas, revogação/expiração, validação de
// resposta, timeout e ausência de efeito. Nada sai de 127.0.0.1.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const X=require('./claude-template-read-fixture.cjs'),{chain,get}=require('./claude-template-read-listener-harness.cjs');
const {config}=require('../services/crm-template-read/config.cjs'),S=require('../services/crm-template-read/store.cjs');
const {createReadServer}=require('../services/crm-template-read/server.cjs'),{start}=require('../services/crm-template-read/main.cjs');
const REV='a'.repeat(40),KEY=X.KEY;
const listen=app=>new Promise(r=>app.server.listen(0,'127.0.0.1',()=>r(app.server.address().port)));
// Pool sobre PGlite: uma sessão por vez; o papel crm_template_reader entra logo após o BEGIN.
function pglitePool(db){
 let chain=Promise.resolve(),connects=0;
 return {connects:()=>connects,async connect(){
  connects++;let release;const turn=new Promise(r=>release=r),prev=chain;chain=chain.then(()=>turn);await prev;
  return {async query(q,v){const text=typeof q==='string'?q:q.text,values=typeof q==='string'?v:q.values;const r=await db.query(text,values||[]);
    if(/^BEGIN /.test(text))await db.query('SET LOCAL ROLE crm_template_reader');return r;},
   release(){release();}};
 }};
}
async function fixture(t){const db=new PGlite();t.after(()=>db.close());await X.install(db);return db;}
async function serve(t,db,opts={}){
 const pool=pglitePool(db),transaction=S.createReadTransaction({pool}),handler=S.createTemplateReadStore({transaction,...opts});
 const app=createReadServer({handler,revision:REV,enabled:true});const port=await listen(app);t.after(()=>app.stop());return {port,pool,transaction};
}

test('OFF: sobe sem variável de banco, sem pool e sem carregar o driver; só /healthz responde',async t=>{
 let constructed=0;class Pool{constructor(){constructed++;}}
 const env={CRM_TEMPLATE_READ_REVISION:REV,CRM_PG_PASSWORD:'',CRM_PG_USER:'outro'};
 assert.deepEqual({...config(env)},{enabled:false,revision:REV,port:8080,pg:null});
 // Qualquer tentativa de carregar o driver pg no modo OFF derruba o teste.
 const Module=require('node:module'),load=Module._load;let pgLoads=0;
 Module._load=function(req,...rest){if(req==='pg'||/[\\/]pg$/.test(req))pgLoads++;return load.call(this,req,...rest);};
 let s;try{s=start(env,{Pool,port:0,host:'127.0.0.1'});}finally{Module._load=load;}t.after(()=>s.stop());assert.equal(pgLoads,0);
 await new Promise(r=>s.app.server.listening?r():s.app.server.once('listening',r));const port=s.app.server.address().port;
 assert.equal(s.pool,null);assert.equal(constructed,0);
 assert.equal(Object.keys(require.cache).some(k=>/[\\/]node_modules[\\/]pg[\\/]/.test(k)),false,'driver pg não carregado');
 const h=await fetch(`http://127.0.0.1:${port}/healthz`);assert.equal(h.status,200);
 assert.deepEqual(await h.json(),{service:'crm-template-read',contract:'crm-template-read-v1',revision:REV,enabled:false,stopping:false});
 for(const [search,headers] of [['?acao=listar&brand=fish&channel=email&offset=0&limit=20',{authorization:'Bearer '+KEY}],['',{}],['?x=1',{origin:'https://evil.example'}]]){
  const r=await get(port,search,headers);assert.equal(r.status,503);assert.deepEqual(JSON.parse(r.text),{error:'TEMPLATE_READ_DISABLED'});
 }
 // ON exige papel, banco e segredo exatos; valores ruins nunca sobem.
 for(const over of [{},{CRM_PG_USER:'postgres'},{CRM_PG_DATABASE:'outro'},{CRM_PG_PASSWORD:''},{CRM_PG_HOST:'a..b'}])
  assert.throws(()=>config({CRM_TEMPLATE_READ_ENABLED:'true',CRM_TEMPLATE_READ_REVISION:REV,CRM_PG_HOST:'db',CRM_PG_USER:'crm_template_reader',CRM_PG_DATABASE:'listmonk',CRM_PG_PASSWORD:'synthetic',...over,...(Object.keys(over).length?{}:{CRM_PG_PASSWORD:undefined})}),/CRM_TEMPLATE_READ_CONFIG/);
 for(const v of ['TRUE','1','on',''])assert.throws(()=>config({CRM_TEMPLATE_READ_ENABLED:v,CRM_TEMPLATE_READ_REVISION:REV}),/CRM_TEMPLATE_READ_CONFIG/);
 const on=config({CRM_TEMPLATE_READ_ENABLED:'true',CRM_TEMPLATE_READ_REVISION:REV,CRM_PG_HOST:'db',CRM_PG_USER:'crm_template_reader',CRM_PG_DATABASE:'listmonk',CRM_PG_PASSWORD:'synthetic'});
 assert.deepEqual([on.pg.max,on.pg.statement_timeout,on.pg.connectionTimeoutMillis,on.pg.user],[4,8000,3000,'crm_template_reader']);
});

test('pedido: só a forma canônica da ponte; marca, canal, paginação e campos fora do contrato são recusados sem conexão',async t=>{
 const db=await fixture(t),{port,pool}=await serve(t,db),A={authorization:'Bearer '+KEY};
 for(const brand of ['fish','aristo'])assert.equal((await get(port,`?acao=listar&brand=${brand}&channel=email&offset=0&limit=20`,A)).status,200);
 const before=pool.connects();
 for(const s of ['?acao=listar&channel=email&offset=0&limit=20','?acao=listar&brand=todas&channel=email&offset=0&limit=20','?acao=listar&brand=olivas&channel=email&offset=0&limit=20',
  '?acao=listar&brand=&channel=email&offset=0&limit=20','?acao=listar&brand=fish&channel=whatsapp&offset=0&limit=20','?acao=listar&brand=fish&channel=email&offset=100001&limit=20',
  '?acao=listar&brand=fish&channel=email&offset=0&limit=21','?acao=listar&brand=fish&channel=email&offset=0&limit=0','?acao=listar&brand=fish&channel=email&offset=-1&limit=5',
  '?acao=listar&brand=fish&channel=email&offset=01&limit=5','?acao=listar&brand=fish&channel=email&limit=20&offset=0','?brand=fish&acao=listar&channel=email&offset=0&limit=20',
  '?acao=listar&brand=fish&channel=email&offset=0&limit=20&k=x','?acao=listar&brand=fish&brand=aristo&channel=email&offset=0&limit=20','?acao=listar&brand=fish',
  '?acao=historico&brand=fish&key=fish_paid','?acao=historico&brand=fish&draft_id=d%27x','?acao=submissao&brand=fish&submission_id=','?acao=salvar&brand=fish','?acao=publicar&brand=fish&draft_id=d_1',
  '?acao=historico&brand=fish&draft_id='+'a'.repeat(65)]){
  const r=await get(port,s,A);assert.equal(r.status,400,s);assert.deepEqual(JSON.parse(r.text),{error:'TEMPLATE_READ_REQUEST'});
 }
 for(const [h,code] of [[{},401],[{authorization:'Bearer '+'b'.repeat(63)},401],[{authorization:'Bearer '+'B'.repeat(64)},401],[{authorization:'Basic '+KEY},401],[{...A,origin:'https://bandssz.github.io'},403]])
  assert.equal((await get(port,'?acao=listar&brand=fish&channel=email&offset=0&limit=20',h)).status,code);
 assert.equal((await get(port,'?'+'x'.repeat(600),A)).status,414);
 const post=await fetch(`http://127.0.0.1:${port}/template-read?acao=listar&brand=fish&channel=email&offset=0&limit=20`,{method:'POST',headers:A,body:'{}'});assert.equal(post.status,405);
 assert.equal(pool.connects(),before,'nenhuma recusa abriu conexão');
});

test('cadeia ponte → listener → SQL nas duas marcas: listar paginado, histórico e submissão; zero efeito, provedor não consultado',async t=>{
 const db=await fixture(t),{port}=await serve(t,db),before=await X.snapshot(db),c=chain(port,KEY);
 const fish=await c.read({acao:'listar',marca:'fish'});assert.equal(fish.status,200);assert.deepEqual(fish.body.templates.map(x=>x.id),['1','6','8']);
 assert.ok(fish.body.templates.every(x=>x.brand==='fish'&&x.channel==='email'));assert.equal(fish.body.schedule_proof,false);assert.equal(fish.body.coverage,'registered_email_only');
 const aristo=await c.read({acao:'listar',marca:'aristo',canal:'email'});assert.deepEqual(aristo.body.templates.map(x=>x.id),['2','9']);
 const p1=await c.read({acao:'listar',marca:'fish',offset:'0',limit:'2'}),p2=await c.read({acao:'listar',marca:'fish',offset:'2',limit:'2'});
 assert.deepEqual([p1.body.templates.map(x=>x.id),p1.body.next_offset,p2.body.templates.map(x=>x.id),p2.body.next_offset],[['1','6'],2,['8'],null]);
 assert.deepEqual(c.calls.slice(0,2),['?acao=listar&brand=fish&channel=email&offset=0&limit=20','?acao=listar&brand=aristo&channel=email&offset=0&limit=20']);
 const h=await c.read({acao:'historico',marca:'fish',draft_id:'d_fish_1'});assert.deepEqual(h.body.events.map(e=>e.action),['rascunho','validate','submeter']);
 const s=await c.read({acao:'submissao',marca:'aristo',submission_id:'s_aristo_1'});assert.equal(s.body.estado,'publicado');assert.equal(s.body.provider_polled,false);
 // Outra marca, Olivas ou inexistente: "não encontrado", sem distinção.
 for(const q of [{acao:'historico',marca:'aristo',draft_id:'d_fish_1'},{acao:'historico',marca:'fish',draft_id:'d_olivas_1'},{acao:'submissao',marca:'fish',submission_id:'s_aristo_1'},{acao:'submissao',marca:'fish',submission_id:'s_nada'}])
  await assert.rejects(c.read(q),{status:404,code:'TEMPLATE_READ_NOT_FOUND'});
 assert.deepEqual(await X.snapshot(db),before,'nenhuma linha, xmin ou xmax mudou');
});

test('revogação, expiração, chave sem capacidade e chaves legadas: o listener nega e a ponte não lê corpo',async t=>{
 const db=await fixture(t),{port}=await serve(t,db),q='?acao=listar&brand=fish&channel=email&offset=0&limit=20';
 assert.equal((await get(port,q,{authorization:'Bearer '+KEY})).status,200);
 for(const [k,code] of [[X.REVOKED_KEY,401],[X.TEMPLATE_V2_KEY,401],['0'.repeat(64),401]])assert.equal((await get(port,q,{authorization:'Bearer '+k})).status,code);
 // Sem a capacidade da ação: lê conteúdo, mas não histórico.
 assert.equal((await get(port,q,{authorization:'Bearer '+X.NOCAP_KEY})).status,200);
 assert.equal((await get(port,'?acao=historico&brand=fish&draft_id=d_fish_1',{authorization:'Bearer '+X.NOCAP_KEY})).status,403);
 await db.query("UPDATE public.crm_dash_chave SET expira_em=now()-interval '1 second' WHERE chave=$1",[X.PRINCIPAL]);
 assert.equal((await get(port,q,{authorization:'Bearer '+KEY})).status,401);
 await assert.rejects(chain(port,KEY).read({acao:'listar',marca:'fish'}),{status:403,code:'TEMPLATE_READ_UPSTREAM_DENIED'});
 await db.query('UPDATE public.crm_dash_chave SET expira_em=NULL,revogada_em=now() WHERE chave=$1',[X.PRINCIPAL]);
 assert.equal((await get(port,q,{authorization:'Bearer '+KEY})).status,401);
});

// Transação sintética: devolve o corpo que o teste quiser, para provar a validação de saída.
function fakeTx(body,{xid=null,hang=false}={}){
 const seen=[];const tx=async(work,{signal}={})=>{const q=async(text,values)=>{seen.push(text);if(!new Set(Object.values(S.SQL)).has(text))throw Error('DENIED');if(hang)await new Promise((_,rej)=>signal.addEventListener('abort',()=>rej(Error('aborted'))));return {rows:[{r:body}]};};
  const r=await work({query:q});if(xid!==null)throw Object.assign(Error('CRM_TEMPLATE_READ_WRITE_DETECTED'),{code:'CRM_TEMPLATE_READ_WRITE_DETECTED'});return r;};
 tx.seen=seen;return tx;
}
const AT='2026-10-03T12:00:00Z',H='e'.repeat(64);
const tpl=(brand,id,over={})=>({key:'email.template.'+id,brand,channel:'email',id:String(id),name:'T '+id,type:'tx',draft_id:null,components:{subject:'Oi',body_html:'<p>x</p>',altbody:null},content_available:true,content_hash:H,updated_at:AT,...over});
const page=(brand,items,over={})=>({contract:'crm-template-read-v1',brand,channel:'email',templates:items,offset:0,limit:20,total:items.length,next_offset:null,coverage:'registered_email_only',consultado_em:AT,schedule_proof:false,...over});
const L=[['acao','listar'],['brand','fish'],['channel','email'],['offset','0'],['limit','20']],AUTH='Bearer '+KEY;

test('saída validada antes de sair: item de outra marca, eco da chave (qualquer caixa), prova alegada ou corpo grande recusam a página inteira',async()=>{
 const ok=await S.createTemplateReadStore({transaction:fakeTx(page('fish',[tpl('fish',1)]))}).handle({authorization:AUTH,pairs:L});
 assert.equal(ok.status,200);assert.equal(JSON.parse(ok.text).templates[0].id,'1');
 for(const body of [page('fish',[tpl('fish',1),tpl('aristo',2)]),page('fish',[tpl(null,1)]),page('aristo',[tpl('aristo',1)]),page('fish',[tpl('fish',2),tpl('fish',1)]),
  page('fish',[tpl('fish',1,{name:'eco '+KEY})]),page('fish',[tpl('fish',1,{name:'eco '+KEY.toUpperCase()})]),page('fish',[tpl('fish',1,{components:{subject:'x',body_html:'<a href="?k='+KEY+'">',altbody:null}})]),
  page('fish',[tpl('fish',1)],{schedule_proof:true}),page('fish',[tpl('fish',1)],{total:5}),page('fish',[tpl('fish',1,{components:{subject:'x',body_html:'x'.repeat(400001),altbody:null}})]),null,'texto']){
  const r=await S.createTemplateReadStore({transaction:fakeTx(body)}).handle({authorization:AUTH,pairs:L});
  assert.equal(r.status,502);assert.deepEqual(r.body,{error:'TEMPLATE_READ_RESPONSE_DENIED'});assert.equal(r.text,undefined);
 }
 const sub={contract:'crm-template-submission-read-v1',brand:'fish',submission_id:'s_1',draft_id:'d_1',draft_version:2,provider:'meta',estado:'submetido',provider_status:'PENDING',rejected_reason:null,checked_at:null,read_at:AT,provider_polled:true};
 const r=await S.createTemplateReadStore({transaction:fakeTx(sub)}).handle({authorization:AUTH,pairs:[['acao','submissao'],['brand','fish'],['submission_id','s_1']]});
 assert.equal(r.status,502,'provider_polled:true é recusado');
});

test('prazo, cancelamento e escrita detectada: 503 sem corpo parcial; só as instruções permitidas chegam ao banco',async()=>{
 const hung=fakeTx(page('fish',[]),{hang:true}),t0=Date.now();
 const r=await S.createTemplateReadStore({transaction:hung,timeoutMs:50}).handle({authorization:AUTH,pairs:L});
 assert.equal(r.status,503);assert.ok(Date.now()-t0<2000);
 const c=new AbortController(),p=S.createTemplateReadStore({transaction:fakeTx(page('fish',[]),{hang:true})}).handle({authorization:AUTH,pairs:L},{signal:c.signal});c.abort();
 assert.equal((await p).status,503);
 assert.equal((await S.createTemplateReadStore({transaction:fakeTx(page('fish',[]),{xid:1})}).handle({authorization:AUTH,pairs:L})).status,503);
 const t=fakeTx(page('fish',[]));await S.createTemplateReadStore({transaction:t}).handle({authorization:AUTH,pairs:L});
 assert.deepEqual(t.seen,[S.SQL.setup,S.SQL.listar]);
 // A transação real recusa qualquer outra instrução e exige papel/READ ONLY.
 const calls=[];const client={async query(q){const text=typeof q==='string'?q:q.text;calls.push(text);if(text===S.SQL.identity)return {rows:[{role:'crm_template_reader',read_only:'on'}]};if(text===S.SQL.xid)return {rows:[{xid:null}]};return {rows:[]};},release(){}};
 const tx=S.createReadTransaction({pool:{connect:async()=>client}});
 await assert.rejects(tx(async q=>q.query('UPDATE public.templates SET name=name')),/CRM_TEMPLATE_READ_STATEMENT_DENIED/);
 assert.equal(calls.at(-1),'ROLLBACK');
 const wrong={async query(q){const text=typeof q==='string'?q:q.text;if(text===S.SQL.identity)return {rows:[{role:'postgres',read_only:'on'}]};return {rows:[]};},release(){}};
 await assert.rejects(S.createReadTransaction({pool:{connect:async()=>wrong}})(async()=>1),/CRM_TEMPLATE_READ_ROLE/);
});
