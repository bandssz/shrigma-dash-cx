'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../n8n/tiktok/cobranca-safety.cjs'),'utf8');
// No require, fetch, http, timers or process in the VM; transports are explicit mocks only.
const context=vm.createContext({module:{exports:{}}});new vm.Script(source).runInContext(context);
const {evaluateConversation,executeIntent,createPostgresStore}=context.module.exports;
const now=Date.parse('2026-01-15T12:00:00Z');
const open=overrides=>({code:0,data:{conversation_id:'c',creator_im_id:'creator-im',username:'synthetic',is_new:false,unread_count:0,...overrides}});
const read=messages=>({code:0,data:{messages},coverage:{complete:true,conversation_id:'c'}});
const message=(sender='seller',age=9,type='TEXT')=>({message_body:{sender_id:sender,create_time:(now-age*864e5)/1000,type,content:'synthetic'}});
const identity={username:'synthetic'};
function harness(overrides={}){
 const events=[],records=[];
 let state='none';
 const store={
  async claim(){events.push('claim');if(state!=='none')return{allowed:false,reason:'reserved'};state='reservado';return{allowed:true,review_id:'review',owner:'owner',state:'reservado',brand:'fixture',username:'synthetic',creator_open_id:'openid',reference:'reference',stage:'amostra_sem_video',attempt:1,text:'approved text'};},
  async dispatch(){events.push('dispatch');if(overrides.dispatchError)throw Error('synthetic storage failure');if(overrides.dispatchBlocked){state='bloqueado';return{allowed:false,reason:'pause'};}state='em_transporte';return Object.hasOwn(overrides,'dispatchReceipt')?overrides.dispatchReceipt:{allowed:true,state:'em_transporte',review_id:'review',owner:'owner'};},
  async finish(review,owner,next,reason){events.push('finish:'+next);records.push({next,reason});if(overrides.finishError)throw Error('synthetic storage failure');state=next;return{recorded:true};},
  async simulate(){events.push('simulate');return{simulated:true};},
 };
 const transport={
  async openConversation(){events.push('open');assert.equal(state,'reservado');if(overrides.openThrow)throw Error('synthetic timeout');return overrides.open??open();},
  async readMessages(){events.push('read');if(overrides.readThrow)throw Error('synthetic timeout');return overrides.read??read([message()]);},
  async sendMessage(input){events.push('send');assert.equal(state,'em_transporte','durable transition precedes transport');assert.equal(input.text,'approved text');if(overrides.sendThrow)throw Error('synthetic timeout');return overrides.send??{code:0,data:{message_id:'synthetic-message'}};},
 };
 return{events,records,store,transport,state:()=>state,run:opts=>executeIntent({reviewId:'review',owner:'owner',...opts},{store,transport,now:()=>now})};
}
test('IM absence, failed read, unread, unknown identity/type/time and human response fail closed',()=>{
 const cases=[
  [null,read([]),'im_abertura_invalida'],
  [{code:401},read([]),'im_abertura_invalida'],
  [open({is_new:undefined}),read([]),'im_identidade_incompleta'],
  [open({creator_im_id:null}),read([]),'im_identidade_incompleta'],
  [open({username:'other'}),read([]),'im_identidade_divergente'],
  [open({unread_count:undefined}),read([]),'im_nao_lidas_desconhecido'],
  [open({unread_count:2}),read([]),'im_nao_lidas'],
  [open(),{code:403},'im_leitura_invalida'],
  [open(),{code:0,data:{}},'im_leitura_invalida'],
  [open(),read([]),'im_historico_ausente'],
  [open(),read([message('seller',9,'UNKNOWN')]),'im_mensagem_desconhecida'],
  [open(),read([message('seller',-1)]),'im_data_invalida'],
  [open(),read([message('creator-im',100)]),'im_resposta_criador'],
  [open(),read([message('seller',1)]),'im_conversa_recente'],
 ];
 for(const [opening,reading,reason] of cases){const out=evaluateConversation(opening,reading,identity,now);assert.equal(out.allowed,false);assert.equal(out.reason,reason);}
 assert.equal(evaluateConversation(open({is_new:true}),read([]),identity,now).allowed,true);
 assert.equal(evaluateConversation(open(),read([message()]),identity,now).allowed,true);
});
test('SQL adapter binds values separately and rejects missing/malformed response',async()=>{
 const calls=[];const s=createPostgresStore(async(sql,params)=>{calls.push({sql,params});return{rows:[{result:{allowed:false}}]};});
 const hostile="review'); DROP TABLE synthetic; --";await s.claim(hostile,'owner');
 assert.equal(calls[0].sql.includes(hostile),false);assert.equal(calls[0].params[0],hostile);assert.ok(calls[0].sql.includes('$1'));
 const bad=createPostgresStore(async()=>({rows:[]}));await assert.rejects(bad.claim('x','y'),/Invalid SQL/);
});
test('simulation is separated and never claims or calls transport',async()=>{
 const h=harness();assert.equal((await h.run({simulate:true})).simulated,true);assert.deepEqual(h.events,['simulate']);assert.equal(h.state(),'none');
});
test('reserve, preflight, durable dispatch and accepted outcome occur in order; accepted is not delivered',async()=>{
 const h=harness();assert.equal((await h.run()).state,'aceito');assert.deepEqual(h.events,['claim','open','read','dispatch','send','finish:aceito']);
 assert.equal((await h.run()).state,'nao_reservado');assert.equal(h.events.filter(x=>x==='send').length,1);
});
test('every failed preflight produces zero message calls',async()=>{
 for(const overrides of [{open:open({is_new:undefined})},{open:open({unread_count:2})},{read:{code:401}},{read:read([])},{read:read([message('creator-im',50)])}]){
  const h=harness(overrides);assert.equal((await h.run()).state,'bloqueado');assert.equal(h.events.includes('send'),false);assert.equal(h.events.includes('dispatch'),false);
 }
});
test('timeout and ambiguous provider response become uncertain and never automatically retry',async()=>{
 for(const overrides of [{openThrow:true},{readThrow:true},{sendThrow:true},{send:{code:500}},{send:{}}]){
  const h=harness(overrides);assert.equal((await h.run()).state,'incerto');const sends=h.events.filter(x=>x==='send').length;
  await h.run();assert.equal(h.events.filter(x=>x==='send').length,sends);
 }
});
test('unknown SQL transition never sends; lost final persistence retains transport fence',async()=>{
 const missing=harness({dispatchError:true});assert.equal((await missing.run()).state,'incerto');assert.equal(missing.events.includes('send'),false);assert.equal(missing.state(),'reservado');
 const stopped=harness({dispatchBlocked:true});assert.equal((await stopped.run()).state,'bloqueado');assert.equal(stopped.events.includes('send'),false);
 const lost=harness({finishError:true});assert.equal((await lost.run()).state,'incerto');assert.equal(lost.state(),'em_transporte');await lost.run();assert.equal(lost.events.filter(x=>x==='send').length,1);
});
test('overlapping orchestrators obtain at most one transport',async()=>{
 const h=harness();const results=await Promise.all([h.run(),h.run(),h.run()]);assert.equal(results.filter(r=>r.state==='aceito').length,1);assert.equal(h.events.filter(e=>e==='send').length,1);
});

test('malformed claimed identity or wrong owner fails before transport',async()=>{
 const h=harness();h.store.claim=async()=>({allowed:true,review_id:'review',owner:'wrong',state:'reservado'});
 assert.equal((await h.run()).state,'bloqueado');assert.equal(h.events.includes('open'),false);assert.equal(h.events.includes('send'),false);
});

test('partial, missing, mismatched or contradictory history coverage never reaches durable dispatch',async()=>{
 const base=read([message()]);
 const cases=[
  {...base,coverage:undefined},
  {...base,coverage:{complete:false,conversation_id:'c'}},
  {...base,coverage:{complete:'true',conversation_id:'c'}},
  {...base,coverage:{complete:true,conversation_id:'other-conversation'}},
  {...base,data:{...base.data,has_more:true,next_page_token:'next-page'}},
  {...base,data:{...base.data,has_more:null}},
  {...base,data:{...base.data,next_page_token:'next-page'}},
 ];
 for(const reading of cases){
  assert.equal(evaluateConversation(open(),reading,identity,now).reason,'im_historico_incompleto');
  const h=harness({read:reading});assert.equal((await h.run()).state,'bloqueado');assert.equal(h.events.includes('dispatch'),false);assert.equal(h.events.includes('send'),false);
 }
 const complete={...base,data:{...base.data,has_more:false,next_page_token:''}};assert.equal(evaluateConversation(open(),complete,identity,now).allowed,true);
 const creatorOnNextPage=read([message(),message('creator-im',20)]);assert.equal(evaluateConversation(open(),creatorOnNextPage,identity,now).reason,'im_resposta_criador');
});
test('timestamp coercion cannot turn unknown provider data into an old safe message',async()=>{
 for(const timestamp of [true,false,null,{},[],[1],'',' ',' 1','1e3','Infinity',NaN,Infinity]){
  const m=message();m.message_body.create_time=timestamp;const reading=read([m]);
  assert.equal(evaluateConversation(open(),reading,identity,now).reason,'im_data_invalida');
  const h=harness({read:reading});assert.equal((await h.run()).state,'bloqueado');assert.equal(h.events.includes('send'),false);
 }
 const numericText=message();numericText.message_body.create_time=String(numericText.message_body.create_time);
 assert.equal(evaluateConversation(open(),read([numericText]),identity,now).allowed,true);
});
test('dispatch acknowledgement must prove committed state and match both review and owner',async()=>{
 for(const receipt of [null,{}, {allowed:true},{allowed:true,state:'reservado',review_id:'review',owner:'owner'},
  {allowed:true,state:'em_transporte',review_id:'other',owner:'owner'},
  {allowed:true,state:'em_transporte',review_id:'review',owner:'other'}]){
  const h=harness({dispatchReceipt:receipt});assert.equal((await h.run()).state,'incerto');
  assert.equal(h.state(),'em_transporte','durable reservation is preserved despite a malformed receipt');assert.equal(h.events.includes('send'),false);assert.equal(h.records.length,0,'no guessed terminal state is written');
  await h.run();assert.equal(h.events.includes('send'),false,'another call cannot bypass the held reservation');
 }
});
