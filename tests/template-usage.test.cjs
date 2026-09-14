const test=require('node:test'),assert=require('node:assert/strict');
const build=require('../n8n/growth/template-usage.js');
const seed=[{key:'aristo:11',id:'11',brand:'aristo',usage:'retired',name:'old_pix',piece:'pix-15min',mapped_in:[{workflow_key:'aristo_pix'}]},{key:'fish:99',id:'99',usage:'optional',usage_reason:'Cartão opcional',mapped_in:[]}];
const flow={key:'aristo:pix',brand:'aristo',enabled:true,runtime_ready:true,steps:[{id:'22',name:'active_pix',category:'UTILITY',piece:'pix-3min',enabled:true}]};
test('published PIX selects Appmax and keeps retired version out of current routing',()=>{
 const rows=build(seed,[flow]),active=rows.find(x=>x.id==='22');assert.equal(active.usage,'current');assert.deepEqual(active.mapped_in,[{workflow_key:'aristo_pix_appmax',mode_key:'modo',piece:'pix-3min'}]);assert.deepEqual(rows.find(x=>x.id==='11').mapped_in,[]);assert.equal(rows.find(x=>x.id==='99').usage,'optional');
});
test('paused journey or stage cannot imply active template use',()=>{
 for(const f of [{...flow,enabled:false},{...flow,runtime_ready:false},{...flow,steps:[{...flow.steps[0],enabled:false}]}]){const d=build(seed,[f]).find(x=>x.id==='22');assert.equal(d.usage,'configured_paused');assert.deepEqual(d.mapped_in,[]);}
});
test('template switch removes stale mapping and unknown routes fail visibly',()=>{
 const previous=[{key:'aristo:33',id:'33',usage:'current',mapped_in:[{workflow_key:'aristo_pix_appmax'}]}];assert.equal(build(previous,[flow])[0].usage,'available');assert.deepEqual(build(previous,[flow])[0].mapped_in,[]);assert.throws(()=>build(seed,[]),/unavailable/);assert.throws(()=>build(seed,[{...flow,key:'aristo:unknown'}]),/unmapped/);
});
