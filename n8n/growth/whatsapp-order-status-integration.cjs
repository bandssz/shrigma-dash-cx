'use strict';
// Pure preparation only. Generated workflows and reviewed provider copy stay private.
const M=require('./whatsapp-order-status-proposal.cjs');
const WAT=require('../../whatsapp-template-contract.js');
const HOSTS=M.HOSTS,resolveOrderStatus=M.resolveOrderStatus,reviewedComponents=M.reviewedComponents;
const clone=v=>JSON.parse(JSON.stringify(v));
const CALLER_MARKER='WA_ORDER_STATUS_SOURCE_V1';
const MOTOR_MARKER='WA_ORDER_STATUS_STAGE_V1';
const GUARD_MARKER='WA_ORDER_STATUS_APPROVED_CONTENT_V1';
function ensure(ok,message){if(!ok)throw Error(message);}
function same(a,b){return JSON.stringify(a)===JSON.stringify(b);}
function selected(rows,p){const found=rows.filter(x=>x.key===p.flow_key);ensure(found.length===1,'One current flow is required');return found[0];}
function captureOrderSource(response){
 const o=response?.data?.order;
 if(!o||response.error||(Array.isArray(response.errors)&&response.errors.length))return {error:true};
 // No customer text, phone, email, transaction values or full response copy.
 return {order:{id:o.id,test:o.test,cancelledAt:o.cancelledAt,displayFinancialStatus:o.displayFinancialStatus,statusPageUrl:o.statusPageUrl}};
}
function buildContracts(proposals,catalog,flows){
 ensure(Array.isArray(proposals)&&proposals.length>0&&proposals.length<=6,'Reviewed proposals are required');
 ensure(Array.isArray(catalog)&&Array.isArray(flows),'Fresh catalog and flow definitions are required');
 const keys=new Set(),ids=new Set();
 return proposals.map(p=>{
  ensure(['aristo','fish'].includes(p.brand)&&['pedido-pago','rastreio-criado'].includes(p.draft?.peca)&&!WAT.isPix(p.draft),'Only reviewed order pieces are allowed');
  ensure(p.caller_proposal?.enabled===false&&p.caller_proposal.approved_template_id===null,'Source proposal must still be disabled');
  const f=selected(flows,p),s=f.published?.steps?.filter(x=>x.key===p.step_key),b=f.binding?.steps?.filter(x=>x.key===p.step_key);
  ensure(f.runtime_ready===true&&Number.isSafeInteger(f.version)&&f.version===f.published_version&&same(f.draft,f.published),'Unpublished or unavailable flow must be reviewed');
  ensure(s?.length===1&&b?.length===1&&String(s[0].template_id)===p.source_template_id&&s[0].template_name===p.source_template_name&&String(b[0].template_id)===p.source_template_id,'Published source changed');
  ensure(s[0].channel==='whatsapp'&&s[0].piece===p.draft.peca&&s[0].flow==='transacional','Published stage contract changed');
  if(b[0].source_template_id)ensure(String(b[0].source_template_id)===p.caller_template_id,'Caller selector changed');
  const targets=catalog.filter(t=>t.brand===p.brand&&t.name===p.target_template_name),sources=catalog.filter(t=>t.brand===p.brand&&String(t.id)===p.source_template_id);
  ensure(targets.length===1&&sources.length===1,'Current source and unique new template are required');
  const t=targets[0],source=sources[0];
  ensure(t.status==='APPROVED'&&t.category==='UTILITY'&&t.language==='pt_BR'&&/^\d+$/.test(String(t.id)),'New template must be APPROVED UTILITY pt_BR');
  ensure(source.status==='APPROVED'&&source.category==='UTILITY'&&source.language==='pt_BR'&&source.name===p.source_template_name,'Source approval changed');
  ensure(same(reviewedComponents(t.components),p.caller_proposal.expected_components),'Approved content differs from reviewed proposal');
  const sourceContent=reviewedComponents(source.components),buttons=sourceContent.find(c=>c.type==='BUTTONS')?.buttons;
  ensure(buttons?.length===2&&buttons[0].url?.startsWith('https://conta.'+HOSTS[p.brand]+'/'),'Source button changed');
  buttons[0].url='https://'+HOSTS[p.brand]+'/{{1}}';
  ensure(same(sourceContent,p.caller_proposal.expected_components),'Source text or support changed');
  ensure(t.components.find(c=>c.type==='BUTTONS')?.buttons?.[0]?.url==='https://'+HOSTS[p.brand]+'/{{1}}','New dynamic order button changed');
  const key=p.flow_key+'|'+p.step_key;
  ensure(!keys.has(key)&&!ids.has(String(t.id)),'Duplicate stage or provider ID');keys.add(key);ids.add(String(t.id));
  return {brand:p.brand,flow_key:p.flow_key,step_key:p.step_key,source_version:f.version,source_template_id:p.source_template_id,source_template_name:p.source_template_name,caller_template_id:p.caller_template_id,piece:p.draft.peca,tracking:clone(p.caller_proposal.tracking_from_existing_button),target:{id:String(t.id),name:t.name,status:t.status,language:t.language,category:t.category,components:reviewedComponents(t.components)}};
 });
}
function applyOrderStatusStage(input,config,result,contracts){
 const out={...result};delete out._order_status_source;
 if(out._flow_block)return out;
 const matches=contracts.filter(c=>c.target.id===String(out.template_id)||c.target.name===out.template_name);
 if(!matches.length)return out; // Current static/carrier/PIX behavior remains unchanged.
 const fail=reason=>({...out,_flow_block:reason});
 if(matches.length!==1)return fail('pedido_contrato_ambiguo');
 const c=matches[0];
 if(config?._managed!==true||config._allowed!==true||config._flow_key!==c.flow_key||config.key!==c.step_key||!Number.isSafeInteger(config._version)||config._version<c.source_version+1)return fail('pedido_estagio_nao_publicado');
 if(input.brand!==c.brand||input.flow!=='transacional'||input.piece!==c.piece||String(input.template_id)!==c.caller_template_id||out.template_id!==c.target.id||out.template_name!==c.target.name||input.language!=='pt_BR')return fail('pedido_estagio_divergente');
 const src=input._order_status_source;
 if(!src||src.error)return fail('pedido_fonte_ausente');
 const o=src.order;
 if(c.piece==='pedido-pago'&&o?.displayFinancialStatus!=='PAID')return fail('pedido_nao_pago');
 if(c.piece==='rastreio-criado'&&!['PENDING','AUTHORIZED','PARTIALLY_PAID','PAID','PARTIALLY_REFUNDED'].includes(o?.displayFinancialStatus))return fail('pedido_estado_financeiro_invalido');
 const link=resolveOrderStatus({data:{order:o}},{brand:input.brand,order_id:input.ref,tracking:c.tracking});
 if(!link.ok)return fail(link.reason);
 if(!Array.isArray(input.components))return fail('pedido_componentes_ausentes');
 // Use original producer components, selected identity and source URL in one
 // decision. The subsequent live Meta guard validates the complete contract.
 out.components=cloneOrderComponents(input.components).filter(x=>!(x.type==='button'&&String(x.index)==='0'));
 const header=c.target.components.find(x=>x.type==='HEADER');
 if(header?.format==='TEXT'&&!/\{\{/.test(header.text||''))out.components=out.components.filter(x=>x.type!=='header');
 out.components.push({type:'button',sub_type:'url',index:0,parameters:[{type:'text',text:link.parameter}]});
 return out;
}
function cloneOrderComponents(cs){return JSON.parse(JSON.stringify(cs));}
function approvedOrderContentError(input,template,contracts){
 const matches=contracts.filter(c=>c.target.id===String(input.template_id)||c.target.name===input.template_name);
 if(!matches.length)return null;
 if(matches.length!==1)return 'pedido_contrato_ambiguo';
 const c=matches[0];
 if(input.brand!==c.brand||input.flow!=='transacional'||input.piece!==c.piece||String(input.template_id)!==c.target.id||input.template_name!==c.target.name)return 'pedido_template_divergente';
 if(!template||!Array.isArray(template.components)||String(template.id)!==c.target.id||template.name!==c.target.name||template.status!=='APPROVED'||template.category!=='UTILITY'||template.language!=='pt_BR'||JSON.stringify(reviewedComponents(template.components))!==JSON.stringify(c.target.components))return 'pedido_conteudo_aprovado_divergente';
 return null;
}
function workflowCopy(fresh,expectedVersionId){ensure(fresh&&Array.isArray(fresh.nodes)&&expectedVersionId&&fresh.versionId===expectedVersionId,'Fresh workflow and matching version required');return clone(fresh);}
function codeNode(w,name){const a=w.nodes.filter(n=>n.name===name);ensure(a.length===1&&a[0].type==='n8n-nodes-base.code'&&typeof a[0].parameters?.jsCode==='string','Expected code node '+name);return a[0];}
function once(code,old,replacement){ensure(code.split(old).length===2,'Source changed; inspect fresh export');return code.replace(old,replacement);}
function patchCaller(fresh,{expectedVersionId,brand}={}){
 ensure(['aristo','fish'].includes(brand),'Brand required');const workflow=workflowCopy(fresh,expectedVersionId),changes=[];
 const route=codeNode(workflow,'Roteia evento → peça'),mount=codeNode(workflow,'Monta componentes');
 const prefix='// '+CALLER_MARKER+'\n'+captureOrderSource.toString()+'\n';
 const field='_order_status_source: captureOrderSource(item.json),';
 if(mount.parameters.jsCode.includes(CALLER_MARKER)){
  const qs=[...route.parameters.jsCode.matchAll(/const GQL(?:_PAID)? = '([^']+)';/g)];
  ensure(mount.parameters.jsCode.startsWith(prefix)&&mount.parameters.jsCode.split(field).length===2&&qs.length===(brand==='aristo'?2:1)&&qs.every(q=>q[1].includes('statusPageUrl')&&/order\(id: \$id\) \{ (?:id statusPageUrl|statusPageUrl id) /.test(q[1])),'Unrecognized order source patch');return {workflow,changes};
 }
 ensure(mount.parameters.jsCode.includes('WA_TRACKING_SOURCE_PATH_V1'),'Current tracking guard required');
 ensure(brand==='fish'?mount.parameters.jsCode.includes('WA_FISH_TRANSACTION_GUARD_V1'):mount.parameters.jsCode.includes('evaluatePaidCutover(item.json, cfg, Date.now())'),'Current financial guard required');
 let queryCount=0;
 route.parameters.jsCode=route.parameters.jsCode.replace(/const GQL(?:_PAID)? = '([^']+)';/g,(line,query)=>{
  ensure(!query.includes('statusPageUrl'),'Unexpected query contract');queryCount++;
  const start='order(id: $id) { ';ensure(query.includes(start),'Order query contract changed');
  const rest=query.split(start)[1];return line.replace(start,start+(rest.startsWith('id ')?'':'id ')+'statusPageUrl ');
 });
 ensure(queryCount===(brand==='aristo'?2:1),'Expected all caller order queries');
 const anchor=brand==='fish'?"flow: 'transacional', piece: r.piece, ref: r.order_id, email: r.email,":"flow:'transacional',piece:r.piece,ref:r.order_id,email:r.email,";
 mount.parameters.jsCode=prefix+once(mount.parameters.jsCode,anchor,anchor+'\n    '+field);
 changes.push({node:route.name,field:'jsCode'},{node:mount.name,field:'jsCode'});return {workflow,changes};
}
function patchMotor(fresh,{expectedVersionId,contracts}={}){
 ensure(Array.isArray(contracts)&&contracts.length>0&&contracts.every(c=>c.target?.status==='APPROVED'),'Approved contracts required');
 const workflow=workflowCopy(fresh,expectedVersionId),changes=[],apply=codeNode(workflow,'Aplica fluxo publicado'),guard=codeNode(workflow,'Valida template UTILITY');
 ensure(codeNode(workflow,'Interpreta resposta').parameters.jsCode.includes('WA_UNCERTAIN_RESERVATION_V1'),'Current uncertain reservation guard required');
 const definitions='const ORDER_STATUS_CONTRACTS='+JSON.stringify(contracts)+';\nconst HOSTS='+JSON.stringify(HOSTS)+';\n'+resolveOrderStatus.toString()+'\n'+cloneOrderComponents.toString()+'\n'+applyOrderStatusStage.toString()+'\n';
 const extra='// '+MOTOR_MARKER+'\n'+definitions;
 const old="return {json:applyPublishedStage($('Chamado por outro workflow').item.json,$json.config)};";
 const replacement="const orderInput=$('Chamado por outro workflow').item.json;\nreturn {json:applyOrderStatusStage(orderInput,$json.config,applyPublishedStage(orderInput,$json.config),ORDER_STATUS_CONTRACTS)};";
 const guardPrefix='// '+GUARD_MARKER+'\nconst ORDER_STATUS_CONTRACTS='+JSON.stringify(contracts)+';\n'+reviewedComponents.toString()+'\n'+approvedOrderContentError.toString()+'\n';
 if(apply.parameters.jsCode.includes(MOTOR_MARKER)||guard.parameters.jsCode.includes(GUARD_MARKER)){
  ensure(apply.parameters.jsCode.startsWith(extra)&&apply.parameters.jsCode.includes(replacement)&&guard.parameters.jsCode.startsWith(guardPrefix)&&guard.parameters.jsCode.includes('approvedOrderContentError(input,response.body,ORDER_STATUS_CONTRACTS)||WAT.runtime(input,response.body)'),'Unrecognized or different order integration');return {workflow,changes};
 }
 apply.parameters.jsCode=extra+once(apply.parameters.jsCode,old,replacement);
 guard.parameters.jsCode=guardPrefix+once(guard.parameters.jsCode,'WAT.runtime(input,response.body)','approvedOrderContentError(input,response.body,ORDER_STATUS_CONTRACTS)||WAT.runtime(input,response.body)');
 changes.push({node:apply.name,field:'jsCode'},{node:guard.name,field:'jsCode'});return {workflow,changes};
}
function planStageSwitch(flows,contracts){
 const updates=[];
 for(const key of [...new Set(contracts.map(c=>c.flow_key))]){
  const cs=contracts.filter(c=>c.flow_key===key),found=flows.filter(f=>f.key===key);ensure(found.length===1,'Current flow required');
  const f=found[0];ensure(f.version===f.published_version&&cs.every(c=>c.source_version===f.version)&&same(f.draft,f.published)&&f.runtime_ready===true,'Stage version or draft changed');
  const next=clone(f);
  for(const field of ['binding','draft','published'])for(const c of cs){
   const matches=next[field].steps.filter(s=>s.key===c.step_key);ensure(matches.length===1,'Stage missing');const s=matches[0];
   ensure(String(s.template_id)===c.source_template_id&&s.template_name===c.source_template_name,'Stage source changed');
   const sig=s.signature?.find(x=>x.type==='BUTTONS');ensure(sig?.buttons?.[0]?.url?.startsWith('https://conta.'+HOSTS[c.brand]+'/'),'Source signature changed');
   s.template_id=c.target.id;s.template_name=c.target.name;s.category='UTILITY';sig.buttons[0].url='https://'+HOSTS[c.brand]+'/{{1}}';
  }
  next.version=f.version+1;next.published_version=next.version;
  updates.push({key,expected:clone(f),next,steps:cs.map(c=>c.step_key)});
 }
 return {updates,activation_ready:false,required_gates:['fresh approved exact provider content','caller and motor active readback exact','unchanged expected rows under transaction locks','validate every new definition against new binding','atomic all-row compare-and-swap with revision and audit','same mutation key after uncertainty; no automatic new attempt'],recipients:0};
}
module.exports={captureOrderSource,buildContracts,applyOrderStatusStage,approvedOrderContentError,patchCaller,patchMotor,planStageSwitch,CALLER_MARKER,MOTOR_MARKER,GUARD_MARKER};
