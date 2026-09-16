const test=require('node:test'),assert=require('node:assert/strict');
const {mergeJourneys}=require('../n8n/growth/journey-merge.js');
function fixture(){return ['fish','aristo'].flatMap(brand=>['nps-d0','nps-d3','pedido-recebido','pedido-confirmado','pedido-preparando','pedido-em_rota','pedido-entregue','pedido-cancelado'].map((key,i)=>{
 const step={key:'email:'+key,piece:key,channel:'email',flow:key.startsWith('nps')?'nps':'transacional',enabled:true,template_id:String(i+1),wait_min:key==='nps-d3'?4320:0};
 const d={name:key,steps:[step]};return {key:brand+':'+key,brand,name:key,trigger:key,version:1,published_version:1,enabled:true,runtime_ready:true,draft:structuredClone(d),published:structuredClone(d),binding:{brand,steps:[step]}};
}));}
test('merges preserve every dispatch identity, template and wait; input untouched',()=>{
 const f=fixture(),before=structuredClone(f),r=mergeJourneys(f);assert.deepEqual(f,before);
 assert.equal(r.merges.length,4);assert.equal(r.flows.filter(f=>!f.binding.merged_into).length,4);
 for(const b of ['fish','aristo']){
  const prior=f.filter(f=>f.brand===b).flatMap(f=>f.published.steps).sort((a,b)=>a.key.localeCompare(b.key));
  const after=r.flows.filter(f=>f.brand===b&&!f.binding.merged_into).flatMap(f=>f.published.steps).sort((a,b)=>a.key.localeCompare(b.key));
  assert.deepEqual(after,prior);
 }
 assert.ok(r.flows.filter(f=>f.binding.merged_into).every(f=>!f.enabled&&!f.runtime_ready));
});
test('independent pause and removed stages survive merging',()=>{
 const f=fixture();f[1].enabled=false;f[3].draft.steps=[];f[3].published.steps=[];
 const r=mergeJourneys(f);const n=r.flows.find(f=>f.key==='fish:nps-d0');assert.equal(n.published.steps[1].enabled,false);assert.equal(n.enabled,true);
 const o=r.flows.find(f=>f.key==='fish:pedido-recebido');assert.ok(!o.published.steps.some(s=>s.piece==='pedido-confirmado'));assert.ok(o.binding.steps.some(s=>s.piece==='pedido-confirmado'));
});
test('pending edits, missing sources and repeat migration cannot be silently merged',()=>{
 const f=fixture();f[0].draft.name='Pending';assert.throws(()=>mergeJourneys(f),/Unpublished/);
 assert.throws(()=>mergeJourneys(fixture().slice(1)),/Missing/);
 assert.throws(()=>mergeJourneys(mergeJourneys(fixture()).flows),/Already merged/);
});
