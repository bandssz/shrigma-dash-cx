'use strict';
// Percurso completo, modo LISTAS (sem público salvo), da tela ao serviço. Harness em
// tests/helpers/claude-crm-screen-fixture.cjs (growth.html + bundle publicado → GCE/GCA →
// HTTP real do crm-campaign em loopback → gateway/store/provider/vínculo em PGlite;
// só o adaptador nativo é fictício). Sem rede externa, dados e chaves fictícios.
const test=require('node:test'),assert=require('node:assert/strict');
const {backend,page,until,idle,reopen,campaignPosts,state,conferir,agendarPelaTela,CAMPAIGN}=require('./helpers/claude-crm-screen-fixture.cjs');

for(const brand of ['fish','aristo']){
 const id=CAMPAIGN[brand];
 test(brand+': rascunho só com listas → reabrir → vínculo nulo → conferir → agendar pela tela: um agendamento persistido e uma única intenção de agenda',async t=>{
  const be=await backend(t),x=await page(be,brand);
  await reopen(x,id);
  // Modo listas: vínculo nulo confirmado pelo GET real do vínculo, sem público salvo e sem POST de vínculo.
  assert.match(state(x).saved,/Nenhum público salvo vinculado a esta campanha/);
  assert.equal(x.calls.filter(c=>c.to==='binding').map(c=>c.method+':'+c.acao).join(),'GET:campanha_publico_obter');
  assert.equal(x.calls.filter(c=>c.to==='audience').length,0,'modo listas não exige públicos salvos');
  await conferir(x);
  await agendarPelaTela(x,brand);await until(()=>x.calls.some(c=>c.acao==='campanha_agendar')&&idle(x),x,'agendar');
  assert.match(state(x).server,/^Agendada · 0 enviados/);assert.equal(state(x).schedule.disabled,true);
  assert.deepEqual(await be.row(id),{status:'scheduled',sent:0,started_at:null});
  assert.deepEqual((await be.operations()).filter(o=>o.brand===brand&&o.action!=='salvar').map(o=>o.action+':'+o.state),['validar:succeeded','agendar:succeeded']);
  assert.equal(be.effects.filter(e=>e.kind==='provider'&&e.action==='schedule').length,1,'uma única intenção de agenda no provider');
  assert.deepEqual(be.intents,[],'agenda não passa pelo adaptador nativo (sem Listmonk)');
  assert.deepEqual(campaignPosts(x).map(c=>c.acao),['campanha_validar','campanha_agendar']);
  assert.equal(new Set(campaignPosts(x).map(c=>c.idempotency_key)).size,2);
  // A outra marca continua intacta.
  const other=brand==='fish'?200:100;assert.equal((await be.row(other)).status,'draft');
 });

 test(brand+': ACK do agendar perdido depois do commit → diário travado, sem outro POST; recarregar a tela e consultar pela leitura reconcilia como agendada',async t=>{
  const be=await backend(t),store=new Map();let lost=0;
  const x=await page(be,brand,{store,loseAck:acao=>acao==='campanha_agendar'&&++lost===1});
  await reopen(x,id);await conferir(x);await agendarPelaTela(x,brand);
  await until(()=>lost===1&&!x.run('GCE.contextStatus().reading')&&!x.run('GCE.contextStatus().confirming')&&!x.q('[data-ce-consult]').hidden,x,'ACK perdido');
  assert.match(state(x).status,/Resultado não confirmado\. Consulte a operação antes de repetir/);assert.match(state(x).server,/Resultado pendente ou incerto\. Edição e novas tentativas bloqueadas; consulte a mesma operação/);
  // O serviço gravou; a tela não sabe. Nada é repetido em silêncio e agendar fica fechado.
  assert.equal((await be.row(id)).status,'scheduled');
  assert.equal(campaignPosts(x,'campanha_agendar').length,1);assert.equal(state(x).schedule.disabled,true);
  const journal=JSON.parse(store.get('shrigma_campaign_operation_v1:'+brand));assert.equal(journal.operation?.phase,'uncertain');assert.equal(journal.operation.request.acao,'campanha_agendar');const key=journal.operation.key;
  assert.equal(key,campaignPosts(x,'campanha_agendar')[0].idempotency_key);
  // Clique no botão real de agendar (sem forçar o atributo): continua sem POST.
  state(x).schedule.click();await new Promise(r=>setTimeout(r,30));assert.equal(campaignPosts(x,'campanha_agendar').length,1);
  // Recarregar a tela com o mesmo armazenamento: o diário volta travado e o caminho é consultar.
  const y=await page(be,brand,{store});await until(()=>idle(y)||!y.q('[data-ce-consult]').hidden,y,'recarregar');
  assert.equal(y.q('[data-ce-consult]').hidden,false,'consulta da mesma tentativa disponível');assert.equal(state(y).schedule.disabled,true);
  assert.equal(campaignPosts(y).length,0,'recarregar não reenvia');
  y.q('[data-ce-consult]').click();await until(()=>y.calls.some(c=>c.acao==='campanha_operacao')&&idle(y),y,'consulta');
  const reads=y.calls.filter(c=>c.acao==='campanha_operacao');assert.equal(reads.length,1);assert.equal(reads[0].method,'GET');assert.equal(reads[0].idempotency_key,key);
  assert.match(state(y).server,/^Agendada · 0 enviados/);assert.equal(state(y).schedule.disabled,true);
  assert.equal(campaignPosts(y).length,0);assert.equal(campaignPosts(x,'campanha_agendar').length,1);
  assert.equal(be.effects.filter(e=>e.kind==='provider'&&e.action==='schedule').length,1);assert.deepEqual(be.intents,[]);
  assert.deepEqual((await be.operations()).filter(o=>o.brand===brand&&o.action==='agendar').map(o=>o.state),['succeeded']);
  // Diário preservado até a consulta resolver; não foi apagado pelo teste nem pela tela antes disso.
  assert.ok(store.has('shrigma_campaign_operation_v1:'+brand));
 });
}
