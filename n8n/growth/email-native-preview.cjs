'use strict';
// Pure CRM23 preparation and verification. The only native descriptor is /templates/preview.
// Credentials, recipient selection, claims and transport are outside this module.
const ENP=(()=>{
 const POLICY='crm_email_native_preview_v1',PROFILE='crm_email_synthetic_v1';
 const RECIPIENT='felipebandeira@oaristocrata.com',PREFIX='✅ FINAL — ';
 const fail=code=>Object.assign(new Error(code),{code});
 const copy=x=>JSON.parse(JSON.stringify(x));
 const simple=/^\.Tx\.Data\.[A-Za-z][A-Za-z0-9_]{0,63}$/;
 const forbiddenKeys=new Set(['__proto__','prototype','constructor']);
 function profile(brand){
  if(!['fish','aristo'].includes(brand))throw fail('brand_unavailable');
  const name=brand==='fish'?'Fishermans':'O Aristocrata',url=brand==='fish'?'https://fishermans.com.br':'https://oaristocrata.com';
  return {first_name:'Felipe',name:'Felipe',nome:'Felipe',brand:name,brand_name:name,store_url:url,shop_url:url,
   address:'Endereço fictício para revisão',cancel_reason:'Exemplo de cancelamento',carrier:'Transportadora de exemplo',checkout_url:'https://example.invalid/checkout',coupon_code:'EXEMPLO',coupon_heading:'Cupom de exemplo',coupon_text:'Benefício fictício',coupon_value:'R$ 10,00',cta_text:'Ver exemplo',delivered_at:'01/01/2026',delivered_by:'Recebedor fictício',delivery_estimate:'Data ilustrativa',e:'synthetic@example.invalid',has_discount:true,headline:'Exemplo de mensagem',items_count:2,last_update:'01/01/2026',nps_url:'https://example.invalid/nps',order_number:'EXEMPLO-001',order_url:'https://example.invalid/order',p:'synthetic-token-not-valid',paragraph_1:'Primeiro parágrafo de exemplo',paragraph_2:'Segundo parágrafo de exemplo',paragraph_3:'Terceiro parágrafo de exemplo',paragraph_4:'Quarto parágrafo de exemplo',payment_deadline:'01/01/2026',payment_method:'Pagamento fictício',preheader:'Resumo fictício para revisão',refund_method:'Forma de estorno fictícia',refund_status:'Estorno ilustrativo',review_url:'https://example.invalid/review',s:'synthetic-signature-not-valid',shipping_label:'Frete de exemplo',shipping_name:'Destinatário fictício',shipping_value:'R$ 10,00',status:'Estado ilustrativo',subtotal:'R$ 90,00',total:'R$ 100,00',tracking_company:'Transportadora de exemplo',tracking_number:'EXEMPLO-RASTREIO',tracking_status:'Status fictício',tracking_updated_at:'01/01/2026',tracking_url:'https://example.invalid/tracking',urgency_text:'Prazo ilustrativo',urgency_title:'Informação de exemplo',
   items:[{image:'https://example.invalid/item-one.png',name:'Item de exemplo A',title:'Item de exemplo A',price:'R$ 30,00',qty:1,quantity:1,variant:'Variação ilustrativa'},{image:'https://example.invalid/item-two.png',name:'Item de exemplo B',title:'Item de exemplo B',price:'R$ 60,00',qty:1,quantity:1,variant:'Variação ilustrativa'}]};
 }
 function parseDraft(r,{GEC,GEE}={}){
  if(r?.canal!=='email'||!['fish','aristo'].includes(r.marca))throw fail('brand_unavailable');
  if(!GEC||!GEE||!GEC.hasEnvelope(r)||GEC.envelopeErrors(r).length||GEC.documentErrors(r).length)throw fail('email_envelope_required');
  const payload=GEC.payload(r),body=GEE.parse(payload.body,{html:true}),subject=GEE.parse(payload.subject,{html:false});
  if(!body.ok||!subject.ok)throw fail('unsupported_template_expression');
  // Existing simple subject fields stay supported. The 33 audited legacy subjects are literal.
  for(const match of payload.subject.matchAll(/\{\{([\s\S]*?)\}\}/g))if(!simple.test(match[1].trim()))throw fail('unsupported_subject_expression');
  const fields=[...new Set([...body.fields,...subject.fields])],keys=[...new Set([...body.keys,...subject.keys])];
  if(fields.some(k=>typeof k!=='string')||keys.some(k=>typeof k!=='string'||forbiddenKeys.has(k)))throw fail('unsupported_template_expression');
  return {payload,fields,keys,requires_subscriber:fields.some(f=>f.startsWith('.Subscriber.'))};
 }
 function prepare(r,deps,{purpose='illustrative',subscriber=null}={}){
  try{
   if(!['illustrative','compile','test'].includes(purpose))throw fail('preview_context_invalid');
   const parsed=parseDraft(r,deps),all=profile(r.marca),data={};
   for(const key of parsed.keys){if(!Object.hasOwn(all,key))throw fail('unsupported_test_variable');data[key]=copy(all[key]);}
   let sub={Name:'',UUID:''},subscriber_context='external';
   if(parsed.requires_subscriber){
    if(purpose==='test'){
     if(!subscriber||subscriber.email!==RECIPIENT||typeof subscriber.name!=='string'||subscriber.name.length>255||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(subscriber.uuid||''))throw fail('recipient_identity_unavailable');
     sub={Name:subscriber.name,UUID:subscriber.uuid};subscriber_context='fixed_recipient';
    }else{sub={Name:'Assinante fictício',UUID:'00000000-0000-4000-8000-000000000001'};subscriber_context='synthetic';}
   }
   // Serialize only our fixed synthetic profile and typed recipient fields.
   // Caller drafts/contexts never receive a normalization bypass.
   const context={Tx:{Data:data},Subscriber:sub},contextJSON=JSON.stringify(context),check=deps.GEE.validateContextJSON(contextJSON);
   if(!check.ok){
    const codes=['EMAIL_CONTEXT_JSON','EMAIL_CONTEXT_SHAPE','EMAIL_CONTEXT_FIELD','EMAIL_CONTEXT_TYPE','EMAIL_CONTEXT_ITEMS','EMAIL_CONTEXT_URL','EMAIL_CONTEXT_SUBSCRIBER','EMAIL_CONTEXT_LIMIT'];
    const diagnostic=deps.GEE.diagnoseContext(context);
    return {eligible:false,code:'preview_context_invalid',contract:POLICY,context_diagnostic:{...diagnostic,validation_code:codes.includes(check.errors?.[0]?.code)?check.errors[0].code:'CONTEXT_VALIDATION_FAILED'}};
   }
   const source=deps.GEE.buildPreviewEnvelopeJSON(parsed.payload.body,contextJSON),subject=parsed.payload.subject.replace(/\{\{\s*\.Tx\.Data\.([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g,(_,k)=>{if(typeof data[k]!=='string'&&typeof data[k]!=='number')throw fail('unsupported_subject_variable');return String(data[k]);});
   const material={policy:POLICY,profile:PROFILE,brand:r.marca,subject:parsed.payload.subject,from_email:r.from_email,reply_to:r.reply_to,preheader:r.preheader,body:parsed.payload.body,context:check.value};
   if(typeof deps.digest!=='function')throw fail('preview_hash_unavailable');
   const source_hash=deps.digest(material);if(!/^[a-f0-9]{64}$/.test(source_hash))throw fail('preview_hash_unavailable');
   return {eligible:true,code:'ready',contract:POLICY,profile:PROFILE,purpose,brand:r.marca,subject,source_hash,data,subscriber_context,requires_subscriber:parsed.requires_subscriber,context:check.value,source:parsed.payload,request:{method:'POST',path:'/api/templates/preview',form:{template_type:'tx',body:source}}};
  }catch(e){return {eligible:false,code:e.code||'preview_unavailable',contract:POLICY};}
 }
 function accept(prepared,response,{GEC}={}){
  if(prepared?.eligible!==true)return prepared||{eligible:false,code:'preview_unavailable',contract:POLICY};
  const html=response?.body;
  if(response?.statusCode!==200||typeof html!=='string'||!html.trim()||html.length>400000)return {eligible:false,code:'native_preview_unconfirmed',contract:POLICY};
  if(!GEC||GEC.htmlSafety(html)||html.includes('#ZgotmplZ')||html.includes('{{'))return {eligible:false,code:'native_preview_unsafe',contract:POLICY};
  return {eligible:true,code:'ready',contract:POLICY,profile:PROFILE,brand:prepared.brand,subject:prepared.subject,body_html:html,data:copy(prepared.data),subscriber_context:prepared.subscriber_context,source_hash:prepared.source_hash};
 }
 function needsNativeTest(r,{GEC,GEE}={}){
  const parsed=parseDraft(r,{GEC,GEE}),oldKeys=new Set(['first_name','name','nome','brand','brand_name','store_url','shop_url']);
  return parsed.requires_subscriber||parsed.keys.some(k=>!oldKeys.has(k))||!GEC.variablesInText(parsed.payload.body)||[parsed.payload.body,parsed.payload.subject].some(s=>[...s.matchAll(/\{\{([\s\S]*?)\}\}/g)].some(m=>!simple.test(m[1].trim())));
 }
 return {POLICY,PROFILE,RECIPIENT,PREFIX,profile,parseDraft,prepare,accept,needsNativeTest};
})();
module.exports=ENP;
