'use strict';
// Bordas do percurso de campanhas pela tela (continuação da #223), no mesmo harness:
// growth.html + bundle publicado → GCE/GCA → HTTP real do crm-campaign em loopback →
// gateway/store/provider/recovery/write-guard + vínculo reais em PGlite; só o adaptador
// nativo é fictício. Sem rede externa; dados, e-mails e chaves fictícios.
//  1. salvar pelos controles reais (com ACK perdido), reabrir, conferir e agendar;
//  2. cancelar com ACK perdido, clique repetido, recarga e consulta;
//  3. submit retirado depois da conferência / chave revogada com a confirmação aberta;
//  4. intenção incerta preservada enquanto a leitura (read_content) está retirada;
//  5. vínculo nulo → público vinculado entre a conferência e a confirmação.
const test=require('node:test'),assert=require('node:assert/strict');
const {backend,page,until,idle,reopen,campaignPosts,state,conferir,agendarPelaTela,abrirConfirmacaoAgendar,CAMPAIGN,CAPS}=require('./helpers/claude-crm-screen-fixture.cjs');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const effects=(be,action)=>be.effects.filter(e=>e.kind==='provider'&&e.action===action).length;
const ops=async(be,brand,action)=>(await be.operations()).filter(o=>o.brand===brand&&o.action===action).map(o=>o.state);
const setCaps=(be,caps)=>be.db.query("UPDATE shrigma_panel_permission_v1 SET caps=$1::jsonb WHERE principal_id='manager'",[JSON.stringify(caps)]);
const journal=(store,brand)=>JSON.parse(store.get('shrigma_campaign_operation_v1:'+brand)||'null');
async function settledAfter(x,acao,label){await until(()=>x.calls.some(c=>c.acao===acao)&&x.calls.filter(c=>c.acao===acao).every(c=>c.status!==undefined)&&!x.run('GCE.contextStatus().reading')&&!x.run('GCE.contextStatus().confirming')&&!x.q('[data-ce-confirm]').open&&(idle(x)||!x.q('[data-ce-consult]').hidden),x,label);await wait(30);}

for(const brand of ['fish','aristo']){
 const id=CAMPAIGN[brand];
 test(brand+': salvar pela tela com ACK perdido → recarregar → consultar → conferir → agendar; um salvar e um agendar',async t=>{
  const be=await backend(t,{standardize:false}),store=new Map();let lost=0;
  const x=await page(be,brand,{store,loseAck:acao=>acao==='campanha_salvar'&&++lost===1});
  await reopen(x,id);
  // Rascunho de listas ainda não padronizado: a conferência é recusada pelo serviço, sem efeito.
  state(x).validate.click();await settledAfter(x,'campanha_validar','conferência recusada');
  assert.match(state(x).status,/Salve a campanha pelo cadastro padronizado antes de validar/);assert.equal(state(x).schedule.disabled,true);
  assert.deepEqual(await ops(be,brand,'validar'),['rejected'],'recusa registrada, sem efeito');
  // Edição e Salvar pelos controles reais; a resposta se perde depois do commit.
  const subject=x.q('[name=subject]');subject.value='Assunto revisado pela tela '+brand;subject.dispatchEvent(new x.window.Event('input',{bubbles:true}));
  assert.equal(x.q('[data-ce-save]').disabled,false);x.q('[data-ce-save]').click();await settledAfter(x,'campanha_salvar','salvar');
  assert.match(state(x).status,/Resultado não confirmado\. Consulte a operação antes de repetir/);
  assert.equal(journal(store,brand).operation.phase,'uncertain');const key=journal(store,brand).operation.key;
  assert.deepEqual(await ops(be,brand,'salvar'),['succeeded']);assert.equal((await be.f.current(id)).definition.subject,'Assunto revisado pela tela '+brand);
  x.q('[data-ce-save]').click();x.q('[data-ce-validate]').click();await wait(40);
  assert.deepEqual(campaignPosts(x,'campanha_salvar').map(c=>c.idempotency_key),[key],'nenhum segundo salvar após clique repetido');
  // Recarregar: o diário volta travado, nada é reenviado; a consulta usa a mesma chave por GET.
  const y=await page(be,brand,{store});assert.equal(campaignPosts(y).length,0);assert.equal(y.q('[data-ce-consult]').hidden,false);
  assert.equal(y.q('[name=subject]').value,'Assunto revisado pela tela '+brand,'rascunho local preservado');
  y.q('[data-ce-consult]').click();await until(()=>y.calls.some(c=>c.acao==='campanha_operacao')&&idle(y),y,'consulta');
  assert.deepEqual(y.calls.filter(c=>c.acao==='campanha_operacao').map(c=>c.method+':'+c.idempotency_key),['GET:'+key]);
  assert.match(state(y).server,/Conteúdo corresponde à versão salva/);
  await conferir(y);await agendarPelaTela(y,brand);await settledAfter(y,'campanha_agendar','agendar');
  assert.equal((await be.row(id)).status,'scheduled');assert.equal(effects(be,'schedule'),1);
  assert.deepEqual(await ops(be,brand,'salvar'),['succeeded']);assert.deepEqual(campaignPosts(y).map(c=>c.acao),['campanha_validar','campanha_agendar']);
  assert.deepEqual(be.intents.filter(k=>k!=='preview'),[],'nenhuma criação nativa');
 });

 test(brand+': cancelar com ACK perdido → clique repetido → recarregar → consultar: uma intenção de cancelamento',async t=>{
  const be=await backend(t),store=new Map();let lost=0;
  const x=await page(be,brand,{store,loseAck:acao=>acao==='campanha_cancelar'&&++lost===1});
  await reopen(x,id);await conferir(x);await agendarPelaTela(x,brand);await settledAfter(x,'campanha_agendar','agendar');
  assert.equal(x.q('[data-ce-cancel]').disabled,false);x.q('[data-ce-cancel]').click();
  assert.equal(x.q('[data-ce-confirm]').open,true);assert.match(x.q('[data-ce-confirm-text]').textContent,/Cancelar o agendamento de/);x.q('[data-ce-confirm-yes]').click();
  await settledAfter(x,'campanha_cancelar','cancelar');
  assert.equal((await be.row(id)).status,'cancelled','o serviço gravou');assert.match(state(x).server,/^Agendada .*Resultado pendente ou incerto/,'a tela não presume o resultado');
  const key=journal(store,brand).operation.key;assert.equal(journal(store,brand).operation.request.acao,'campanha_cancelar');
  x.q('[data-ce-cancel]').click();await wait(30);assert.equal(x.q('[data-ce-confirm]').open,false);assert.equal(campaignPosts(x,'campanha_cancelar').length,1);
  const y=await page(be,brand,{store});assert.equal(campaignPosts(y).length,0);
  y.q('[data-ce-consult]').click();await until(()=>y.calls.some(c=>c.acao==='campanha_operacao')&&idle(y),y,'consulta');
  assert.deepEqual(y.calls.filter(c=>c.acao==='campanha_operacao').map(c=>c.idempotency_key),[key]);assert.match(state(y).server,/^Cancelada · 0 enviados/);
  assert.equal(effects(be,'cancel'),1);assert.deepEqual(await ops(be,brand,'cancelar'),['succeeded']);assert.equal(campaignPosts(y).length,0);
  assert.deepEqual(await be.row(id),{status:'cancelled',sent:0,started_at:null});
 });
}

test('fish: submit retirado depois da conferência → agendar recusado pelo serviço, sem efeito nem tentativa incerta',async t=>{
 const be=await backend(t),store=new Map(),x=await page(be,'fish',{store});await reopen(x,100);await conferir(x);
 await setCaps(be,['read_content','draft','validate']);
 await agendarPelaTela(x,'fish');await settledAfter(x,'campanha_agendar','agendar');
 assert.match(state(x).status,/Esta chave não tem permissão para a ação/);
 assert.equal((await be.row(100)).status,'draft');assert.equal(effects(be,'schedule'),0);assert.deepEqual(await ops(be,'fish','agendar'),[]);
 assert.notEqual(journal(store,'fish').operation?.phase,'uncertain','recusa definitiva não vira incerta');
 assert.equal(campaignPosts(x,'campanha_agendar').length,1);
});

test('aristo: chave revogada com a confirmação aberta → agendar recusado, sem efeito',async t=>{
 const be=await backend(t),x=await page(be,'aristo');await reopen(x,200);await conferir(x);
 await abrirConfirmacaoAgendar(x);assert.equal(x.q('[data-ce-confirm]').open,true);
 await be.db.query("UPDATE crm_dash_chave SET revogada_em=now() WHERE chave='manager'");
 x.q('[data-ce-confirm-yes]').click();await settledAfter(x,'campanha_agendar','agendar');
 assert.equal((await be.row(200)).status,'draft');assert.equal(effects(be,'schedule'),0);assert.deepEqual(await ops(be,'aristo','agendar'),[]);
 assert.doesNotMatch(state(x).server,/^Agendada/);
});

test('fish: ACK do agendar perdido e leitura retirada → a consulta é recusada e a intenção incerta continua preservada até a leitura voltar',async t=>{
 const be=await backend(t),store=new Map();let lost=0;
 const x=await page(be,'fish',{store,loseAck:acao=>acao==='campanha_agendar'&&++lost===1});await reopen(x,100);await conferir(x);
 await agendarPelaTela(x,'fish');await settledAfter(x,'campanha_agendar','agendar');const key=journal(store,'fish').operation.key;
 await setCaps(be,['draft','validate','submit']);
 const y=await page(be,'fish',{store});y.q('[data-ce-consult]').click();await until(()=>y.calls.some(c=>c.acao==='campanha_operacao')&&!y.run('GCE.contextStatus().reading'),y,'consulta recusada');await wait(30);
 assert.equal(journal(store,'fish').operation.key,key);assert.equal(journal(store,'fish').operation.phase,'uncertain','diário não é apagado nem resolvido sem leitura');
 assert.equal(state(y).schedule.disabled,true);assert.equal(campaignPosts(y).length,0);
 await setCaps(be,CAPS);
 const z=await page(be,'fish',{store});z.q('[data-ce-consult]').click();await until(()=>z.calls.some(c=>c.acao==='campanha_operacao')&&idle(z),z,'consulta');
 assert.match(state(z).server,/^Agendada · 0 enviados/);assert.equal(effects(be,'schedule'),1);assert.equal(campaignPosts(z).length+campaignPosts(y).length,0);
 assert.deepEqual(await ops(be,'fish','agendar'),['succeeded']);
});

for(const brand of ['fish','aristo']){
 const id=CAMPAIGN[brand],list=brand==='fish'?101:201;
 async function bindAudience(be){const a=await be.f.createAudience(brand,'publico-tela-'+brand,{op:'in_list',list_id:list});const i=await be.f.inspect(brand,id,a);assert.equal(i.status,200);const b=await be.f.bind(i.body.intent,'tela-bind-'+brand+'-0000001');assert.equal(b.status,201);}
 test(brand+': público vinculado por outra sessão depois da conferência → a confirmação relê o vínculo e não agenda',async t=>{
  const be=await backend(t),x=await page(be,brand);await reopen(x,id);await conferir(x);
  await bindAudience(be);
  state(x).schedule.click();await until(()=>!x.run('GCE.contextStatus().reading')&&idle(x)&&x.calls.filter(c=>c.acao==='campanha_publico_obter').length>=3,x,'releitura do vínculo');await wait(20);
  assert.equal(x.q('[data-ce-confirm]').open,false,'confirmação não abre com vínculo novo');
  assert.match(state(x).status,/vínculo de público desta campanha mudou/);assert.match(state(x).saved,/Público vinculado · versão 1/);
  assert.equal(state(x).schedule.disabled,true);assert.equal(campaignPosts(x,'campanha_agendar').length,0);
  assert.equal((await be.row(id)).status,'draft');assert.equal(effects(be,'schedule'),0);
 });
 test(brand+': vínculo criado durante o envio do agendar → recusa transacional comprovada relê o vínculo e fecha o agendamento por listas',async t=>{
  const be=await backend(t),store=new Map();let once=false;
  const x=await page(be,brand,{store,beforeCampaign:async acao=>{if(acao==='campanha_agendar'&&!once){once=true;await bindAudience(be);}}});
  await reopen(x,id);await conferir(x);await agendarPelaTela(x,brand);await settledAfter(x,'campanha_agendar','agendar');
  await until(()=>journal(store,brand).operation.phase!=='pending',x,'resposta do agendar');
  assert.equal((await be.row(id)).status,'draft');assert.equal(effects(be,'schedule'),1,'uma tentativa de agenda, barrada pela guarda');
  const s=await ops(be,brand,'agendar');assert.equal(s.length,1);assert.equal(s[0],'rejected','a exceção SQL conhecida comprova rollback e grava recusa definitiva');
  const response=x.calls.find(c=>c.acao==='campanha_agendar');assert.equal(response.status,409);
  assert.equal(journal(store,brand).operation.phase,'rejected');assert.match(state(x).status,/campanha usa um público salvo/);
  // Depois da recusa comprovada, a tela mostra o vínculo atual e não oferece outra tentativa por listas.
  assert.match(state(x).saved,/Público vinculado · versão 1/);assert.equal(state(x).schedule.disabled,true);assert.equal(state(x).validate.disabled,true);
  state(x).schedule.click();state(x).validate.click();await wait(40);
  assert.equal(campaignPosts(x,'campanha_agendar').length,1);assert.equal(effects(be,'schedule'),1);assert.equal((await be.row(id)).status,'draft');
 });
}
