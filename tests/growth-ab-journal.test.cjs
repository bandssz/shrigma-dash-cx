'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),J=require('../growth-ab-journal'),G=require('../growth-data');
const makeLocks=()=>{const held=new Set();return {async request(k,opts,fn){if(held.has(k))return fn(null);held.add(k);try{return await fn({name:k});}finally{held.delete(k);}}};};
const store=()=>{const map=new Map();return {map,getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v)};};
const request=id=>({k:'DO_NOT_PERSIST_KEY',acao:'criar',teste:{teste_id:id,marca:'fish',canal:'email',nome:'Synthetic',hipotese:'Synthetic',variavel:'assunto',metrica_primaria:'ctr',efeito_minimo:'1'},bracos:[{braco:'a',utm_term:'a',campanha_id:1,descricao:'A'},{braco:'b',utm_term:'b',campanha_id:2,descricao:'B'}]});
function fixture(){const storage=store(),locks=makeLocks();let time=1000,n=0;const options={storage,locks,endpoint:'https://example.invalid/ab',match:G.registroTesteConfere,receipt:G.reciboTesteValido,now:()=>time,uuid:()=>String(++n)};return {storage,locks,client:()=>J.create(options),options,tick:()=>{time+=10;return {startedAt:time,completedAt:time};},context:()=>({api:{crm_teste:[],crm_teste_braco:[]},readProof:{startedAt:time,completedAt:time}})};}
const materialize=p=>({crm_teste:[{...p.teste,status:'rodando'}],crm_teste_braco:p.bracos.map(b=>({...b,teste_id:p.teste.teste_id}))});
test('uncertain POST is durable before transport and remains blocked after reload, another tab, new ID and endpoint change',async()=>{
 const f=fixture(),p=request('one');let calls=0;
 const send=async()=>{calls++;const saved=JSON.parse(f.storage.getItem(J.SLOT));assert.equal(saved.operations[0].phase,'pending');assert.ok(!JSON.stringify(saved).includes(p.k));throw Error('lost');};
 assert.equal((await f.client().run(p,f.context(),send)).phase,'uncertain');
 assert.equal(f.client().inspect().revision,2,'pending and uncertain are separate durable revisions');
 for(const client of [f.client(),J.create({...f.options,endpoint:'https://other.invalid/ab'})])for(const id of ['one','different'])await assert.rejects(client.run(request(id),f.context(),send),/aguardando|endereço/);
 assert.equal(calls,1);assert.equal(f.client().inspect().operations[0].phase,'uncertain');
});
test('Web Locks serialize competing tabs; no lock or durable storage means zero POSTs',async()=>{
 const f=fixture();let finish,calls=0;const pending=f.client().run(request('one'),f.context(),()=>{calls++;return new Promise(resolve=>finish=resolve);});
 await Promise.resolve();await assert.rejects(f.client().run(request('two'),f.context(),()=>{calls++;}),/Outra aba/);
 finish({status:502,body:{}});await pending;assert.equal(calls,1);
 for(const bad of [{locks:null},{storage:{getItem:()=>null,setItem:()=>{throw Error('quota');}}},{storage:{getItem:()=>'{corrupt',setItem:()=>{}}}])await assert.rejects(J.create({...f.options,...bad}).run(request('three'),f.context(),()=>{calls++;}));
 assert.equal(calls,1);
});
test('fresh matching readback confirms without action, preserves archive, and allows a distinct legitimate next operation',async()=>{
 const f=fixture(),p=request('one'),c=f.client();let calls=0;const send=async()=>{calls++;throw Error('lost');};await c.run(p,f.context(),send);
 const expected=materialize(p);assert.equal((await c.reconcile(expected,{startedAt:999,completedAt:1000})).changed,false);
 assert.equal((await c.reconcile({crm_teste:[],crm_teste_braco:[]},f.tick())).changed,false,'absence is not rejection');
 assert.equal((await c.reconcile(expected,f.tick())).confirmed.length,1);assert.equal(c.inspect().operations[0].phase,'confirmed');assert.equal(c.inspect().revision,3);assert.equal(calls,1);
 await assert.rejects(c.run(p,{api:expected,readProof:f.tick()},send),/já foi registrado/);
 await c.run(request('two'),{api:expected,readProof:f.tick()},send);assert.equal(calls,2);assert.equal(c.inspect().operations.length,2);assert.equal(c.inspect().operations[0].phase,'confirmed');
});
test('accepted receipt remains frozen until matching readback; confirm creation permits one later close',async()=>{
 const f=fixture(),c=f.client(),p=request('one');const accept=async()=>({status:200,body:{ok:true,gravado_em:new Date(1000).toISOString()}});
 assert.equal((await c.run(p,f.context(),accept)).phase,'accepted');const api=materialize(p);await c.reconcile(api,f.tick());
 const close={acao:'encerrar',teste:{teste_id:'one',status:'inconclusivo',vencedor:null,conclusao:'Observation'}};
 await c.run(close,{api,readProof:f.tick()},accept);const done={crm_teste:[{...api.crm_teste[0],...close.teste}],crm_teste_braco:api.crm_teste_braco};await c.reconcile(done,f.tick());
 assert.deepEqual(c.inspect().operations.map(p=>p.phase),['confirmed','confirmed']);await assert.rejects(c.run(close,{api,readProof:f.tick()},accept),/não está disponível/);
});
test('only runtime-proved prewrite errors release; proxy errors, stale receipts and missing acknowledgments stay uncertain',async()=>{
 for(const response of [{status:401,body:{}},{status:403,body:{erro:'forbidden'}},{status:400,body:{erro:'requisicao invalida'}},{status:408,body:{}},{status:429,body:{}},{status:200,body:{ok:false}},{status:200,body:{ok:true,gravado_em:'2000-01-01'}}]){
  const f=fixture(),c=f.client();assert.equal((await c.run(request('one'),f.context(),async()=>response)).phase,'uncertain');
 }
 for(const response of [{status:401,body:{erro:'chave invalida'}},{status:400,body:{erro:'campo obrigatorio faltando: nome'}}]){
  const f=fixture(),c=f.client();assert.equal((await c.run(request('one'),f.context(),async()=>response)).phase,'rejected');assert.equal(c.inspect().operations.length,1);
  assert.equal((await c.run(request('one'),f.context(),async()=>({status:502}))).phase,'uncertain');assert.equal(c.inspect().operations.length,2);
 }
});
test('terminal storage failure preserves pending; corrupted or removed journal never silently starts over',async()=>{
 const f=fixture(),original=f.storage.setItem;let n=0;f.storage.setItem=(k,v)=>{if(++n===2)throw Error('quota');original(k,v);};const c=f.client();
 await assert.rejects(c.run(request('one'),f.context(),async()=>({status:401,body:{erro:'chave invalida'}})),/preservar/);
 assert.equal(f.client().inspect().operations[0].phase,'pending');f.storage.map.clear();assert.equal(c.inspect().blocked,true);
});
test('invalid input and stale or malformed read proofs never perform a POST',async()=>{
 const f=fixture(),c=f.client();let calls=0;
 for(const patch of [{startedAt:1001,completedAt:1000},{startedAt:1000,completedAt:2001},null])await assert.rejects(c.run(request('one'),{api:f.context().api,readProof:patch},()=>{calls++;}),/Atualize/);
 for(const value of [NaN,Infinity,-Infinity])await assert.rejects(c.run({...request('one'),teste:{...request('one').teste,efeito_minimo:value}},f.context(),()=>{calls++;}),/inválido/);
 assert.equal(calls,0);assert.equal(c.inspect().operations.length,0);
});
