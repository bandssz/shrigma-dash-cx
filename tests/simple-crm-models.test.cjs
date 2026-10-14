'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite'),crypto=require('node:crypto');
const M=require((process.env.DASHBOARD_ACCESS_TEST_RUNTIME||require('node:path').resolve(__dirname,'../services/dashboard-operational'))+'/simple-crm-models.cjs');
const destination='https://n8n.shrigma.com.br/webhook/crm-modelos-20261014-14a1976f59cd';
function fixture(){
 const db=new DatabaseSync(':memory:'),receipts=new Map(),drafts=new Map();let posts=0,mode='normal',edit=true,actor='analyst-one';
 const sourceActor='panel:real-source-principal',credential='fixture-private-transport-key';
 const binding=async(_context,{brand,write})=>{if(!['fish','aristo'].includes(brand)||write&&!edit)throw Object.assign(Error('DENIED'),{code:'PRODUCT_WRITE_DENIED',status:403});return {author:{id:actor},credential,sourceActor,binding:'binding-'+actor+'-'+brand,snapshot:'stable'};};
 const remoteKey=({userId,brand,key,action})=>{const h=crypto.createHash('sha256').update(JSON.stringify([userId,brand,key,action])).digest('hex');return h.slice(0,8)+'-'+h.slice(8,12)+'-4'+h.slice(13,16)+'-8'+h.slice(17,20)+'-'+h.slice(20,32);};
 const fetchImpl=async(url,init)=>{
  const u=new URL(url);assert.equal(u.origin+u.pathname,destination);assert.equal(init.headers.Authorization,'Bearer '+credential);
  const response=body=>new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
  if(init.method==='GET'){
   const action=u.searchParams.get('acao'),brand=u.searchParams.get('marca');
   if(action==='email_capacidades')return response({contract:'crm_email_native_preview_v1'});
   if(action==='rascunho_obter'){const d=drafts.get(u.searchParams.get('draft_id'));return response({contract:'crm-model-drafts-v1',brand,drafts:d?[d]:[]});}
   assert.equal(action,'operacao');assert.equal(init.headers['X-Template-Key'],credential);
   if(mode==='preflight-down')throw Error('network unavailable');
   const key=u.searchParams.get('idempotency_key'),actionName=u.searchParams.get('operacao');
   let operation=receipts.get(key)||{idempotency_key:key,acao:actionName,actor:sourceActor,request_payload:null,request_sha256:null,hash_schema:'json-stable-sha256-v1',state:'missing',response:null,claim_id:null};
   if(mode==='bad-missing')operation={...operation,request_payload:{unexpected:true}};
   if(mode==='bad-terminal'&&operation.state==='completed')operation={...operation,response:{status:200,body:{draft_id:'d_model',estado:'rascunho',version:0}}};
   return response({contract:'template_operation_v1',operation});
  }
  assert.equal(init.method,'POST');posts++;const b=JSON.parse(init.body);
  if(mode==='lost-before-effect')throw Error('lost POST before source effect');
  const payload={acao:b.acao,rascunho:b.rascunho??null,draft_id:b.draft_id??null,expected_version:b.expected_version??null,confirm:b.confirm??null};
  const id=b.draft_id||'d_model',version=b.acao==='rascunho'?(b.draft_id?b.expected_version+1:1):b.expected_version;
  const claim=b.acao==='submeter'?crypto.randomUUID():null;
  const body={draft_id:id,version,estado:b.acao==='validar'?'validado':b.acao==='submeter'?'publicado':'rascunho',who:sourceActor,...(b.acao==='validar'?{erros:[]}:{}),...(claim?{provider:'listmonk',provider_status:'APPROVED',operation_id:claim,submission_id:'s_'+claim.replace(/-/g,'')}: {})};
  drafts.set(id,{draft_id:id,version,estado:body.estado,brand:b.rascunho?.marca||drafts.get(id)?.brand||'fish',channel:'email',rascunho:b.rascunho||drafts.get(id)?.rascunho});
  receipts.set(b.idempotency_key,{idempotency_key:b.idempotency_key,acao:b.acao,actor:sourceActor,request_payload:payload,request_sha256:M.hash(payload),hash_schema:'json-stable-sha256-v1',state:'completed',response:{status:b.acao==='rascunho'?201:200,body},claim_id:claim});
  if(mode==='lost-after-effect')throw Error('lost ACK after commit');
  return response(body);
 };
 const api=M.create({db,binding,remoteKey,fetchImpl,destination});
 return {api,db,receipts,drafts,get posts(){return posts;},setMode:v=>mode=v,setEdit:v=>edit=v,setActor:v=>actor=v};
}
function input(brand='fish',name='Modelo do teste'){return {acao:'rascunho',idempotency_key:crypto.randomUUID(),rascunho:{marca:brand,canal:'email',nome:name,assunto:'Assunto',corpo:'<p>Conteúdo</p>',idioma:'pt_BR',categoria:'MARKETING',peca:'campanha',cabecalho:'',rodape:'',exemplos:{},botoes:[]}};}
for(const brand of ['fish','aristo'])test('save/reopen brand and real verified actor separation '+brand,async()=>{const f=fixture(),b=input(brand),r=await f.api.write({},brand,b);assert.equal(r.body.operation.state,'completed');assert.equal(r.body.operation.actor,'crm-user:analyst-one');assert.equal(r.body.operation.request_sha256,M.hash(r.body.operation.request_payload));assert.equal(f.posts,1);assert.equal((await f.api.getDraft({},brand,'d_model')).rascunho.nome,b.rascunho.nome);assert.ok(!JSON.stringify(r).includes('real-source-principal'));assert.ok(!JSON.stringify(r).includes('fixture-private-transport-key'));f.db.close();});
test('lost ACK after committed effect reconciles; repeated POST never repeats transport',async()=>{const f=fixture(),b=input();f.setMode('lost-after-effect');const r=await f.api.write({},'fish',b);assert.equal(r.body.operation.state,'completed');await f.api.write({},'fish',b);assert.equal(f.posts,1);assert.equal(f.db.prepare('SELECT state FROM crm_simple_models_operation_v1').get().state,'confirmed');f.db.close();});
test('uncertain POST remains pending; another model works',async()=>{const f=fixture(),a=input('fish','A');f.setMode('lost-before-effect');const r=await f.api.write({},'fish',a);assert.equal(r.body.operation.state,'outcome_unknown');await f.api.write({},'fish',a);assert.equal(f.posts,1);f.setMode('normal');assert.equal((await f.api.write({},'fish',input('fish','B'))).body.operation.state,'completed');assert.equal(f.posts,2);f.db.close();});
test('preflight outage records proof of no POST and releases next attempt',async()=>{const f=fixture();f.setMode('preflight-down');const r=await f.api.write({},'fish',input());assert.equal(r.body.operation.response.body.nothing_changed,true);assert.equal(f.posts,0);assert.equal(f.db.prepare('SELECT state FROM crm_simple_models_operation_v1').get().state,'not_sent');f.setMode('normal');assert.equal((await f.api.write({},'fish',input())).body.operation.state,'completed');assert.equal(f.posts,1);f.db.close();});
test('inconsistent missing receipt never admits POST',async()=>{const f=fixture();f.setMode('bad-missing');const r=await f.api.write({},'fish',input());assert.equal(r.body.operation.response.body.erro,'MODELS_RECEIPT_REFUSED');assert.equal(f.posts,0);f.db.close();});
test('malformed terminal receipt leaves fence intact',async()=>{const f=fixture(),b=input();f.setMode('bad-terminal');await assert.rejects(f.api.write({},'fish',b),e=>e.code==='MODELS_RECEIPT_REFUSED');assert.equal(f.db.prepare('SELECT state FROM crm_simple_models_operation_v1').get().state,'pending');await assert.rejects(f.api.write({},'fish',b));assert.equal(f.posts,1);f.db.close();});
test('two concurrent requests share one source POST',async()=>{const f=fixture(),b=input();await Promise.all([f.api.write({},'fish',b),f.api.write({},'fish',b)]);assert.equal(f.posts,1);f.db.close();});
test('READ account never writes and cross-brand payload is refused',async()=>{const f=fixture();f.setEdit(false);await assert.rejects(f.api.write({},'fish',input()),e=>e.code==='PRODUCT_WRITE_DENIED');assert.equal(f.posts,0);f.setEdit(true);await assert.rejects(f.api.write({},'fish',input('aristo')),e=>e.code==='MODELS_BRAND_REFUSED');assert.equal(f.posts,0);f.db.close();});
test('CAS refusal is a verifiable local terminal receipt',async()=>{const f=fixture(),b=input();b.draft_id='d_model';b.expected_version=1;f.drafts.set('d_model',{draft_id:'d_model',brand:'fish',channel:'email',version:2,rascunho:b.rascunho});const r=await f.api.write({},'fish',b);assert.equal(r.body.operation.response.status,409);assert.equal(r.body.operation.response.body.nothing_changed,true);assert.equal(f.posts,0);f.db.close();});
test('idempotency cannot be reused with another body or by another person',async()=>{const f=fixture(),b=input();await f.api.write({},'fish',b);await assert.rejects(f.api.write({},'fish',{...b,rascunho:{...b.rascunho,nome:'Outro'}}),e=>e.code==='MODELS_OPERATION_CHANGED');f.setActor('analyst-two');assert.equal((await f.api.read({},'fish',new URLSearchParams({acao:'operacao',operacao:'rascunho',idempotency_key:b.idempotency_key}))).body.operation.state,'missing');assert.equal(f.posts,1);f.db.close();});
test('actual browser journal accepts cookie-backed save/validate/publication receipts',async()=>{const GTJ=require('../growth-template-journal.js'),f=fixture(),store=new Map(),b=input();delete b.idempotency_key;const journal=GTJ.create({endpoint:'https://crm.example.test/api/templates',storage:{getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v)},locks:{request:async(_key,_options,fn)=>fn({})},crypto:crypto.webcrypto});const call=p=>journal.run({local_id:'local-model',resource_scope:{brand:'fish',channel:'email',name:b.rascunho.nome},request_payload:p},{persistLocal:async()=>true,lookup:(key,action)=>f.api.read({},'fish',new URLSearchParams({acao:'operacao',operacao:action,idempotency_key:key})),transport:p=>f.api.write({},'fish',p)});const save=await call(b);assert.equal(save.ok,true);await journal.markApplied(save.operation_id,async()=>true);const validated=await call({acao:'validar',draft_id:save.body.draft_id,expected_version:1});assert.equal(validated.ok,true);await journal.markApplied(validated.operation_id,async()=>true);const published=await call({acao:'submeter',draft_id:save.body.draft_id,expected_version:1,confirm:'submeter'});assert.equal(published.body.estado,'publicado');assert.equal(f.posts,3);assert.equal(journal.inspect().operations.length,3);f.db.close();});
