'use strict';
// Ponte READ do portal para templates (agente N). Sem rede: auth e fetch injetados.
const {test}=require('node:test'),assert=require('node:assert/strict');
const M=require('../services/dashboard-operational/crm-template-read-bridge.cjs');
const NOW=Date.UTC(2026,9,3,12),CRED='c'.repeat(64),HOST='dashboard-v24-crm.tazdb8.easypanel.host',ORIGIN='https://'+HOST;
const proof=(over={},brand='fish')=>({userId:brand==='fish'?'11111111-1111-4111-8111-111111111111':'33333333-3333-4333-8333-333333333333',owner:brand+'@oaristocrata.com',lifecycleId:brand==='fish'?'22222222-2222-4222-8222-222222222222':'44444444-4444-4444-8444-444444444444',lifecycleVersion:1,principalId:'dcrm-'+(brand==='fish'?'a':'b').repeat(32),generation:1,expiresAt:NOW+86400000,credentialMac:'d'.repeat(64),slot:'crm-panel-read',caps:['read_content','list_history','submission'],...over});
const credentialFor=brand=>brand==='fish'?CRED:'b'.repeat(64);
function harness({brand='fish',proofs=null,credential=credentialFor(brand),body,status=200,headers={},enabled=true,raw=null}={}){
 const calls={auth:0,cred:0,fetch:[]};let n=0;
 const auth={managedCrmReadAuthorization(ctx){calls.auth++;assert.equal(ctx.brand,brand);assert.equal(ctx.method,'GET');assert.equal(ctx.area,'growth');assert.equal(ctx.edit,false);const p=proofs?proofs[Math.min(n++,proofs.length-1)]:proof({},brand);if(p instanceof Error)throw p;return p;},
  getUpstreamCredential(ctx){calls.cred++;assert.equal(ctx.brand,brand);assert.equal(ctx.slot,'crm-panel-read');return credential;}};
 const fetchImpl=async(url,init)=>{calls.fetch.push({url:String(url),init});return new Response(raw??JSON.stringify(body),{status,headers:{'content-type':'application/json; charset=utf-8',...headers}});};
 const bridge=M.createTemplateReadBridge({auth,upstreams:{'template-read':new URL(M.DESTINATIONS['template-read'])},enabled},{fetchImpl,now:()=>NOW});
 const read=(query,extra={})=>bridge.read({context:{method:'GET',host:HOST,brand,...extra.context},route:extra.route||'templates',method:extra.method||'GET',query:new URLSearchParams(query),origin:extra.origin||ORIGIN});
 return {calls,read};
}
const H='e'.repeat(64),AT='2026-10-03T12:00:00.000Z';
const tpl=(brand,id,over={})=>({key:'email.template.'+id,brand,channel:'email',id:String(id),name:'Template '+id,type:'tx',draft_id:null,components:{subject:'Oi',body_html:'<p>x</p>',altbody:null},content_available:true,content_hash:H,updated_at:AT,...over});
const list=(brand,items,over={})=>({contract:'crm-template-read-v1',brand,channel:'email',templates:items,offset:0,limit:20,total:items.length,next_offset:null,coverage:'registered_email_only',consultado_em:AT,schedule_proof:false,...over});
const hist=(brand,events,over={})=>({contract:'crm-template-history-read-v1',brand,draft_id:'d_1',events,truncated:false,read_at:AT,...over});
const ev=(over={})=>({at:AT,who:'gestor',action:'validate',from_version:null,to_version:2,result:'ok',detail:null,...over});
const sub=(brand,over={})=>({contract:'crm-template-submission-read-v1',brand,submission_id:'s_1',draft_id:'d_1',draft_version:2,provider:'meta',estado:'submetido',provider_status:'PENDING',rejected_reason:null,checked_at:null,read_at:AT,provider_polled:false,...over});

test('duas marcas: marca obrigatória vira brand, query canônica no destino fixo, credencial do principal',async()=>{
 for(const brand of ['fish','aristo']){
  const h=harness({brand,body:list(brand,[tpl(brand,1),tpl(brand,7,{content_available:false,components:null})])});
  const r=await h.read({marca:brand,acao:'listar'});assert.equal(r.status,200);assert.equal(r.body.templates.length,2);
  assert.equal(h.calls.fetch[0].url,M.DESTINATIONS['template-read']+`?acao=listar&brand=${brand}&channel=email&offset=0&limit=20`);
  assert.equal(h.calls.fetch[0].init.headers.Authorization,'Bearer '+credentialFor(brand));assert.equal(h.calls.fetch[0].init.redirect,'manual');assert.equal(h.calls.auth,3);
  const hh=harness({brand,body:hist(brand,[ev()])});await hh.read({acao:'historico',draft_id:'d_1',marca:brand});assert.equal(hh.calls.fetch[0].url,M.DESTINATIONS['template-read']+`?acao=historico&brand=${brand}&draft_id=d_1`);
  const hs=harness({brand,body:sub(brand)});assert.equal((await hs.read({acao:'submissao',marca:brand,submission_id:'s_1'})).body.provider_polled,false);
 }
 const p=harness({body:list('fish',[tpl('fish',3)],{offset:2,limit:1,total:3})});
 assert.equal((await p.read({acao:'listar',marca:'fish',canal:'email',offset:'2',limit:'1'})).status,200);
});

test('flag OFF: 503 antes de autorização, credencial ou fetch',async()=>{
 const h=harness({enabled:false,body:list('fish',[])});
 await assert.rejects(h.read({acao:'listar',marca:'fish'}),{status:503,code:'TEMPLATE_READ_DISABLED'});
 assert.deepEqual([h.calls.auth,h.calls.cred,h.calls.fetch.length],[0,0,0]);
});

test('sem marca, todas as marcas, WhatsApp, por key, escrita ou recuperação: recusado sem I/O',async()=>{
 const cases=[{acao:'listar'},{acao:'listar',marca:'todas'},{acao:'listar',marca:'olivas'},{acao:'listar',marca:''},{acao:'listar',marca:'fish',canal:'whatsapp'},
  {acao:'historico',key:'fish_rastreio'},{acao:'historico',marca:'fish',key:'fish_rastreio'},{acao:'historico',draft_id:'d_1'},{acao:'submissao',submission_id:'s_1'},
  {acao:'historico',marca:'fish',draft_id:"d' OR 1=1"},{acao:'listar',marca:'fish',limit:'21'},{acao:'listar',marca:'fish',offset:'-1'},{acao:'listar',marca:'fish',k:'chave'},
  {acao:'email_capacidades'},{acao:'operacao',idempotency_key:'x',operacao:'y'},{acao:'rascunho',marca:'fish'},{acao:'validar',marca:'fish'},{acao:'submeter',marca:'fish'},{acao:'fluxos_listar',marca:'fish'},
  {acao:'email_teste_status',marca:'fish'},{acao:'listar',marca:'fish',pad:'x'.repeat(600)}];
 for(const q of cases){const h=harness({body:list('fish',[])});await assert.rejects(h.read(q),e=>e instanceof M.TemplateReadError&&[403,413].includes(e.status),JSON.stringify(q).slice(0,80));assert.equal(h.calls.fetch.length,0);assert.equal(h.calls.cred,0);}
 const scoped=harness({brand:'fish',body:list('aristo',[])});await assert.rejects(scoped.read({acao:'listar',marca:'aristo'}),{status:403});assert.deepEqual([scoped.calls.auth,scoped.calls.cred,scoped.calls.fetch.length],[0,0,0]);
 const dup=harness({body:list('fish',[])});await assert.rejects(dup.read('acao=listar&marca=fish&marca=aristo'),{status:403});
 for(const extra of [{method:'POST'},{origin:'https://evil.example'},{context:{method:'POST'}},{route:'campaigns'},{route:'segments'}]){const h=harness({body:list('fish',[])});await assert.rejects(h.read({acao:'listar',marca:'fish'},extra),{status:403});assert.equal(h.calls.fetch.length,0);}
 const A={managedCrmReadAuthorization(){},getUpstreamCredential(){}};
 assert.throws(()=>M.createTemplateReadBridge({auth:A,upstreams:{'template-read':new URL('https://n8n-n8n.tazdb8.easypanel.host/webhook/crm-template-api')},enabled:true}),{status:403},'destino fixo');
 assert.throws(()=>M.createTemplateReadBridge({auth:A,upstreams:{'template-read':new URL(M.DESTINATIONS['template-read']),templates:new URL('https://n8n-n8n.tazdb8.easypanel.host/webhook/x')},enabled:true}),{status:403},'sem rota legada');
});

test('principal revogado, expirado, trocado ou com credencial inválida: 503 sem dado',async()=>{
 const revoked=Object.assign(Error('CRM_ACCESS_NOT_READY'),{status:503});
 for(const c of [{proofs:[revoked]},{proofs:[proof({expiresAt:NOW+1000})]},{proofs:[proof(),proof({generation:2})]},{proofs:[proof({slot:'growth-read'})]},{proofs:[proof({caps:['read_content','list_history']})]},{credential:'x'},{credential:CRED.toUpperCase()}]){
  const h=harness({...c,body:list('fish',[])});await assert.rejects(h.read({acao:'listar',marca:'fish'}),{status:503,code:'TEMPLATE_READ_NOT_READY'});assert.equal(h.calls.fetch.length,0,JSON.stringify(c));
 }
 for(const late of [[proof(),proof(),revoked],[proof(),proof(),proof({lifecycleVersion:2})],[proof(),proof(),proof({expiresAt:NOW})]]){
  const h=harness({proofs:late,body:list('fish',[tpl('fish',1)])});await assert.rejects(h.read({acao:'listar',marca:'fish'}),{status:503,code:'TEMPLATE_READ_NOT_READY'});assert.equal(h.calls.fetch.length,1);
 }
});

test('item de outra marca ou sem marca, contrato errado, corpo grande, eco de segredo ou alegação de prova: 502',async()=>{
 const deny={status:502,code:'TEMPLATE_READ_RESPONSE_DENIED'},q={acao:'listar',marca:'fish'};
 const {brand:_,...noBrand}=tpl('fish',2);
 const bad=[list('aristo',[]),list('fish',[tpl('aristo',1)]),list('fish',[tpl('fish',1),tpl('aristo',2)]),list('fish',[noBrand]),list('fish',[tpl('fish',1,{brand:null})]),list('fish',[tpl('fish',1,{brand:'olivas'})]),
  list('fish',[tpl('fish',1,{channel:'whatsapp'})]),list('fish',[tpl('fish',1,{key:'email.template.2'})]),list('fish',[tpl('fish',2),tpl('fish',1)]),list('fish',[tpl('fish',1),tpl('fish',1)],{total:2}),
  list('fish',[tpl('fish',1,{extra:1})]),list('fish',[tpl('fish',1,{components:null})]),list('fish',[tpl('fish',1,{content_available:false})]),list('fish',[tpl('fish',1,{components:{subject:'x',body_html:'y'.repeat(400001),altbody:null}})]),
  list('fish',[tpl('fish',1,{name:'a\u0007b'})]),list('fish',[tpl('fish',1,{type:'campaign_visual'})]),list('fish',[tpl('fish',1)],{schedule_proof:true}),list('fish',[tpl('fish',1)],{coverage:'all'}),
  list('fish',[tpl('fish',1)],{total:2}),list('fish',[tpl('fish',1)],{limit:50}),list('fish',[tpl('fish',1)],{channel:'whatsapp'}),{...list('fish',[]),capabilities:{}},
  list('fish',[tpl('fish',1,{name:CRED})])];
 for(const body of bad){const h=harness({body});await assert.rejects(h.read(q),deny,JSON.stringify(body).slice(0,140));}
 for(const c of [{raw:'{'},{raw:new Uint8Array([0xff])},{raw:'[]'},{raw:JSON.stringify(list('fish',[])),headers:{'content-type':'text/html'}},{raw:JSON.stringify(list('fish',[])),headers:{'content-encoding':'gzip'}},{raw:JSON.stringify(list('fish',[])),headers:{'content-length':String(M.MAX_RESPONSE+1)}}])
  await assert.rejects(harness(c).read(q),deny);
 const hq={acao:'historico',marca:'fish',draft_id:'d_1'};
 for(const body of [hist('aristo',[]),hist('fish',[],{draft_id:'d_2'}),hist('fish',[ev({action:''})]),hist('fish',[ev({to_version:'2'})]),hist('fish',[ev({who:CRED})]),hist('fish',[ev()],{truncated:true}),hist('fish',Array.from({length:201},()=>ev()))])
  await assert.rejects(harness({body}).read(hq),deny);
 const sq={acao:'submissao',marca:'fish',submission_id:'s_1'};
 for(const body of [sub('aristo'),sub('fish',{submission_id:'s_2'}),sub('fish',{provider_polled:true}),sub('fish',{estado:'ativo'}),sub('fish',{provider:'n8n'}),sub('fish',{provider_status:'pending'}),sub('fish',{extra:1})])
  await assert.rejects(harness({body}).read(sq),deny);
 for(const [status,code,http] of [[404,'TEMPLATE_READ_NOT_FOUND',404],[401,'TEMPLATE_READ_UPSTREAM_DENIED',403],[403,'TEMPLATE_READ_UPSTREAM_DENIED',403],[503,'TEMPLATE_READ_UPSTREAM_UNAVAILABLE',502],[302,'TEMPLATE_READ_UPSTREAM_UNAVAILABLE',502]]){
  const h=harness({status,raw:JSON.stringify({error:'CRM_TEMPLATE_READ_NOT_FOUND'})});await assert.rejects(h.read(sq),{status:http,code});assert.equal(h.calls.auth,2);assert.equal(h.calls.fetch.length,1);
 }
});
