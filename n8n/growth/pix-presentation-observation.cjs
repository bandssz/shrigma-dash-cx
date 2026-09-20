'use strict';
// Hashes identify public observation rules, never customer or payment values.
const RULE_HASHES=Object.freeze({
 aggregate:'1393eb1bfe812568ee74f9d31bc20f6777ec6f352ca1c134d5b20eda3a19f844',
 itemized_shape:'65a1dce4a40bf150d3af93043ffb534c60eb5c47eaa7d43910134e030371fcdb',
 unknown:'5adadb7146f2daabca41549de918a4640712a79cf6c52c7c51617af535d1acab'
});
function observePixPresentation(decision) {
 try {
  const s=decision?.saida,b=decision?.meta_body;
  if(s?.brand!=='fish'||s.modo!=='real'||s.piece!=='pix-15min'||s.flow==='teste-motor'||!/^\d+$/.test(String(s.ref||''))||b?.type!=='template')return null;
  const components=b.template?.components;
  if(!Array.isArray(components))return null;
  const actions=components.filter(c=>c?.type==='button'&&c.sub_type==='order_details');
  if(actions.length!==1||actions[0].parameters?.length!==1)return null;
  const d=actions[0].parameters[0]?.action?.order_details;
  if(d?.reference_id!=='fish-'+s.ref||d.currency!=='BRL'||!Array.isArray(d.payment_settings)||d.payment_settings.length!==1||d.payment_settings[0]?.type!=='pix_dynamic_code')return null;
  const money=m=>m?.offset===100&&Number.isSafeInteger(m.value)&&m.value>=0?m.value:null;
  const total=money(d.total_amount),o=d.order,items=o?.items;
  if(total===null||total<=0)return null;
  const count=Array.isArray(items)&&items.length>=1&&items.length<=30?items.length:null;
  let variant='unknown';
  if(count!==null&&o.status==='pending'){
   const amounts=items.map(i=>money(i?.amount)),subtotal=money(o.subtotal),tax=money(o.tax),shipping=o.shipping===undefined?0:money(o.shipping),discount=o.discount===undefined?0:money(o.discount);
   const valid=items.every((i,n)=>typeof i?.name==='string'&&i.name.trim()!==''&&Array.from(i.name).length<=60&&Number.isSafeInteger(i.quantity)&&i.quantity>=1&&amounts[n]!==null);
   const sum=valid?items.reduce((n,i,k)=>n+amounts[k]*i.quantity,0):null;
   const balanced=valid&&[subtotal,tax,shipping,discount].every(x=>x!==null)&&Number.isSafeInteger(sum)&&sum===subtotal&&subtotal+tax+shipping-discount===total;
   if(balanced&&count===1&&items[0].retailer_id==='order-'+s.ref&&items[0].quantity===1&&amounts[0]===total&&tax===0&&shipping===0&&discount===0)variant='aggregate';
   else if(balanced&&items.every(i=>typeof i.retailer_id==='string'&&/^\d+$/.test(i.retailer_id))&&new Set(items.map(i=>i.retailer_id)).size===count)variant='itemized_shape';
  }
  return {variant,item_count:count,version_sha256:RULE_HASHES[variant]};
 }catch{return null;}
}
function observationEligible(finalization,interpreted) {
 return !finalization?.error&&Number(finalization?.log_atualizado)===1&&interpreted?.saida?.ok===true&&typeof interpreted.saida.wamid==='string'&&interpreted.saida.wamid.length>0&&interpreted.pix_presentation_observation!==null&&typeof interpreted.pix_presentation_observation==='object';
}
const QUERY="SET LOCAL lock_timeout='250ms'; SET LOCAL statement_timeout='1500ms'; SELECT public.shrigma_pix_observe_presentation_v1($1::bigint,$2::text,$3::integer,$4::text) AS pix_presentation_recorded";
module.exports={RULE_HASHES,observePixPresentation,observationEligible,QUERY};
