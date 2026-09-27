/* Trusted backend adapter; no public request, source activation or transport.
 * readSource matches journey_source_v1. Collector receipt time is never refreshed
 * by a database read. Absence of a purchase webhook is never a negative fact. */
'use strict';
const {createHash}=require('node:crypto');
const VERSION='journey_graph_source_v1',UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const error=code=>Object.assign(Error(code),{code});
const iso=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString()===s;
const clone=x=>JSON.parse(JSON.stringify(x));
const text=x=>typeof x==='string'&&x.length>0&&x.length<=2048&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(x)?x:null;
const money=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0&&x<=1e9?'R$ '+x.toFixed(2).replace('.',','):null;
function url(x){if(!text(x))return null;try{const u=new URL(x);return u.protocol==='https:'&&!u.username&&!u.password?x:null;}catch{return null;}}
function mapItems(items){
 if(!Array.isArray(items)||items.length<1||items.length>100)return null;
 const out=[];
 for(const i of items){if(!i||typeof i!=='object'||Array.isArray(i))return null;const n={};
  const name=text(i.titulo??i.title),qty=i.qtd??i.quantity,variant=typeof i.variante==='string'&&(i.variante===''||text(i.variante))?i.variante:null,price=money(i.preco),image=url(i.imagem);
  if(name){n.name=name;n.title=name;}if(Number.isSafeInteger(qty)&&qty>0&&qty<=10000){n.qty=qty;n.quantity=qty;}if(variant!==null)n.variant=variant;if(price)n.price=price;if(image)n.image=image;
  if(!Object.keys(n).length)return null;out.push(n);
 }
 return JSON.stringify(out).length>24000?null:out;
}
function createSourceAdapter({query,purchaseFor,collectorWorkflowIds={}}={}){
 if(typeof query!=='function'||purchaseFor!==undefined&&typeof purchaseFor!=='function')throw error('GRAPH_SOURCE_ADAPTER_REQUIRED');
 const one=async(q,args,read=query)=>{const r=await read(q,args);if(!Array.isArray(r?.rows)||r.rows.length!==1||!Object.hasOwn(r.rows[0],'result'))throw error('GRAPH_SOURCE_READ_UNCONFIRMED');return r.rows[0].result;};
 const adapter={
  async captureHandoff(handoff){
   const p=handoff;if(!p||p.version!==VERSION||p.authorizes_enrollment!==false||p.authorizes_send!==false||!['fish','aristo'].includes(p.brand)||typeof collectorWorkflowIds[p.brand]!=='string'||p.workflow_id!==collectorWorkflowIds[p.brand]||!/^\d{1,20}$/.test(p.execution_id||'')||!Number.isSafeInteger(p.batch_index)||p.batch_index<0||p.batch_index>10000)throw error('GRAPH_SOURCE_HANDOFF');
   const h=createHash('sha256').update(JSON.stringify([VERSION,p.workflow_id,p.execution_id,p.batch_index])).digest('hex');const receipt_id=h.slice(0,8)+'-'+h.slice(8,12)+'-4'+h.slice(13,16)+'-8'+h.slice(17,20)+'-'+h.slice(20,32);
   return adapter.capture({version:VERSION,brand:p.brand,receipt_id,reconciled:p.reconciled,observed_at:p.observed_at,items:p.items});
  },
  // Receipt is delivered by a trusted collector integration, never editor/body.
  async capture(receipt){
   if(!receipt||Object.keys(receipt).sort().join(',')!=='brand,items,observed_at,receipt_id,reconciled,version'||receipt.version!==VERSION||receipt.reconciled!==true||!['fish','aristo'].includes(receipt.brand)||!UUID.test(receipt.receipt_id||'')||!iso(receipt.observed_at)||!Array.isArray(receipt.items)||receipt.items.length>200)throw error('GRAPH_SOURCE_RECEIPT');
   const items=clone(receipt.items).sort((a,b)=>a.subscriber_id-b.subscriber_id);
   const result=await one('SELECT crm_graph_candidate.source_capture_v1($1::text,$2::uuid,$3::timestamptz,$4::jsonb) AS result',[receipt.brand,receipt.receipt_id,receipt.observed_at,JSON.stringify(items)]);
   if(!Array.isArray(result?.source_refs)||result.source_refs.length!==items.length||result.source_refs.some(x=>!UUID.test(x))||result.authorizes_enrollment!==false||result.authorizes_send!==false)throw error('GRAPH_SOURCE_CAPTURE_UNCONFIRMED');
   return clone(result);
  },
  async readSource({source_ref,brand,trigger,now,query:transactionQuery=query}){
   if(!UUID.test(source_ref||'')||!['fish','aristo'].includes(brand)||trigger!=='cart.abandoned'||!iso(now)||typeof transactionQuery!=='function')throw error('GRAPH_SOURCE_IDENTITY');
   const r=await one('SELECT crm_graph_candidate.source_read_v1($1::text,$2::uuid) AS result',[brand,source_ref],transactionQuery);
   if(r?.source_ref!==source_ref||r.brand!==brand||!UUID.test(r.subject_id||'')||!/^[a-f0-9]{64}$/.test(r.source_revision||'')||!iso(r.occurred_at)||!iso(r.observed_at)||!iso(r.material_observed_at)||Math.abs(Date.parse(now)-Date.parse(r.observed_at))>5000||Date.parse(r.occurred_at)>Date.parse(now)||![r.eligible,r.consent,r.suppressed,r.material_matches].every(x=>typeof x==='boolean')||![true,false,null].includes(r.purchase_positive))throw error('GRAPH_SOURCE_READ_UNCONFIRMED');
   const fact=(value,at=now)=>({value,observed_at:at,complete:true}),facts={'cart.abandoned_at':fact(r.occurred_at,r.material_observed_at),'contact.email_allowed':fact(r.consent)};
   if(r.purchase_positive===true)facts['purchase.confirmed']=fact(true);
   // Optional trusted, exhaustive per-subject purchase evidence. No provider is
   // supplied by default: until integrated and verified, the No branch waits.
   else if(purchaseFor&&r.eligible&&r.consent&&!r.suppressed){let p,timer;try{p=await Promise.race([purchaseFor({source_ref,subject_id:r.subject_id,brand,occurred_at:r.occurred_at,now,query:transactionQuery}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(error('GRAPH_PURCHASE_UNCONFIRMED')),5000);})]);}catch{throw error('GRAPH_PURCHASE_UNCONFIRMED');}finally{clearTimeout(timer);}
    if(p&&p.version==='journey_purchase_evidence_v1'&&p.source_ref===source_ref&&p.subject_id===r.subject_id&&p.brand===brand&&p.complete===true&&typeof p.purchased==='boolean'&&[p.covered_from,p.covered_through,p.observed_at].every(iso)&&Date.parse(p.covered_from)<=Date.parse(r.occurred_at)&&Date.parse(p.covered_through)>=Date.parse(now)&&Date.parse(p.covered_through)<=Date.parse(p.observed_at)&&Date.parse(p.observed_at)<=Date.parse(r.observed_at)+5000&&Date.parse(p.observed_at)>=Date.parse(now))facts['purchase.confirmed']=fact(p.purchased);
   }
   const m=r.material;
   if(r.material_matches&&m&&typeof m==='object'){
    const values={'contact.first_name':text(m['contact.first_name']),'cart.checkout_url':url(m['cart.checkout_url']),'cart.items':mapItems(m['cart.items']),'cart.total':money(m['cart.total'])};
    for(const [key,value]of Object.entries(values))if(value!==null)facts[key]=fact(value,r.material_observed_at);
   }
   // observed_at represents this native-state read. Material facts retain the
   // collector's timestamp; complete does not mean complete Shopify order history.
   return {version:'journey_source_v1',source_ref,brand,trigger,event_id:r.source_revision,subject_id:r.subject_id,source_revision:'cart:'+r.source_revision,occurred_at:r.occurred_at,observed_at:now,complete:true,eligible:r.eligible,consent:r.consent,suppressed:r.suppressed,facts};
  }
 };return Object.freeze(adapter);
}
module.exports={VERSION,ENABLED:false,createSourceAdapter,mapItems};
