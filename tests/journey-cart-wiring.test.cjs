'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {collectorBatches,prepareCollectorHandoff,buildCartAdapterBundle}=require('../n8n/growth/journey-cart-wiring.cjs');
const counters=()=>({compradores_add:'0',leads_removidos:'0',leads_add:'0',carrinho_add:'0',carrinho_removidos:'0',flags_sincronizados:'0'});
const receipt=ids=>({carrinhos_gravados:String(ids.length),novos_na_base_geral:'0',journey_source_ids:ids});
function fixture(){return {versionId:'fresh',active:true,nodes:[
 {name:'Config',type:'n8n-nodes-base.set',parameters:{assignments:{assignments:Object.entries({brand:'fish',list_base:17,list_compradores:3,list_leads:9,list_carrinho:22,ttl_dias:30}).map(([name,value])=>({name,value}))}}},
 {name:'Upsert Carrinhos (Listmonk PG)',type:'n8n-nodes-base.postgres',parameters:{query:"WITH up AS (INSERT INTO subscribers SELECT 1 ON CONFLICT (email) DO UPDATE SET status=status WHERE subscribers.status <> 'blocklisted' RETURNING id, status), base AS (SELECT 1) SELECT (SELECT COUNT(*) FROM up) AS carrinhos_gravados,(SELECT COUNT(*) FROM base) AS novos_na_base_geral;"}},
 {name:'Reconciliação 4 Listas (PG)',type:'n8n-nodes-base.postgres',position:[0,0],parameters:{query:'SELECT 0 AS flags_sincronizados,0 AS carrinho_removidos,0 AS compradores_add',options:{queryReplacement:"={{ $('Config').first().json.list_base }},{{ $('Config').first().json.list_compradores }},{{ $('Config').first().json.list_leads }},{{ $('Config').first().json.brand }},{{ $('Config').first().json.list_carrinho }},{{ $('Config').first().json.ttl_dias }}"}}},
 {name:'Resumo',type:'n8n-nodes-base.code',parameters:{jsCode:'return $input.all();'}}],connections:{'Upsert Carrinhos (Listmonk PG)':{main:[[{node:'Reconciliação 4 Listas (PG)',type:'main',index:0}]]},'Reconciliação 4 Listas (PG)':{main:[[{node:'Resumo',type:'main',index:0}]]}}};}
test('all identities survive 2,000-source collector batches and multiple receipts; scanner batches stay at most 200',()=>{
 const ids=Array.from({length:2001},(_,i)=>2001-i),r=collectorBatches([receipt(ids.slice(0,2000)),receipt(ids.slice(2000))],{brand:'fish',reconciliation:[counters()]});
 assert.equal(r.source_count,2001);assert.equal(r.batches.length,11);assert.ok(r.batches.every(x=>x.mode==='dry_run'&&x.sourceIds.length<=200));assert.deepEqual(r.batches.flatMap(x=>x.sourceIds),ids.slice().sort((a,b)=>a-b));assert.equal(ids[0],2001);
});
test('unknown reconciliation, duplicate/malformed IDs and mismatched counters stop before capture',()=>{
 const valid={brand:'fish',reconciliation:[counters()]};
 for(const options of [{brand:'aristo',reconciliation:[counters()]},{brand:'fish',reconciliation:[]},{brand:'fish',reconciliation:[{}]},{...valid,batchSize:201}])assert.throws(()=>collectorBatches([receipt([1])],options));
 for(const r of [[receipt([1,1])],[receipt([1]),receipt([1])],[receipt([0])],[{...receipt([1]),carrinhos_gravados:'2'}],[{...receipt([1]),novos_na_base_geral:null}],[receipt(Array(2001).fill(1))]])assert.throws(()=>collectorBatches(r,valid));
 const r=collectorBatches([receipt([])],valid);assert.deepEqual(r.batches,[]);assert.equal(r.source_count,0);
});
test('patch runs after list reconciliation, preserves original summary path and introduces no transport or activation',()=>{
 const w=fixture(),before=JSON.stringify(w),p=prepareCollectorHandoff(w,{expectedVersion:'fresh'});
 assert.equal(JSON.stringify(w),before);assert.equal(p.active,true,'preparation does not change existing active state');
 assert.deepEqual(p.nodes.slice(2,4),w.nodes.slice(2,4));assert.deepEqual(p.connections['Upsert Carrinhos (Listmonk PG)'],w.connections['Upsert Carrinhos (Listmonk PG)']);
 assert.equal(p.connections['Reconciliação 4 Listas (PG)'].main[0][0].node,'Resumo');assert.equal(p.connections['Reconciliação 4 Listas (PG)'].main[0][1].node,'J1 lotes após reconciliação');
 const n=p.nodes.at(-1);assert.equal(n.type,'n8n-nodes-base.code');assert.doesNotMatch(n.parameters.jsCode,/\brequire\s*\(|fetch\s*\(|claim\s*\(|enroll\s*\(/);
 assert.throws(()=>prepareCollectorHandoff(w,{expectedVersion:'stale'}));assert.throws(()=>prepareCollectorHandoff(p,{expectedVersion:'fresh'}));
});
test('generated Code runs in a VM without require, bundles no I/O and retains exact IDs in each output',()=>{
 const p=prepareCollectorHandoff(fixture(),{expectedVersion:'fresh'}),code=p.nodes.at(-1).parameters.jsCode,rows=[receipt(Array.from({length:201},(_,i)=>201-i))];
 const fn=new vm.Script('(function(){'+code+'})()');const out=fn.runInNewContext({$input:{all:()=>[{json:counters()}]},$:name=>name==='Config'?{first:()=>({json:{brand:'fish'}})}:{all:()=>rows.map(json=>({json}))}},{timeout:1000});
 assert.equal(out.length,2);assert.deepEqual(JSON.parse(JSON.stringify(out.flatMap(x=>x.json.sourceIds))),Array.from({length:201},(_,i)=>i+1));assert.ok(out.every(x=>x.pairedItem.item===0));
});
test('changed list identity or source ordering rejects the candidate instead of guessing a binding',()=>{
 const w=fixture();w.nodes[0].parameters.assignments.assignments.find(x=>x.name==='list_carrinho').value=999;assert.throws(()=>prepareCollectorHandoff(w,{expectedVersion:'fresh'}));
 const o=fixture();o.connections['Upsert Carrinhos (Listmonk PG)'].main[0][0].node='Resumo';assert.throws(()=>prepareCollectorHandoff(o,{expectedVersion:'fresh'}));
});

test('existing entry/scanner adapters bundle in Code without require and retain dry-run behavior',async()=>{
 const bundle=buildCartAdapterBundle();assert.doesNotMatch(bundle,/\brequire\s*\(/);
 const calls=[],context=vm.createContext({query:async(q,args)=>{calls.push([q,args]);return {rows:q.includes('control_v1')?[{observed_at:'2026-01-01T12:00:00Z',enabled:false,starts_at:null,template_cache_target:null}]:[]};}});
 const promise=vm.runInContext(bundle+`; const entries=ShrigmaCartAdapters.createCartEntryProvider({query,cacheTarget:'fixture'}); ShrigmaCartAdapters.createCartScanner({query,entries}).run({sourceIds:[]});`,context,{timeout:1000});
 const result=await promise;assert.equal(result.mode,'dry_run');assert.equal(result.sends,0);assert.equal(result.cohort_enabled,false);assert.ok(calls.every(([q])=>q.startsWith('SELECT ')&&!q.includes('enroll')&&!q.includes('claim')));assert.equal(typeof context.require,'undefined');
});
