'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const S=require((process.env.DASHBOARD_ACCESS_TEST_RUNTIME||path.resolve(__dirname,'../services/dashboard-operational'))+'/server.cjs');
const row=()=>({marca:'fish',dia:'2026-10-12',carrinhos:2,valor_em_jogo:100,com_consent:1,voltaram_72h:1,receita_voltaram:50,recuperados:null,receita_recuperada:null});
test('cart diagnostics count each missing/null/type without returning values or another brand',()=>{
 const a=row();delete a.valor_em_jogo;a.com_consent=null;a.voltaram_72h={email:'private@synthetic.invalid'};
 const b={...row(),marca:'aristo',recuperados:1,receita_recuperada:30},d=S.cartContractSummary({crm_carrinho:[a,b]},'fish');
 assert.equal(d.rowsObserved,1);assert.deepEqual(d.fields.valor_em_jogo,{absent:1,null:0,invalidType:0});assert.equal(d.fields.com_consent.null,1);assert.equal(d.fields.voltaram_72h.invalidType,1);assert.deepEqual(d.recoveryPair,{bothNull:1,bothNumeric:0,mixed:0});assert(!JSON.stringify(d).includes('private@'));assert(!JSON.stringify(d).includes('2026-10-12'));assert(!JSON.stringify(d).includes('aristo'));
});
test('missing or malformed cart does not manufacture empty counts; a real empty array is measured',()=>{
 assert.deepEqual(S.cartContractSummary({},'fish'),{status:'missing'});assert.deepEqual(S.cartContractSummary({crm_carrinho:null},'fish'),{status:'invalid'});assert.equal(S.cartContractSummary({crm_carrinho:[]},'fish').rowsObserved,0);
 const unscoped=row();delete unscoped.marca;assert.deepEqual(S.cartContractSummary({crm_carrinho:[unscoped]},'fish'),{status:'unscoped'});
});
test('mixed recovery nullability remains explicit, not an inferred recovery or zero',()=>{
 const r=row();r.receita_recuperada=0;const d=S.cartContractSummary({crm_carrinho:[r]},'fish');assert.equal(d.recoveryPair.mixed,1);assert.equal(d.fields.recuperados.null,1);
 const out=S.projectBrandCache({crm_diario:[{marca:'fish',dia:r.dia,enviados:1}],crm_carrinho:[r]},'fish','growth','https://gerencial.synthetic.invalid');assert(!Object.hasOwn(out,'crm_carrinho'));assert.deepEqual(out.read_issues,[{section:'crm_carrinho',reason:'recovery_pair_mismatch',field:'recuperados'}]);
});
