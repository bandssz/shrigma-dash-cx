/* Recuperação de tentativas pendentes (DESLIGADA): rota HTTP, executor e cliente do painel.
   Sem rede, sem banco: transporte e pool sintéticos. Prova que, com o gate desligado,
   nada muda (a ação continua recusada como antes) e que o cliente só consome o
   encerramento quando o servidor anuncia a política. */
'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),{createHash}=require('node:crypto');
const {createServer,parse,PATH,WRITES}=require('../services/crm-campaign/server.cjs');
const {parseAbandon,createAbandonExecutor,ABANDON_SQL,POLICY}=require('../services/crm-campaign/abandon.cjs');
const {config}=require('../services/crm-campaign/main.cjs');
global.CampaignContract=require('../campaign-contract');
global.CampaignTracking=require('../n8n/growth/campaign-tracking');
const A=require('../growth-campaign-api'),createLocks=require('./campaign-lock-fixture.cjs');

const KEY='pending-attempt-key-0001';
const BODY={k:'synthetic-write-key',acao:'campanha_operacao_abandonar',brand:'fish',idempotency_key:KEY,operation_action:'agendar',confirm:'abandonar'};
async function app(t,options={}){const calls={executor:[],abandon:[]};const a=createServer({revision:'a'.repeat(40),enabled:true,executor:async x=>{calls.executor.push(x);return {status:200,body:{ok:true}};},...options,
 ...(options.abandonExecutor===null?{}:{abandonExecutor:options.abandonExecutor||(async x=>{calls.abandon.push(x);return {status:200,body:{policy:POLICY,abandoned:true}};})})});
 await new Promise(r=>a.server.listen(0,'127.0.0.1',r));t.after(()=>a.stop());return {a,calls};}
function post(a,body,{path=PATH,method='POST'}={}){return new Promise((resolve,reject)=>{const bytes=Buffer.from(JSON.stringify(body));const req=http.request({host:'127.0.0.1',port:a.server.address().port,path,method,headers:{'Content-Type':'application/json','Content-Length':bytes.length}},res=>{const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>{try{resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))});}catch(e){reject(e);}});});req.on('error',reject);req.end(method==='GET'?undefined:bytes);});}

test('gate OFF (padrão): a ação continua desconhecida, nenhum executor roda e o contrato atual não muda',async t=>{
 const {a,calls}=await app(t);
 // Mesmo resultado de antes desta mudança: campo desconhecido (422) ou ação desconhecida (400).
 const r=await post(a,BODY);assert.equal(r.status,422);assert.equal(r.body.error,'REQUEST_FIELD_INVALID');
 const {operation_action,...withoutField}=BODY;const r2=await post(a,withoutField);assert.equal(r2.status,400);assert.equal(r2.body.error,'ACTION_INVALID');
 assert.equal(calls.executor.length,0);assert.equal(calls.abandon.length,0);
 assert.equal(WRITES.has('campanha_operacao_abandonar'),false,'conjunto de escritas publicado intacto');
 assert.throws(()=>parse({method:'POST',headers:{},rawHeaders:[]},new URL('https://x'+PATH),{k:'a',acao:'campanha_agendar',brand:'fish',operation_action:'agendar'}),e=>e.status===422,'campo novo não vaza para as ações existentes');
 const c=config({CRM_CAMPAIGN_REVISION:'a'.repeat(40),PGUSER:'crm_campaign_api',PGDATABASE:'listmonk',PGHOST:'internal',PGPASSWORD:'synthetic'});assert.equal(c.abandonEnabled,false);
 assert.equal(config({CRM_CAMPAIGN_REVISION:'a'.repeat(40),PGUSER:'crm_campaign_api',PGDATABASE:'listmonk',PGHOST:'internal',PGPASSWORD:'synthetic',CRM_CAMPAIGN_ABANDON_ENABLED:'true'}).abandonEnabled,true);
 assert.throws(()=>config({CRM_CAMPAIGN_REVISION:'a'.repeat(40),PGUSER:'crm_campaign_api',PGDATABASE:'listmonk',PGHOST:'internal',PGPASSWORD:'synthetic',CRM_CAMPAIGN_ABANDON_ENABLED:'yes'}));
 // Gate ligado mas sem executor também não abre a rota.
 const {a:b,calls:c2}=await app(t,{abandonEnabled:true,abandonExecutor:null});assert.equal((await post(b,BODY)).status,422);assert.equal(c2.executor.length,0);
});

test('gate ON: só POST exato chega ao executor de encerramento; demais ações seguem o caminho atual',async t=>{
 const {a,calls}=await app(t,{abandonEnabled:true});
 const ok=await post(a,BODY);assert.equal(ok.status,200);
 assert.deepEqual(calls.abandon.map(x=>({key:x.key,command:x.command})),[{key:'synthetic-write-key',command:{acao:'campanha_operacao_abandonar',brand:'fish',idempotency_key:KEY,operation_action:'agendar',confirm:'abandonar'}}]);
 for(const [patch,status,error] of [[{confirm:'sim'},422,'CONFIRM_REQUIRED'],[{operation_action:'salvar'},422,'ABANDON_ACTION_UNSUPPORTED'],[{operation_action:'validar'},422,'ABANDON_ACTION_UNSUPPORTED'],
  [{brand:'olivas'},422,'REQUEST_INVALID'],[{idempotency_key:'curta'},422,'REQUEST_INVALID'],[{actor:'admin'},422,'REQUEST_FIELD_INVALID'],[{k:''},401,'UNAUTHORIZED']]){
  const r=await post(a,{...BODY,...patch});assert.equal(r.status,status,JSON.stringify(patch));assert.equal(r.body.error,error);
 }
 const missing={...BODY};delete missing.confirm;assert.equal((await post(a,missing)).status,422);
 assert.equal((await post(a,BODY,{path:PATH+'?x=1'})).status,422,'POST com query recusado antes do executor');
 assert.equal(calls.abandon.length,1);
 assert.equal((await post(a,{k:'synthetic-write-key',acao:'campanha_agendar',brand:'fish'})).status,200);assert.equal(calls.executor.length,1,'agendar continua no executor de runtime');
 const {a:off}=await app(t,{abandonEnabled:true,enabled:false});assert.equal((await post(off,BODY)).status,503,'serviço desligado continua 503');
 assert.throws(()=>parseAbandon({method:'POST',headers:{},rawHeaders:['Authorization','a','authorization','b']},new URL('https://x'+PATH),BODY),e=>e.status===401);
});

test('executor: uma chamada parametrizada; recusas do banco viram respostas sem efeito; resposta incoerente não é aceita',async()=>{
 const seen=[];const result=op=>({rows:[{result:{policy:POLICY,abandoned:true,created:false,operation:{id:'00000000-0000-4000-8000-000000000001',operation_key:KEY,brand:'fish',action:'agendar',state:'rejected',...op}}}]});
 const run=async(answer)=>createAbandonExecutor({pool:{query:async(sql,params)=>{seen.push({sql,params});if(answer instanceof Error)throw answer;return answer;}}})({key:'k1',command:{acao:'campanha_operacao_abandonar',brand:'fish',idempotency_key:KEY,operation_action:'agendar',confirm:'abandonar'}});
 const ok=await run(result());assert.equal(ok.status,200);assert.equal(ok.body.abandoned,true);assert.equal(seen[0].sql,ABANDON_SQL);assert.deepEqual(seen[0].params,['k1',JSON.stringify({acao:'campanha_operacao_abandonar',brand:'fish',idempotency_key:KEY,operation_action:'agendar',confirm:'abandonar'})]);
 for(const [code,status,error] of [['ABANDON_LEASE_ACTIVE',409,'ABANDON_LEASE_ACTIVE'],['ABANDON_LEASE_UNKNOWN',409,'ABANDON_LEASE_UNKNOWN'],['ABANDON_IDENTITY_MISMATCH',409,'ABANDON_IDENTITY_MISMATCH'],['ABANDON_ACTION_UNSUPPORTED',422,'ABANDON_ACTION_UNSUPPORTED'],['ABANDON_DISABLED',503,'ABANDON_DISABLED'],['CRM_CAMPAIGN_GATEWAY_UNAUTHORIZED',401,'UNAUTHORIZED'],['CRM_CAMPAIGN_GATEWAY_FORBIDDEN',403,'CAPABILITY_MISSING']]){
  const r=await run(Object.assign(Error(code),{code:'P0001'}));assert.equal(r.status,status,code);assert.equal(r.body.error,error);
 }
 assert.equal((await run(Object.assign(Error('canceling statement due to lock timeout'),{code:'55P03'}))).body.error,'OPERATION_BUSY');
 const leaked=await run(Object.assign(Error('secret detail'),{code:'XX000'}));assert.equal(leaked.status,503);assert.doesNotMatch(JSON.stringify(leaked),/secret/);
 for(const bad of [result({operation_key:'outra-chave-qualquer-1'}),result({brand:'aristo'}),{rows:[{result:{policy:'other',abandoned:true,operation:{operation_key:KEY,brand:'fish'}}}]},{rows:[]}])assert.equal((await run(bad)).body.error,'ABANDON_UNCONFIRMED');
});

const END='https://campaign.example.test/operations',NOW=Date.parse('2026-09-19T12:00:00Z');
const BASE={contract_version:A.VERSION,brands:['aristo','fish'],read:true,save:true,validate:true,schedule:true,cancel:true,operation:true,audience_review:'listmonk-6.1-regular-v1'};
const definition=()=>({schema_version:A.VERSION,brand:'fish',channel:'email',initiative:{key:'fixture',name:'Fixture'},utm_campaign:'fixture',name:'Nome legível',subject:'Assunto',from_email:'Fish <contato@fishermans.com.br>',reply_to:'contato@fishermans.com.br',list_ids:[125],template_id:1,html:'https://fishermans.com.br/products/kit {{ UnsubscribeURL }}',text:'https://fishermans.com.br/products/kit {{ UnsubscribeURL }}',tags:[],send_at:'2026-09-20T15:00:00Z'});
const sha=k=>createHash('sha256').update(k).digest('hex');
function client({campaigns=BASE,acao='campanha_agendar',remote='pending',handler}={}){
 const data=new Map(),calls=[];let writeKey='synthetic-write-secret';
 const request={acao,brand:'fish',id:100,expected_version:'v1',confirm:acao.replace('campanha_',''),idempotency_key:KEY};
 data.set(A.JOURNAL+'fish',JSON.stringify({version:1,brand:'fish',endpoint:END,campaign:{id:100,version:'v1',status:'draft',sent:0,started_at:null,send_at:definition().send_at,definition:definition()},validation:null,
  operation:{phase:'uncertain',remote_state:remote,actorFingerprint:sha('synthetic-write-secret'),key:KEY,request,created_at:new Date(NOW).toISOString()}}));
 const options={locks:createLocks(),capabilities:A.caps({capabilities:{campaigns,endpoints:{campaigns:END}}}),brand:'fish',storage:{getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v)},readKey:()=>'synthetic-read-secret',writeKey:()=>writeKey,now:()=>NOW,uuid:()=>'unused-operation-0001',keyFingerprint:async k=>sha(k),
  fetch:async(url,init)=>{const u=new URL(url),body=init.method==='POST'?JSON.parse(init.body):Object.fromEntries(u.searchParams);calls.push({method:init.method,body});const r=await handler(body);return {status:r.status,json:async()=>r.body};}};
 return {c:A.createClient(options),calls,data,setKey:k=>{writeKey=k;}};
}
const tomb={id:'00000000-0000-4000-8000-0000000000aa',operation_key:KEY,brand:'fish',action:'agendar',state:'rejected',providerId:null,response:{status:409,body:{error:'OPERATION_ABANDONED',message:'Tentativa encerrada sem efeito.',provider_id:null,operation_id:'00000000-0000-4000-8000-0000000000aa'}}};

test('cliente: capability só com política exata; desligado não expõe nem envia nada',async()=>{
 const caps=c=>A.caps({capabilities:{campaigns:{...BASE,...c},endpoints:{campaigns:END}}});
 assert.equal(caps({}).abandon,false);assert.equal(caps({}).abandon_policy,null);
 assert.equal(caps({abandon:true}).abandon,false);assert.equal(caps({abandon_policy:A.ABANDON_POLICY}).abandon,false);
 assert.equal(caps({abandon:true,abandon_policy:A.ABANDON_POLICY,operation:false}).abandon,false);
 assert.equal(caps({abandon:true,abandon_policy:A.ABANDON_POLICY}).abandon,true);
 const {c,calls}=client({handler:async()=>{throw Error('unexpected');}});
 assert.equal(c.canAbandon(),false);await assert.rejects(c.abandon('abandonar'),{code:'CAPABILITY_UNAVAILABLE'});assert.equal(calls.length,0);assert.equal(c.locked(),true);
});

test('cliente: encerra só agendar/cancelar consultados como pending/missing, com a mesma chave, e libera pelo registro durável',async()=>{
 const on={...BASE,abandon:true,abandon_policy:A.ABANDON_POLICY};
 assert.equal(client({campaigns:on,remote:'outcome_unknown',handler:async()=>({status:500,body:{}})}).c.canAbandon(),false,'outcome_unknown segue pela liberação por versão');
 assert.equal(client({campaigns:on,remote:null,handler:async()=>({status:500,body:{}})}).c.canAbandon(),false,'sem consulta prévia não encerra');
 assert.equal(client({campaigns:on,acao:'campanha_salvar',handler:async()=>({status:500,body:{}})}).c.canAbandon(),false,'criação nunca por TTL');
 const refused=client({campaigns:on,handler:async b=>b.acao==='campanha_operacao_abandonar'?{status:409,body:{error:'ABANDON_LEASE_ACTIVE',message:'A tentativa ainda está no prazo e pode concluir.'}}:{status:500,body:{}}});
 await assert.rejects(refused.c.abandon('abandonar'),{code:'ABANDON_LEASE_ACTIVE'});assert.equal(refused.c.locked(),true);assert.equal(refused.c.snapshot().operation.phase,'uncertain');
 const x=client({campaigns:on,remote:'missing',handler:async b=>b.acao==='campanha_operacao_abandonar'?{status:200,body:{policy:A.ABANDON_POLICY,abandoned:true,created:true,operation:tomb}}:b.acao==='campanha_operacao'?{status:200,body:{operation:tomb}}:{status:500,body:{}}});
 assert.equal(x.c.canAbandon(),true);
 await assert.rejects(x.c.abandon('sim'),{code:'CONFIRM_REQUIRED'});
 x.setKey('other-write-secret');await assert.rejects(x.c.abandon('abandonar'),{code:'OPERATION_ACTOR_CHANGED'});x.setKey('synthetic-write-secret');
 assert.equal(x.calls.length,0);
 const s=await x.c.abandon('abandonar');
 assert.deepEqual(x.calls[0],{method:'POST',body:{k:'synthetic-write-secret',acao:'campanha_operacao_abandonar',brand:'fish',idempotency_key:KEY,operation_action:'agendar',confirm:'abandonar'}});
 assert.equal(x.calls[1].body.acao,'campanha_operacao');assert.equal(x.calls.length,2);
 assert.equal(s.operation.phase,'rejected');assert.equal(s.operation.response.body.error,'OPERATION_ABANDONED');assert.equal(x.c.locked(),false);
 // Resposta incoerente (outra chave) não destrava.
 const y=client({campaigns:on,acao:'campanha_cancelar',handler:async b=>b.acao==='campanha_operacao_abandonar'?{status:200,body:{policy:A.ABANDON_POLICY,abandoned:true,operation:{...tomb,operation_key:'outra-chave-qualquer-01'}}}:{status:500,body:{}}});
 await assert.rejects(y.c.abandon('abandonar'));assert.equal(y.c.locked(),true);assert.equal(y.calls[0].body.operation_action,'cancelar');
 // Servidor revela que o efeito venceu a corrida: a consulta normal confirma e relê.
 const won={...tomb,state:'succeeded',providerId:100,response:{status:200,body:{campaign:{id:100,version:'v2',status:'scheduled',sent:0,started_at:null,send_at:definition().send_at,definition:definition()},operation_id:tomb.id}}};
 const z=client({campaigns:on,handler:async b=>b.acao==='campanha_operacao_abandonar'?{status:200,body:{policy:A.ABANDON_POLICY,abandoned:false,created:false,operation:won}}:b.acao==='campanha_operacao'?{status:200,body:{operation:won}}:{status:500,body:{}}});
 await assert.rejects(z.c.abandon('abandonar'),{code:'READBACK_UNCONFIRMED'});assert.equal(z.c.snapshot().operation.phase,'succeeded','o efeito venceu: nada é marcado como abandonado');assert.equal(z.c.locked(),true,'até reler a campanha atual, continua travado');
});
