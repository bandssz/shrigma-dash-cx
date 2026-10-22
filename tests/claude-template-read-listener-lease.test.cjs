'use strict';
// Revisão 5974202110 (P1): o prazo devolve 503 mas a vaga só é liberada quando a
// transação/conexão realmente termina. Quatro operações no máximo, admissão
// antes de pool.connect, e abort conferido logo após obter a conexão (sem
// BEGIN/SET/identidade numa operação já abandonada). Pool sintético, HTTP em loopback.
const {test}=require('node:test'),assert=require('node:assert/strict');
const S=require('../services/crm-template-read/store.cjs'),{createReadServer}=require('../services/crm-template-read/server.cjs');
const KEY='b'.repeat(64),REV='a'.repeat(40),Q='?acao=listar&brand=fish&channel=email&offset=0&limit=20',AT='2026-10-03T12:00:00Z';
const page={contract:'crm-template-read-v1',brand:'fish',channel:'email',templates:[],offset:0,limit:20,total:0,next_offset:null,coverage:'registered_email_only',consultado_em:AT,schedule_proof:false};
const tick=(ms=0)=>new Promise(r=>setTimeout(r,ms));
const until=async(f,ms=3000)=>{const t=Date.now();while(!f()){if(Date.now()-t>ms)throw Error('prazo do teste');await tick(5);}};
function gate(){let open,p=new Promise(r=>open=r);return {wait:()=>p,open:()=>open()};}
// Pool sintético: a consulta de listar (ou o próprio connect) fica presa até o teste liberar.
function fakePool({holdQuery=null,holdConnect=null}={}){
 const st={connects:0,clients:[]};
 const pool={async connect(){st.connects++;if(holdConnect)await holdConnect.wait();
  const c={queries:[],released:null,query:async q=>{const text=typeof q==='string'?q:q.text;c.queries.push(text);
   if(text===S.SQL.identity)return {rows:[{role:'crm_template_reader',read_only:'on'}]};
   if(text===S.SQL.xid)return {rows:[{xid:null}]};
   if(text===S.SQL.listar){if(holdQuery)await holdQuery.wait();return {rows:[{r:page}]};}
   if(S.SQL.attest&&text===S.SQL.attest)return {rows:S.ATTEST_ROWS?S.ATTEST_ROWS.map(x=>({...x})):[]};
   return {rows:[{}]};},release(destroy){c.released=destroy===true;}};
  st.clients.push(c);return c;}};
 return {pool,st};
}
async function serve(t,pool,timeoutMs=60){
 const transaction=S.createReadTransaction({pool}),handler=S.createTemplateReadStore({transaction,timeoutMs});
 const app=createReadServer({handler,revision:REV,enabled:true});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>app.stop());
 const get=async()=>{const r=await fetch(`http://127.0.0.1:${app.server.address().port}/template-read${Q}`,{headers:{authorization:'Bearer '+KEY}});return {status:r.status,body:await r.json()};};
 return {app,transaction,get};
}

test('prazo com consulta presa: quatro 503 mantêm as quatro vagas; o quinto pedido é recusado sem pool.connect; liberada a consulta, tudo é desfeito e a vaga volta',async t=>{
 const hold=gate(),{pool,st}=fakePool({holdQuery:hold}),{app,transaction,get}=await serve(t,pool);
 const first=await Promise.all([get(),get(),get(),get()]);
 assert.deepEqual(first.map(r=>r.status),[503,503,503,503]);
 assert.equal(st.connects,4);
 assert.equal(transaction.active(),4,'as quatro transações seguem vivas');
 assert.equal(app.active(),4,'a vaga HTTP só é devolvida quando a transação termina');
 const fifth=await get();
 assert.equal(fifth.status,503);assert.deepEqual(fifth.body,{error:'TEMPLATE_READ_BUSY'});
 assert.equal(st.connects,4,'o quinto pedido não chegou ao pool');
 hold.open();
 await until(()=>transaction.active()===0&&app.active()===0);
 // Cada operação abandonada: ROLLBACK e conexão descartada, sem xid nem resposta.
 for(const c of st.clients){assert.equal(c.released,true);assert.equal(c.queries.at(-1),'ROLLBACK');assert.equal(c.queries.includes(S.SQL.xid),false);}
 const again=await get();assert.equal(again.status,200);assert.equal(st.connects,5);
 assert.equal(st.clients[4].released,false,'leitura concluída devolve a conexão ao pool');
});

test('abort conferido logo após obter a conexão: operação vencida não executa BEGIN, SET nem identidade e descarta a conexão',async t=>{
 const hold=gate(),{pool,st}=fakePool({holdConnect:hold}),{app,transaction,get}=await serve(t,pool);
 const r=await get();assert.equal(r.status,503);
 assert.equal(st.connects,1);assert.equal(transaction.active(),1);assert.equal(app.active(),1);
 hold.open();
 await until(()=>transaction.active()===0&&app.active()===0);
 assert.deepEqual(st.clients[0].queries,[],'nenhuma instrução numa operação já abandonada');
 assert.equal(st.clients[0].released,true);
});

test('parada espera a transação abandonada terminar antes de concluir',async t=>{
 const hold=gate(),{pool}=fakePool({holdQuery:hold}),{app,transaction,get}=await serve(t,pool);
 assert.equal((await get()).status,503);
 let stopped=false;const s=app.stop().then(()=>{stopped=true;});
 await tick(50);assert.equal(stopped,false,'stop não termina com transação viva');
 hold.open();await s;assert.equal(stopped,true);assert.equal(transaction.active(),0);
});
