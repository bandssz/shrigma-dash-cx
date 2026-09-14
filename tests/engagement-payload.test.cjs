const test=require('node:test'),assert=require('node:assert/strict');
const {engagementNps:nps,engagementPopup:popup}=require('../n8n/growth/engagement-payload.js');
const C={SECRET:'fixture',FROM:{fish:'Fishermans <contato@fishermans.com.br>',aristo:'O Aristocrata <contato@oaristocrata.com>'},LP:{fish:'https://fishermans.com.br/pages/avaliar',aristo:'https://oaristocrata.com/pages/avaliar'}};
test('NPS preserves signature inputs and exact D0/D3 templates in both brands',()=>{
 for(const [brand,piece,template] of [['fish','nps-d0',29],['fish','nps-d3',31],['aristo','nps-d0',28],['aristo','nps-d3',30]]){
  let signed;const r=nps({brand,email:'UPPER@EXAMPLE.INVALID ',order_number:'123',first_name:'Name'},piece,C,(...a)=>(signed=a,'signed'));
  assert.equal(r.tx.template_id,template);assert.deepEqual(signed,['fixture','123','upper@example.invalid']);assert.equal(r.tx.data.s,'signed');assert.equal(r.tx.data.e,r.email);assert.equal(r.tx.data.p,r.ref);
 }
});
test('unsupported brands and incomplete NPS requests cannot become Fishermans sends',()=>{
 for(const input of [{brand:'olivas',email:'x@example.invalid',ref:'1'},{brand:'fish',email:'',ref:'1'},{brand:'aristo',email:'x@example.invalid'}])assert.throws(()=>nps(input,'nps-d0',C,()=>''),/NPS_INPUT_INVALID/);
});
test('popup preserves quotes in names and has per-execution identity, with other brands unchanged',()=>{
 const b={email:'X@EXAMPLE.INVALID',name:'João "Teste"',from_email:C.FROM.fish,template_id:23,checkout_url:'https://fishermans.com.br/?coupon=welcome'};
 const r=popup(b,'123');assert.equal(r.tx.data.first_name,b.name);assert.equal(r.tx.data.checkout_url,b.checkout_url);assert.equal(r.email,'x@example.invalid');assert.equal(r.ref,'popup-execution:123');assert.notEqual(popup(b,'124').ref,r.ref);
 assert.equal(popup({...b,from_email:'Olivas <contato@olivasdocampo.com.br>'},'123'),null);
 assert.throws(()=>popup({...b,template_id:22},'123'),/POPUP_INPUT_INVALID/);assert.throws(()=>popup(b,'not-an-id'),/POPUP_INPUT_INVALID/);
});
