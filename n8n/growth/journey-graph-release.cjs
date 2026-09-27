/* Trusted preparation and typed data binding only. Never renders Go or calls Listmonk. */
'use strict';
const GEE=require('../../growth-email-expressions.js'),GEC=require('../../growth-email-contract.js');
const VERSION='journey_graph_release_v1',ENABLED=false,copy=x=>JSON.parse(JSON.stringify(x));
const OBSERVED_VERSION='journey_graph_release_v2',PURCHASE_POLICY=Object.freeze({version:'cart_customer_order_observation_v1',field:'purchase.observed_for_cart',max_age_seconds:5});
const own=(x,k)=>Object.prototype.hasOwnProperty.call(x,k),fail=code=>{throw Object.assign(Error(code),{code});};
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(x);
const stable=x=>Array.isArray(x)?x.map(stable):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,stable(x[k])])):x;
const same=(a,b)=>JSON.stringify(stable(a))===JSON.stringify(stable(b));
// Existing cart emitter Config + Monta payload, read-only evidence dated 25/26 September.
// Deployment must reconfirm these sender/routing values; this is not a live cache attestation.
const PROFILES=Object.freeze({fish:{from_email:'Fishermans <contato@fishermans.com.br>',reply_to:'contato@fishermans.com.br'},aristo:{from_email:'O Aristocrata <contato@oaristocrata.com>',reply_to:'contato@oaristocrata.com'}});
const FACTS=Object.freeze({first_name:'contact.first_name',checkout_url:'cart.checkout_url',items:'cart.items',total:'cart.total'});
const itemFields=new Set(['image','name','price','qty','quantity','title','variant']);
function literalDefault(parsed,path){
 const uses=parsed.actions.filter(a=>a.tokens.some(t=>t.type==='field'&&t.value===path));
 if(!uses.length||uses.some(a=>a.kind!=='output'||a.expression?.type!=='default'||a.expression.value.path!==path||a.expression.fallback.type!=='string'))fail('GRAPH_RELEASE_VARIABLE_UNSUPPORTED');
 const values=[...new Set(uses.map(a=>a.expression.fallback.value))];if(values.length!==1||!values[0])fail('GRAPH_RELEASE_DEFAULT_AMBIGUOUS');return values[0];
}
function prepareMaterial(source,{purchasePolicy}={}){
 if(purchasePolicy!==undefined&&purchasePolicy!==PURCHASE_POLICY.version)fail('GRAPH_RELEASE_POLICY_INVALID');
 const b=source?.brand,profile=PROFILES[b],t=source?.native;
 if(!profile||!t||t.type!=='tx'||source.binding!=='email.template.'+source.template_id||!/^snapshot_[a-f0-9]{48}$/.test(source.source_snapshot||'')||source.slot?.key!=='email:carrinho-30min'||String(source.slot.template_id)!==String(source.template_id)||source.slot.enabled!==true)fail('GRAPH_RELEASE_SOURCE_INVALID');
 if(typeof t.subject!=='string'||!t.subject.trim()||t.subject.length>200||/[\r\n\x00-\x1f\x7f]/.test(t.subject)||typeof t.body!=='string'||!t.body.trim())fail('GRAPH_RELEASE_CONTENT_INVALID');
 const body=GEE.parse(t.body,{html:true}),subject=GEE.parse(t.subject);
 if(!body.ok||!subject.ok||GEC.htmlSafety(t.body))fail('GRAPH_RELEASE_CONTENT_INVALID');
 // Native subject expansion is intentionally not reimplemented or assumed.
 if(subject.actions.length)fail('GRAPH_RELEASE_SUBJECT_DYNAMIC');
 const variables={},required=new Set(),requiredItems=new Set();let preheader;
 for(const path of body.fields){
  if(path==='.Subscriber.UUID'){variables[path]={kind:'identity',path:'subject_id'};continue;}
  if(path.startsWith('.Subscriber.'))fail('GRAPH_RELEASE_VARIABLE_UNSUPPORTED');
  if(!path.startsWith('.Tx.Data.')){const field=path.slice(1);if(!itemFields.has(field))fail('GRAPH_RELEASE_VARIABLE_UNSUPPORTED');requiredItems.add(field);continue;}
  const key=path.slice(9);
  if(FACTS[key]){variables[path]={kind:'fact',path:FACTS[key]};required.add(FACTS[key]);continue;}
  if(key==='preheader'||key==='order_number'){
   const value=literalDefault(body,path);variables[path]={kind:'template_default',value};if(key==='preheader')preheader=value;continue;
  }
  fail('GRAPH_RELEASE_VARIABLE_UNSUPPORTED');
 }
 if(!preheader)fail('GRAPH_RELEASE_PREHEADER_REQUIRED');
 if(GEC.envelopeErrors({canal:'email',marca:b,...profile,preheader}).length)fail('GRAPH_RELEASE_ENVELOPE_INVALID');
 const other=b==='fish'?'oaristocrata.com':'fishermans.com.br';
 const brandText=(t.body+'\n'+t.subject+'\n'+body.literals.filter(x=>x.type==='string').map(x=>x.value).join('\n')).replace(/&#(x[0-9a-f]+|[0-9]+);?/gi,(_,n)=>{const hex=n[0].toLowerCase()==='x',cp=parseInt(hex?n.slice(1):n,hex?16:10);return cp<=0x10ffff?String.fromCodePoint(cp):'';}).toLowerCase();
 if(brandText.includes(other))fail('GRAPH_RELEASE_CROSS_BRAND');
 // Reuse the actual native unsubscribe route. A replacement host/path or empty
 // Subscriber UUID must never silently turn an operational release into a linkless one.
 const unsubscribe=body.attributes.filter(a=>a.name==='href'&&t.body.slice(a.valueStart,a.valueEnd).includes('.Subscriber.UUID'));
 if(!unsubscribe.length||unsubscribe.some(a=>!/^https:\/\/email\.shrigma\.com\.br\/subscription\/00000000-0000-0000-0000-000000000000\/\{\{\s*\.Subscriber\.UUID\s*\}\}$/.test(t.body.slice(a.valueStart,a.valueEnd))))fail('GRAPH_RELEASE_UNSUBSCRIBE_REQUIRED');
 if(!required.has('cart.items')||!required.has('cart.checkout_url'))fail('GRAPH_RELEASE_CART_FIELDS_REQUIRED');
 return {version:purchasePolicy?OBSERVED_VERSION:VERSION,...(purchasePolicy?{purchase_policy:copy(PURCHASE_POLICY)}:{}),brand:b,binding:source.binding,source_snapshot:source.source_snapshot,source_template_id:source.template_id,
  envelope:{...profile,preheader},native:copy(t),variables,required_fields:[...required].sort(),required_item_fields:[...requiredItems].sort(),required_identity:['subject_id'],
  tracking:{version:'cart_email_utm_v1',field:'checkout_url',source:'email',medium:'fluxo',campaign:b+'-carrinho',content:'carrinho-30min'},
  readiness:{snapshot_only:true,native_cache_bound:false,transport:false}};
}
function checkMaterial(m){
 if(![VERSION,OBSERVED_VERSION].includes(m?.version)||!PROFILES[m.brand]||m.readiness?.transport!==false||m.readiness?.native_cache_bound!==false)fail('GRAPH_RELEASE_INVALID');
 if(m.version===OBSERVED_VERSION&&!same(m.purchase_policy,PURCHASE_POLICY))fail('GRAPH_RELEASE_POLICY_INVALID');
 const source={brand:m.brand,binding:m.binding,source_snapshot:m.source_snapshot,template_id:m.source_template_id,native:m.native,slot:{key:'email:carrinho-30min',template_id:String(m.source_template_id),enabled:true}};
 if(!same(prepareMaterial(source,{purchasePolicy:m.version===OBSERVED_VERSION?PURCHASE_POLICY.version:undefined}),m))fail('GRAPH_RELEASE_INVALID');return m;
}
function checkoutURL(raw,m){
 let u;try{u=new URL(raw);}catch{fail('GRAPH_RELEASE_CHECKOUT_INVALID');}
 const domain=GEC.BRANDS[m.brand].domain;
 if(u.protocol!=='https:'||u.hostname!==domain&&u.hostname!=='www.'+domain||u.username||u.password||u.port||u.hash||/[\s\\<>"'`{}]/.test(raw))fail('GRAPH_RELEASE_CHECKOUT_INVALID');
 for(const k of [...u.searchParams.keys()])if(/^utm_/i.test(k))u.searchParams.delete(k);
 const t=m.tracking;for(const k of ['source','medium','campaign','content'])u.searchParams.set('utm_'+k,t[k]);return u.href;
}
function materialize(material,source,{now}={}){
 const m=checkMaterial(material),at=Date.parse(now),observed=Date.parse(source?.observed_at);
 if(!Number.isFinite(at)||!Number.isFinite(observed)||at<observed||at-observed>300000||source?.version!=='journey_source_v1'||typeof source.source_revision!=='string'||!source.source_revision||typeof source.event_id!=='string'||!source.event_id||source?.brand!==m.brand||source.trigger!=='cart.abandoned'||!uuid(source.subject_id)||!uuid(source.source_ref)||source.complete!==true||source.eligible!==true||source.consent!==true||source.suppressed!==false)fail('GRAPH_RELEASE_SOURCE_UNCONFIRMED');
 if(m.version===OBSERVED_VERSION){const f=source.facts?.[PURCHASE_POLICY.field],seen=Date.parse(f?.observed_at),consent=source.facts?.['contact.email_allowed'];if(source.facts?.['purchase.confirmed']?.value===true||f?.value!==false||f.complete!==true||!Number.isFinite(seen)||seen>at||at-seen>PURCHASE_POLICY.max_age_seconds*1000||Object.keys(f).some(k=>!['value','complete','observed_at'].includes(k)))fail('GRAPH_RELEASE_PURCHASE_UNCONFIRMED');if(consent?.value!==true||consent.complete!==true||consent.observed_at!==f.observed_at||Object.keys(consent).some(k=>!['value','complete','observed_at'].includes(k)))fail('GRAPH_RELEASE_SOURCE_UNCONFIRMED');}
 const data={},subscriber={Name:'',UUID:source.subject_id};
 for(const [path,map]of Object.entries(m.variables)){
  if(map.kind==='identity')continue;const key=path.slice(9);
  if(map.kind==='template_default'){data[key]=map.value;continue;}
  const f=source.facts?.[map.path],time=Date.parse(f?.observed_at);
  if(!f||f.complete!==true||!own(f,'value')||f.value===null||!Number.isFinite(time)||time>at||at-time>300000)fail('GRAPH_RELEASE_FACT_UNCONFIRMED');
  data[key]=copy(f.value);
 }
 if(data.items!==undefined){if(!Array.isArray(data.items)||!data.items.length||data.items.length>20)fail('GRAPH_RELEASE_ITEMS_INVALID');
  for(const item of data.items){if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).some(k=>!itemFields.has(k))||m.required_item_fields.some(k=>!own(item,k)||item[k]===null))fail('GRAPH_RELEASE_ITEM_FIELD_MISSING');for(const k of ['qty','quantity'])if(own(item,k)&&(!Number.isSafeInteger(item[k])||item[k]<=0))fail('GRAPH_RELEASE_ITEMS_INVALID');}
 }
 if(typeof data.checkout_url!=='string'||!data.checkout_url)fail('GRAPH_RELEASE_CHECKOUT_INVALID');data.checkout_url=checkoutURL(data.checkout_url,m);
 const checked=GEE.validateContextJSON(JSON.stringify({Tx:{Data:data},Subscriber:subscriber}));if(!checked.ok)fail('GRAPH_RELEASE_CONTEXT_INVALID');
 // Return data only to the trusted dispatcher; no PII belongs in a receipt/log.
 return {brand:m.brand,binding:m.binding,source_ref:source.source_ref,source_revision:source.source_revision,context:checked.value,subject:m.native.subject,...copy(m.envelope),tracking:copy(m.tracking),transport:false};
}
// Public catalog descriptor: no HTML, addresses, data values or native payload.
// The full immutable snapshot remains in the trusted candidate release store.
function catalogMessage(release){
 const m=checkMaterial(release?.material);
 if(!uuid(release.id)||!same(release.brand,m.brand)||release.binding!==m.binding||release.source_snapshot!==m.source_snapshot||release.source_template_id!==m.source_template_id||!/^[a-f0-9]{64}$/.test(release.material_sha256||''))fail('GRAPH_RELEASE_INVALID');
 const observed=m.version===OBSERVED_VERSION;
 return {key:m.binding,brand:m.brand,channel:'email',available:true,release:'release_'+release.id,required_fields:['contact.email_allowed',observed?PURCHASE_POLICY.field:'purchase.confirmed'],material:{version:observed?'cart_email_material_v2':'cart_email_material_v1',...(observed?{purchase_policy:copy(PURCHASE_POLICY)}:{}),release_id:release.id,material_sha256:release.material_sha256,trigger:'cart.abandoned',fields:m.required_fields.map(key=>({key,type:key==='cart.items'?'cart_items':'string',max_age_seconds:300,item_fields:key==='cart.items'?copy(m.required_item_fields):[]}))}};
}
function bindCatalog(catalog,releases){
 if(!catalog||!PROFILES[catalog.brand]||!Array.isArray(catalog.messages)||!Array.isArray(releases)||releases.length>64)fail('GRAPH_RELEASE_CATALOG_INVALID');
 const next=copy(catalog),bound=new Set();
 for(const r of releases){const m=catalogMessage(r),i=next.messages.findIndex(x=>x.key===m.key);
  if(m.brand!==next.brand||bound.has(m.key)||i<0||next.messages[i].brand!==m.brand||next.messages[i].channel!=='email'||next.messages[i].release!==r.source_snapshot)fail('GRAPH_RELEASE_CATALOG_CHANGED');
  bound.add(m.key);next.messages[i]=m;
 }
 return next;
}
function createReleaseProvider({query}={}){
 if(typeof query!=='function')fail('GRAPH_RELEASE_ADAPTER_REQUIRED');
 const one=async(q,args)=>{const r=await query(q,args);if(!Array.isArray(r?.rows)||r.rows.length!==1)fail('GRAPH_RELEASE_OUTCOME_UNKNOWN');return r.rows[0].result;};
 const request=(actor,p)=>{if(typeof actor!=='string'||!actor.startsWith('panel:')||actor.length>200||!p||!uuid(p.request_id)||!PROFILES[p.brand]||!/^email\.template\.[1-9][0-9]{0,8}$/.test(p.binding)||!/^snapshot_[a-f0-9]{48}$/.test(p.expected_snapshot||'')||Object.keys(p).sort().join(',')!==(own(p,'purchase_policy')?'binding,brand,expected_snapshot,purchase_policy,request_id':'binding,brand,expected_snapshot,request_id')||own(p,'purchase_policy')&&p.purchase_policy!==PURCHASE_POLICY.version)fail('GRAPH_RELEASE_REQUEST_INVALID');};
 return {
  async prepare(actor,p){request(actor,p);const replay=await one('SELECT crm_graph_candidate.release_operation_v1($1::text,$2::jsonb) AS result',[actor,p]);if(replay)return replay;
   const source=await one('SELECT crm_graph_candidate.release_source_v1($1::text,$2::integer) AS result',[p.brand,Number(p.binding.slice(15))]);if(source?.source_snapshot!==p.expected_snapshot)fail('GRAPH_RELEASE_SOURCE_CHANGED');
   const material=prepareMaterial(source,{purchasePolicy:p.purchase_policy});return one('SELECT crm_graph_candidate.release_prepare_v1($1::text,$2::jsonb,$3::jsonb,$4::jsonb) AS result',[actor,p,source,material]);},
  async read(brand,releaseId){if(!PROFILES[brand]||!uuid(releaseId))fail('GRAPH_RELEASE_REQUEST_INVALID');const r=await one('SELECT crm_graph_candidate.release_get_v1($1::text,$2::uuid) AS result',[brand,releaseId]);if(!r)fail('GRAPH_RELEASE_NOT_FOUND');checkMaterial(r.material);return r;},
  async operation(actor,p){request(actor,p);return one('SELECT crm_graph_candidate.release_operation_v1($1::text,$2::jsonb) AS result',[actor,p]);}
 };
}
module.exports={VERSION,OBSERVED_VERSION,PURCHASE_POLICY,ENABLED,prepareMaterial,materialize,catalogMessage,bindCatalog,createReleaseProvider};
