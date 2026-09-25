'use strict';
// Public configuration metadata only. Never project subscriber or message content.
function emailInventory(rows, checkedAt) {
  const validText=v=>typeof v==='string'&&/^[a-z0-9:_-]{1,100}$/.test(v);
  if(!Array.isArray(rows)||rows.length>200||!Number.isFinite(Date.parse(checkedAt)))throw Error('invalid_email_inventory');
  const seen=new Set();
  return rows.map(r=>{
    if(!r||!['fish','aristo'].includes(r.brand)||!validText(r.flow_key)||!r.flow_key.startsWith(r.brand+':')||!validText(r.piece)
      ||!/^\d{1,15}$/.test(String(r.template_id))||!Number.isSafeInteger(r.published_version)||r.published_version<1
      ||['flow_enabled','step_enabled','runtime_ready'].some(k=>typeof r[k]!=='boolean'))throw Error('invalid_email_step');
    const key=r.brand+':'+r.piece;
    if(seen.has(key))throw Error('duplicate_email_step');seen.add(key);
    return {key,brand:r.brand,flow_key:r.flow_key,piece:r.piece,template_id:String(r.template_id),published_version:r.published_version,
      enabled:r.flow_enabled&&r.step_enabled,runtime_ready:r.runtime_ready,checked_at:new Date(checkedAt).toISOString()};
  }).sort((a,b)=>a.key.localeCompare(b.key));
}
module.exports=emailInventory;
