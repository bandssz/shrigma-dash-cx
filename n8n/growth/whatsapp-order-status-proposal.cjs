'use strict';
const WAT=require('../../whatsapp-template-contract.js');
const MAPPINGS=require('./whatsapp-friendly-templates.json');
const HOSTS={aristo:'oaristocrata.com',fish:'fishermans.com.br'};
const SAMPLE_PATH='0/orders/EXEMPLOPEDIDO/authenticate?key=EXEMPLOCHAVE';
const TYPES=['pedido_pago','rastreio','rastreio_criado'];
function reviewedComponents(components){
 return (components||[]).map(c=>({type:c.type,...(c.format?{format:c.format}:{}),...(c.text!==undefined?{text:c.text}:{}),...(c.buttons?{buttons:c.buttons.map(b=>({type:b.type,text:b.text,...(b.url?{url:b.url}:{})}))}:{})}));
}
function buildProposal(catalogs){
 const result=[];
 for(const brand of ['aristo','fish']){
  const catalog=catalogs[brand];if(!Array.isArray(catalog))throw Error('Fresh catalog required for '+brand);
  const prefix=brand==='aristo'?'aristocrata':'fishermans';
  for(const type of TYPES){
   const name=prefix+'_'+type+'_claro_v1',target=name.replace(/_v1$/,'_v2');
   const rows=catalog.filter(t=>t.name===name&&t.brand===brand),t=rows[0];
   if(rows.length!==1||t.status!=='APPROVED'||t.category!=='UTILITY'||t.language!=='pt_BR')throw Error('Approved source changed: '+name);
   if(catalog.some(t=>t.name===target))throw Error('Target name already exists; review its content: '+target);
   const body=t.components.find(c=>c.type==='BODY'),head=t.components.find(c=>c.type==='HEADER'),foot=t.components.find(c=>c.type==='FOOTER'),buttons=t.components.find(c=>c.type==='BUTTONS')?.buttons;
   if(!body||head?.format!=='TEXT'||buttons?.length!==2||buttons[0].type!=='URL'||buttons[0].text!=='Acompanhar pedido'||!buttons[0].url.startsWith('https://conta.'+HOSTS[brand]+'/')||buttons[1].url!=='https://'+HOSTS[brand]+'/suporte')throw Error('Source content contract changed: '+name);
   const values=type==='pedido_pago'?['Cliente Exemplo','EXEMPLO123','Produto de exemplo x1','Endereço de exemplo']:type==='rastreio'?['Cliente Exemplo','CODIGOEXEMPLO','cliente@example.invalid']:['Cliente Exemplo','cliente@example.invalid'];
   const variableCount=WAT.vars(body.text).length;if(variableCount!==values.length)throw Error('Source variables changed');
   const draft={canal:'whatsapp',marca:brand,idioma:t.language,categoria:t.category,nome:target,peca:type==='pedido_pago'?'pedido-pago':'rastreio-criado',cabecalho:head.text,corpo:body.text,rodape:foot?.text||'',assunto:'',exemplos:Object.fromEntries(values.map((v,i)=>[String(i+1),v])),botoes:buttons.map((b,i)=>({tipo:'url',texto:b.text,valor:i===0?'https://'+HOSTS[brand]+'/{{1}}':b.url,...(i===0?{exemplo_url:'https://'+HOSTS[brand]+'/'+SAMPLE_PATH}:{})}))};
   const components=JSON.parse(JSON.stringify(t.components));
   components.find(c=>c.type==='BODY').example={body_text:[values]};
   const payload={name:target,language:t.language,category:t.category,components:WAT.components(draft,components)};
   if(WAT.errors(draft).length)throw Error('Proposed draft failed its contract');
   const mapping=MAPPINGS.find(m=>m.new_name===name&&m.brand===brand);if(!mapping)throw Error('Existing flow mapping missing');
   const oldUrl=new URL(buttons[0].url),tracking=Object.fromEntries([...oldUrl.searchParams].filter(([k])=>['utm_source','utm_medium','utm_campaign','utm_content'].includes(k)));
   result.push({brand,source_template_id:String(t.id),source_template_name:name,target_template_name:target,flow_key:mapping.flow_key,step_key:mapping.step_key,caller_template_id:mapping.old_id,draft,provider_payload:payload,caller_proposal:{enabled:false,piece:draft.peca,expected_components:reviewedComponents(payload.components),approved_template_id:null,approved_template_name:target,button_index:0,fixed_host:HOSTS[brand],source_field:'Shopify Order.statusPageUrl',tracking_from_existing_button:tracking,requires:['fresh APPROVED provider content equal to proposal','caller fetches exact order id and statusPageUrl','payment/cancellation guards stay active','motor switches source and URL component together','same actor/version/idempotency in existing draft workflow','natural delivery proof after rollout']}});
  }
 }
 return result;
}
// This accepts only the observed authenticated Shopify path, from the same
// GraphQL order. It preserves its opaque key; callers must never log the value.
function resolveOrderStatus(response,{brand,order_id,tracking={}}={}){
 const fail=reason=>({ok:false,reason});
 if(!HOSTS[brand]||!/^\d+$/.test(String(order_id)))return fail('pedido_referencia_invalida');
 if(!response||response.error||(Array.isArray(response.errors)&&response.errors.length))return fail('pedido_consulta_indisponivel');
 const order=response.data?.order;
 if(!order||order.id!=='gid://shopify/Order/'+order_id)return fail('pedido_divergente');
 if(order.test!==false||order.cancelledAt!==null)return fail('pedido_teste_cancelado_ou_desconhecido');
 const url=order.statusPageUrl,prefix='https://'+HOSTS[brand]+'/';
 if(typeof url!=='string'||!url.startsWith(prefix)||url.length>2000||/[\s<>"'\\{}#\u0000-\u001f]/.test(url))return fail('pedido_url_invalida');
 const suffix=url.slice(prefix.length),match=suffix.match(/^([1-9][0-9]*)\/orders\/[A-Za-z0-9]+\/authenticate\?(.+)$/);
 if(!match)return fail('pedido_url_formato_desconhecido');
 const pairs=match[2].split('&'),keys=[];
 for(const pair of pairs){
  const m=pair.match(/^([A-Za-z_][A-Za-z0-9_]*)=([^&]+)$/);
  if(!m||/%(?![0-9a-fA-F]{2})/.test(m[2])||keys.includes(m[1]))return fail('pedido_query_invalida');
  keys.push(m[1]);
 }
 if(keys.filter(k=>k==='key').length!==1)return fail('pedido_chave_ausente_ou_ambigua');
 let parameter=suffix;
 for(const [key,value] of Object.entries(tracking)){
  if(!['utm_source','utm_medium','utm_campaign','utm_content'].includes(key)||typeof value!=='string'||!/^[a-z0-9_-]{1,120}$/.test(value))return fail('pedido_taxonomia_invalida');
  if(!keys.includes(key))parameter+='&'+key+'='+encodeURIComponent(value);
 }
 return {ok:true,parameter};
}
function prepareCallerChange(input,response,proposal,approved){
 // Deliberately inert until the reviewed template is actually approved and
 // explicitly enabled. Publishing a draft or API acceptance is insufficient.
 if(proposal?.enabled!==true)return {applied:false,reason:'pedido_template_ainda_nao_ativado',input:JSON.parse(JSON.stringify(input))};
 if(!approved||approved.status!=='APPROVED'||approved.category!=='UTILITY'||approved.language!=='pt_BR'||String(approved.id)!==String(proposal.approved_template_id)||approved.name!==proposal.approved_template_name)return {applied:false,blocked:true,reason:'pedido_template_nao_aprovado'};
 if(input.flow!=='transacional'||input.piece!==proposal.piece||!['pedido-pago','rastreio-criado'].includes(input.piece)||WAT.isPix(input))return {applied:false,blocked:true,reason:'pedido_peca_incompativel'};
 if(JSON.stringify(reviewedComponents(approved.components))!==JSON.stringify(proposal.expected_components))return {applied:false,blocked:true,reason:'pedido_conteudo_aprovado_divergente'};
 if(input.piece==='pedido-pago'&&response?.data?.order?.displayFinancialStatus!=='PAID')return {applied:false,blocked:true,reason:'pedido_nao_pago'};
 const buttons=approved.components?.find(c=>c.type==='BUTTONS')?.buttons;
 if(buttons?.[0]?.url!=='https://'+HOSTS[input.brand]+'/{{1}}')return {applied:false,blocked:true,reason:'pedido_botao_incompativel'};
 const link=resolveOrderStatus(response,{brand:input.brand,order_id:input.ref,tracking:proposal.tracking_from_existing_button});
 if(!link.ok)return {applied:false,blocked:true,reason:link.reason};
 const out=JSON.parse(JSON.stringify(input));
 out.template_id=String(approved.id);out.template_name=approved.name;
 out.components=(out.components||[]).filter(c=>!(c.type==='button'&&String(c.index)==='0'));
 // The selected reviewed header is static text; legacy Fish paid caller has
 // an image header. Keep all variable body values, drop only incompatible media.
 const h=approved.components.find(c=>c.type==='HEADER');
 if(h?.format==='TEXT'&&!WAT.vars(h.text).length)out.components=out.components.filter(c=>c.type!=='header');
 out.components.push({type:'button',sub_type:'url',index:0,parameters:[{type:'text',text:link.parameter}]});
 const error=WAT.runtime(out,approved);if(error)return {applied:false,blocked:true,reason:error};
 return {applied:true,input:out};
}
module.exports={HOSTS,SAMPLE_PATH,reviewedComponents,buildProposal,resolveOrderStatus,prepareCallerChange};
