'use strict';
// Capture exactly the native payment action supplied to the sender. Never
// reconstruct an old send from today's order or a later payment event.
function pixChargeEvidence(input) {
 if(input.modo!=='real'||!['aristo','fish'].includes(input.brand))return null;
 const actions=(input.components||[]).filter(c=>c.type==='button'&&c.sub_type==='order_details');
 if(!actions.length)return null;
 const d=actions[0].parameters?.[0]?.action?.order_details;
 const settings=d?.payment_settings?.filter(p=>p.type==='pix_dynamic_code');
 const code=settings?.[0]?.pix_dynamic_code?.code;
 const expiry=Date.parse(input._pix_expires_at),amount=d?.total_amount;
 if(actions.length!==1||settings?.length!==1||typeof code!=='string'||!code.startsWith('000201')||
  d.currency!=='BRL'||amount?.offset!==100||!Number.isSafeInteger(amount.value)||amount.value<=0||
  !Number.isFinite(expiry))return null;
 return {code,amount_cents:amount.value,expires_at:new Date(expiry).toISOString(),reference_id:d.reference_id};
}
function withPixEvidence(sql,input) {
 const e=pixChargeEvidence(input);if(!e)return sql;
 const q=v=>"'"+String(v).replace(/'/g,"''")+"'";
 // This CTE consumes only a newly reserved log row. Opt-outs, duplicates,
 // internal runs and failed guards cannot create payment evidence.
 const marker='\n)\nselect case when chk.guarda';
 if(!sql.includes(marker))throw Error('PIX_EVIDENCE_RESERVATION_SHAPE_CHANGED');
 return sql.replace(marker,`\n), charge_evidence AS (
 INSERT INTO public.shrigma_pix_charge_evidence(log_id,brand,ref,template_id,code_sha256,amount_cents,expires_at,reference_id)
 SELECT id,${q(input.brand)},${q(input.ref)},${q(input.template_id)},
 encode(sha256(convert_to(${q(e.code)},'UTF8')),'hex'),${e.amount_cents},${q(e.expires_at)}::timestamptz,${q(e.reference_id)}
 FROM ins ON CONFLICT(log_id) DO NOTHING
 RETURNING log_id
)\nselect case when chk.guarda`);
}
module.exports={pixChargeEvidence,withPixEvidence};
