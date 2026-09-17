const {test}=require('node:test'),assert=require('node:assert/strict');
const {pixChargeEvidence,withPixEvidence}=require('../n8n/growth/pix-charge-evidence');
const input=()=>({modo:'real',brand:'aristo',ref:'appmax:123',template_id:'42',_pix_expires_at:'2026-09-17T16:00:00Z',components:[{type:'button',sub_type:'order_details',parameters:[{type:'action',action:{order_details:{reference_id:'aristo-123',currency:'BRL',total_amount:{value:1234,offset:100},payment_settings:[{type:'pix_dynamic_code',pix_dynamic_code:{code:'000201original-code'}}]}}}]}]});
test('evidence captures exact original payment code, amount and expiry from the native action',()=>{
 const e=pixChargeEvidence(input());assert.equal(e.code,'000201original-code');assert.equal(e.amount_cents,1234);assert.equal(e.expires_at,'2026-09-17T16:00:00.000Z');
});
test('internal, shadow, malformed and missing-expiry messages do not become payment evidence',()=>{
 for(const change of [{modo:'interno'},{modo:'sombra'},{brand:'other'},{components:[]},{_pix_expires_at:null}])assert.equal(pixChargeEvidence({...input(),...change}),null);
 const i=input();i.components[0].parameters[0].action.order_details.total_amount.value=12.34;assert.equal(pixChargeEvidence(i),null);
});
test('reservation evidence consumes only newly inserted log ids and preserves non-PIX SQL',()=>{
 const sql="with ins as (select 1 as id\n)\nselect case when chk.guarda <> 'ok' then chk.guarda end";
 const updated=withPixEvidence(sql,input());assert.match(updated,/FROM ins ON CONFLICT\(log_id\) DO NOTHING/);assert.match(updated,/encode\(sha256/);
 assert.equal(withPixEvidence(sql,{...input(),components:[]}),sql);assert.throws(()=>withPixEvidence('unrecognized',input()),/RESERVATION_SHAPE_CHANGED/);
});
