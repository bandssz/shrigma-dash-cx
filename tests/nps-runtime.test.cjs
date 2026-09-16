const test=require('node:test'),assert=require('node:assert/strict');
const {prepareNpsRuntime}=require('../n8n/growth/nps-runtime.js');
function fixture(kind){const p=kind==='reminder'?'SES NPS D3':'SES NPS D0';return {nodes:['SES NPS candidatos','SES NPS assina lembrete',p+' reserva',p+' deve enviar',p+' Listmonk',p+' finaliza'].map(name=>({id:name,name,position:[0,0],parameters:name.endsWith('Listmonk')?{method:'POST'}:{options:{queryReplacement:'={{ original }}'}},retryOnFail:false})),connections:{}};}
test('one contact is claimed, transported, observed and finalized before advancing',()=>{
 const w=fixture('reminder'),before=structuredClone(w);let i=0;const r=prepareNpsRuntime(w,'reminder',()=>String(++i));assert.deepEqual(w,before);
 const next=n=>r.connections[n].main[0][0].node;
 assert.equal(next('SES NPS candidatos'),'NPS · Um contato por vez');
 assert.equal(r.connections['NPS · Um contato por vez'].main[1][0].node,'SES NPS assina lembrete');
 assert.equal(next('SES NPS D3 Listmonk'),'SES NPS D3 evidência');assert.equal(next('SES NPS D3 evidência'),'SES NPS D3 finaliza');
 assert.equal(next('SES NPS D3 finaliza'),'NPS · Intervalo entre contatos');assert.equal(next('NPS · Intervalo entre contatos'),'NPS · Um contato por vez');
 assert.equal(r.connections['SES NPS D3 deve enviar'].main[1][0].node,'NPS · Intervalo entre contatos');
 assert.equal(r.nodes.find(n=>n.type==='n8n-nodes-base.splitInBatches').parameters.batchSize,1);
 assert.equal(r.nodes.find(n=>n.type==='n8n-nodes-base.wait').parameters.amount,1);
 assert.equal(r.nodes.find(n=>n.name==='SES NPS D3 Listmonk').retryOnFail,false);
 assert.throws(()=>prepareNpsRuntime(r,'reminder',()=>''),/Already patched/);
});
test('initial NPS gains evidence without changing its trigger or response routes',()=>{
 let i=0;const w=fixture('initial');w.connections['other']={main:[[{node:'untouched',type:'main',index:0}]]};const r=prepareNpsRuntime(w,'initial',()=>String(++i));
 assert.deepEqual(r.connections.other,w.connections.other);assert.equal(r.nodes.length,w.nodes.length+1);
 assert.equal(r.connections['SES NPS D0 Listmonk'].main[0][0].node,'SES NPS D0 evidência');
 assert.ok(!r.nodes.some(n=>n.type==='n8n-nodes-base.splitInBatches'));
});
