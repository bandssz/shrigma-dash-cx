'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const M=require('../n8n/growth/whatsapp-order-status-proposal.cjs'),I=require('../n8n/growth/whatsapp-order-status-integration.cjs'),WAT=require('../whatsapp-template-contract.js');
const clone=structuredClone;
function fixture(){
 const byBrand=require('./whatsapp-order-status-fixture.cjs').catalogs(),proposals=M.buildProposal(byBrand),catalog=Object.values(byBrand).flat();
 proposals.forEach((p,i)=>catalog.push({brand:p.brand,id:String(99000+i),status:'APPROVED',...clone(p.provider_payload)}));
 const flows=[...new Set(proposals.map(p=>p.flow_key))].map(key=>{
  const ps=proposals.filter(p=>p.flow_key===key),steps=ps.map(p=>({key:p.step_key,channel:'whatsapp',flow:'transacional',piece:p.draft.peca,enabled:true,template_id:p.source_template_id,template_name:p.source_template_name,category:'UTILITY',signature:[{type:'HEADER',format:'TEXT',vars:[]},{type:'BODY',vars:Object.keys(p.draft.exemplos)},{type:'BUTTONS',buttons:[{type:'URL',url:'https://conta.'+M.HOSTS[p.brand]+'/?utm_source=whatsapp'},{type:'URL',url:'https://'+M.HOSTS[p.brand]+'/suporte'}]}]}));
  // An unrelated existing stage must survive the migration byte for byte.
  steps.push({key:'email:unchanged',channel:'email',enabled:false,template_id:'7',copy:'synthetic'});
  return {key,brand:ps[0].brand,enabled:true,runtime_ready:true,version:3,published_version:3,binding:{steps:steps.map(s=>({...clone(s),source_template_id:ps.find(p=>p.step_key===s.key)?.caller_template_id}))},draft:{name:'Synthetic',steps:clone(steps)},published:{name:'Synthetic',steps:clone(steps)},updated_by:'synthetic'};
 });
 return {proposals,catalog,flows};
}
function input(p){return {brand:p.brand,flow:'transacional',piece:p.draft.peca,ref:'42',template_id:p.caller_template_id,template_name:'legacy',language:'pt_BR',modo:'real',components:[...(p.brand==='fish'&&p.draft.peca==='pedido-pago'?[{type:'header',parameters:[{type:'image',image:{link:'https://example.invalid/image'}}]}]:[]),{type:'body',parameters:Object.values(p.draft.exemplos).map(text=>({type:'text',text}))}],_order_status_source:I.captureOrderSource({data:{order:{id:'gid://shopify/Order/42',test:false,cancelledAt:null,displayFinancialStatus:'PAID',statusPageUrl:'https://'+M.HOSTS[p.brand]+'/123/orders/SYNTHETIC/authenticate?key=SYNTHETICKEY'}}})};}
function config(c){return {_managed:true,_allowed:true,_flow_key:c.flow_key,_version:c.source_version+1,key:c.step_key,template_id:c.target.id,template_name:c.target.name};}
function apply(i,c,contracts){const selected=config(c);return I.applyOrderStatusStage(i,selected,{...i,template_id:selected.template_id,template_name:selected.template_name},contracts);}

test('preparation requires fresh exact APPROVED content, published revision and original selector',()=>{
 const f=fixture();assert.equal(I.buildContracts(f.proposals,f.catalog,f.flows).length,6);
 for(const status of ['PENDING','REJECTED','PAUSED']){
  const changed=clone(f.catalog);changed.at(-1).status=status;assert.throws(()=>I.buildContracts(f.proposals,changed,f.flows),/APPROVED/);
 }
 const copy=clone(f.catalog);copy.at(-1).components.find(x=>x.type==='BODY').text+=' changed';assert.throws(()=>I.buildContracts(f.proposals,copy,f.flows),/content differs/);
 const edited=clone(f.flows);edited[0].draft.name='Unpublished';assert.throws(()=>I.buildContracts(f.proposals,f.catalog,edited),/Unpublished/);
 const renamed=clone(f.flows);renamed[0].published.steps[0].template_name='other';renamed[0].draft=clone(renamed[0].published);assert.throws(()=>I.buildContracts(f.proposals,f.catalog,renamed),/source changed/);
});
test('all six switch identity and dynamic component together; original body and opaque key survive',()=>{
 const f=fixture(),contracts=I.buildContracts(f.proposals,f.catalog,f.flows);
 contracts.forEach((c,i)=>{
  const original=input(f.proposals[i]),copy=clone(original),out=apply(original,c,contracts),approved=f.catalog.find(t=>String(t.id)===c.target.id);
  assert.equal(out._flow_block,undefined);assert.equal(out.template_id,c.target.id);assert.equal(out.template_name,c.target.name);
  assert.equal(out._order_status_source,undefined);assert.deepEqual(original,copy,'never mutate original source');
  assert.deepEqual(out.components.find(x=>x.type==='body'),original.components.find(x=>x.type==='body'));
  assert.ok(!out.components.some(x=>x.type==='header'));assert.match(out.components.at(-1).parameters[0].text,/^123\/orders\/SYNTHETIC\/authenticate\?key=SYNTHETICKEY&/);
  assert.equal(WAT.runtime(out,approved),null);assert.equal(I.approvedOrderContentError(out,approved,contracts),null);
 });
});
test('preinstalled caller/motor remain compatible with old stage, PIX and direct carrier templates',()=>{
 const f=fixture(),cs=I.buildContracts(f.proposals,f.catalog,f.flows),c=cs[0],i=input(f.proposals[0]);
 const old={...config(c),template_id:c.source_template_id,template_name:c.source_template_name},result={...i,template_id:old.template_id,template_name:old.template_name};
 const unchanged=I.applyOrderStatusStage(i,old,result,cs);delete result._order_status_source;assert.deepEqual(unchanged,result);
 for(const piece of ['pix-15min','carrinho-30min','rastreio-criado']){
  const unrelated={...i,piece,template_id:'555',template_name:'existing_carrier_or_pix',components:[{type:'button',sub_type:'url',index:0,parameters:[{type:'text',text:'rastreio/SYNTHETIC'}]}]};
  const expected=clone(unrelated);delete expected._order_status_source;
  assert.deepEqual(I.applyOrderStatusStage(unrelated,{_managed:false},unrelated,cs),expected);
 }
 assert.equal(I.applyOrderStatusStage(i,config(c),{...i,_flow_block:'flow_paused'},cs)._flow_block,'flow_paused');
});
test('new stage rejects stale caller execution, wrong order/domain, cancelled/unpaid and wrong selector',()=>{
 const f=fixture(),cs=I.buildContracts(f.proposals,f.catalog,f.flows),i=input(f.proposals[0]),c=cs[0];
 for(const mutate of [x=>delete x._order_status_source,x=>x._order_status_source.order.id='gid://shopify/Order/43',x=>x._order_status_source.order.statusPageUrl='https://example.invalid/123/orders/SYNTHETIC/authenticate?key=x',x=>x._order_status_source.order.cancelledAt='2026-09-19T00:00:00Z',x=>x._order_status_source.order.displayFinancialStatus='PENDING',x=>x.template_id='999',x=>x.piece='pix-15min']){
  const x=clone(i);mutate(x);assert.ok(apply(x,c,cs)._flow_block);
 }
 const selected={...config(c),_version:c.source_version};assert.equal(I.applyOrderStatusStage(i,selected,{...i,template_id:c.target.id,template_name:c.target.name},cs)._flow_block,'pedido_estagio_nao_publicado');
 const trackIndex=f.proposals.findIndex(p=>p.draft.peca==='rastreio-criado'),track=input(f.proposals[trackIndex]);track._order_status_source.order.displayFinancialStatus='REFUNDED';assert.equal(apply(track,cs[trackIndex],cs)._flow_block,'pedido_estado_financeiro_invalido');
});
test('live Meta guard refuses later status/category/content drift, before any reservation',()=>{
 const f=fixture(),cs=I.buildContracts(f.proposals,f.catalog,f.flows),out=apply(input(f.proposals[0]),cs[0],cs),approved=f.catalog.find(t=>String(t.id)===cs[0].target.id);
 for(const mutate of [x=>x.status='PENDING',x=>x.category='MARKETING',x=>x.components.find(c=>c.type==='BODY').text+=' Other',x=>x.components.find(c=>c.type==='BUTTONS').buttons[0].url='https://example.invalid/{{1}}']){
  const t=clone(approved);mutate(t);assert.equal(I.approvedOrderContentError(out,t,cs),'pedido_conteudo_aprovado_divergente');
 }
});
function caller(brand){return {versionId:'fresh',nodes:[{name:'Roteia evento → peça',type:'n8n-nodes-base.code',parameters:{jsCode:"const GQL = 'query($id: ID!) { order(id: $id) { id name } }';"+(brand==='aristo'?"\nconst GQL_PAID = 'query($id: ID!) { order(id: $id) { name } }';":'')}},{name:'Monta componentes',type:'n8n-nodes-base.code',parameters:{jsCode:'// WA_TRACKING_SOURCE_PATH_V1\n'+(brand==='fish'?'// WA_FISH_TRANSACTION_GUARD_V1\n':'// evaluatePaidCutover(item.json, cfg, Date.now())\n')+'const item={json:$response};const r={piece:"pedido-pago",order_id:"42",email:"synthetic@example.invalid"};return {json:{'+(brand==='fish'?"flow: 'transacional', piece: r.piece, ref: r.order_id, email: r.email,":"flow:'transacional',piece:r.piece,ref:r.order_id,email:r.email,")+'}};'}},{name:'unchanged',parameters:{private:'synthetic'}}],connections:{unchanged:true},settings:{unchanged:true}};}
test('caller patch adds source fields to every query, preserving selectors/guards and other nodes',()=>{
 for(const brand of ['aristo','fish']){
  const w=caller(brand),before=clone(w),r=I.patchCaller(w,{expectedVersionId:'fresh',brand});assert.deepEqual(w,before);assert.equal(r.changes.length,2);
  const queries=[...r.workflow.nodes[0].parameters.jsCode.matchAll(/query\(\$id[^']+/g)].map(m=>m[0]);assert.equal(queries.length,brand==='aristo'?2:1);assert.ok(queries.every(q=>q.includes('statusPageUrl')&&q.includes(' id ')));
  assert.deepEqual(r.workflow.nodes[2],w.nodes[2]);assert.deepEqual(r.workflow.connections,w.connections);assert.deepEqual(r.workflow.settings,w.settings);
  const response={data:{order:{id:'gid://shopify/Order/42',test:false,cancelledAt:null,displayFinancialStatus:'PAID',statusPageUrl:'https://example.invalid/private',phone:'DO_NOT_COPY',customer:{email:'DO_NOT_COPY'}}}};
  const output=vm.runInNewContext('(function(){'+r.workflow.nodes[1].parameters.jsCode+'})()',{$response:response});assert.equal(output.json._order_status_source.order.phone,undefined);assert.equal(output.json._order_status_source.order.customer,undefined);
  assert.deepEqual(I.patchCaller(r.workflow,{expectedVersionId:'fresh',brand}).changes,[]);assert.throws(()=>I.patchCaller(w,{expectedVersionId:'stale',brand}),/matching/);
 }
});
function motor(){return {versionId:'fresh',nodes:[{name:'Aplica fluxo publicado',type:'n8n-nodes-base.code',parameters:{jsCode:"function applyPublishedStage(input,config){return {...input,template_id:config.template_id,template_name:config.template_name};}\nreturn {json:applyPublishedStage($('Chamado por outro workflow').item.json,$json.config)};"}},{name:'Valida template UTILITY',type:'n8n-nodes-base.code',parameters:{jsCode:"const WAT={runtime:()=>null};const input=$inputValue,response=$response;const reason=WAT.runtime(input,response.body);return {reason};"}},{name:'Interpreta resposta',type:'n8n-nodes-base.code',parameters:{jsCode:'// WA_UNCERTAIN_RESERVATION_V1\nreturn $json;'}},{name:'Guarda + reserva (PG)',parameters:{unchanged:true}},{name:'Valida contrato',parameters:{pix:'unchanged'}}],connections:{unchanged:true},settings:{unchanged:true}};}
test('generated motor runs without require, checks fresh provider content and preserves PIX/reservation nodes',()=>{
 const f=fixture(),cs=I.buildContracts(f.proposals,f.catalog,f.flows),w=motor(),patched=I.patchMotor(w,{expectedVersionId:'fresh',contracts:cs});assert.equal(patched.changes.length,2);
 for(let i=2;i<w.nodes.length;i++)assert.deepEqual(patched.workflow.nodes[i],w.nodes[i]);assert.deepEqual(patched.workflow.connections,w.connections);
 const i=input(f.proposals[0]),out=vm.runInNewContext('(function(){'+patched.workflow.nodes[0].parameters.jsCode+'})()',{$:()=>({item:{json:i}}),$json:{config:config(cs[0])}}).json;
 assert.equal(out._flow_block,undefined);assert.equal(out.template_id,cs[0].target.id);assert.equal(out.components.at(-1).sub_type,'url');
 const provider=f.catalog.find(t=>String(t.id)===cs[0].target.id),guard=body=>vm.runInNewContext('(function(){'+patched.workflow.nodes[1].parameters.jsCode+'})()',{$inputValue:out,$response:{body}});
 assert.equal(guard(provider).reason,null);assert.equal(guard({...provider,status:'PAUSED'}).reason,'pedido_conteudo_aprovado_divergente');
 assert.deepEqual(I.patchMotor(patched.workflow,{expectedVersionId:'fresh',contracts:cs}).changes,[]);
 const changed=clone(cs);changed[0].target.name+='other';assert.throws(()=>I.patchMotor(patched.workflow,{expectedVersionId:'fresh',contracts:changed}),/different order integration/);
});
test('stage plan changes all six identities/signatures once per flow, preserves cadence and cannot activate by itself',()=>{
 const f=fixture(),before=clone(f.flows),cs=I.buildContracts(f.proposals,f.catalog,f.flows),plan=I.planStageSwitch(f.flows,cs);
 assert.equal(plan.activation_ready,false);assert.equal(plan.recipients,0);assert.equal(plan.updates.length,4);assert.deepEqual(f.flows,before);
 assert.equal(plan.updates.reduce((n,u)=>n+u.steps.length,0),6);
 for(const u of plan.updates){
  assert.equal(u.next.version,u.expected.version+1);assert.equal(u.next.published_version,u.next.version);assert.deepEqual(u.next.draft,u.next.published);assert.equal(u.next.enabled,u.expected.enabled);
  for(const field of ['binding','draft','published'])assert.deepEqual(u.next[field].steps.find(s=>s.key==='email:unchanged'),u.expected[field].steps.find(s=>s.key==='email:unchanged'));
  for(const step of u.next.binding.steps.filter(s=>u.steps.includes(s.key)))assert.equal(step.source_template_id,u.expected.binding.steps.find(s=>s.key===step.key).source_template_id);
 }
 const changed=clone(f.flows);changed[0].version++;assert.throws(()=>I.planStageSwitch(changed,cs),/version or draft changed/);
});
