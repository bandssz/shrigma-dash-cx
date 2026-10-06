'use strict';
// Rev3: arquivar/recovery e encerramento de intenção. Capability por ação, ACK perdido no
// arquivamento, revisão de registro divergente, dispose com envio pendente, rascunho após
// confirmação, endereço já arquivado não reativado, contexto sem vazamento de credencial.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./harness.cjs');

const submitBtn = t => t.q('[data-ov-form="link-create"] button[type="submit"]');
const opState = t => t.q('[data-ov-op]').getAttribute('data-ov-op');
const archiveBtn = (t, id) => t.q('[data-ov-action="archive"][data-ov-link="' + id + '"]');

test('capability por ação: arquivar aberto com criar fechado, e o inverso', async () => {
  const a = setup({ ctx: { capabilities: { 'link.create': { available: false, reason: 'Criação não admitida.' }, 'link.archive': true } } });
  await a.syncNow();
  assert.equal(submitBtn(a).disabled, true);
  assert.equal(archiveBtn(a, 'l1').disabled, false);
  const b = setup({ ctx: { capabilities: { 'link.create': true, 'link.archive': { available: false, reason: 'Arquivamento não admitido.' } } } });
  await b.syncNow();
  assert.equal(submitBtn(b).disabled, false);
  assert.equal(archiveBtn(b, 'l1').disabled, true);
  assert.equal(archiveBtn(b, 'l1').getAttribute('title'), 'Arquivamento não admitido.');
});

test('arquivar com ACK perdido: incerto, sem nova tentativa, recuperado pelo recibo da mesma operação', async () => {
  const t = setup();
  t.modes.submit = 'lose-ack';
  await t.syncNow();
  await t.click(archiveBtn(t, 'l1'));
  await t.click('[data-ov-action="op-confirm"]');
  assert.equal(opState(t), 'uncertain');
  assert.equal(archiveBtn(t, 'l1').disabled, true, 'nenhum novo arquivamento enquanto incerto');
  assert.equal(submitBtn(t).disabled, true);
  await t.click('[data-ov-action="receipt"]');
  assert.equal(opState(t), 'confirmed');
  assert.match(t.text('[data-ov-op]'), /histórico preservado/);
  assert.ok(t.q('[data-ov-archived-row="l1"]'));
  assert.equal(t.calls.beginMutation.length, 1);
  assert.equal(t.calls.submit.length, 1);
  assert.deepEqual(t.calls.receipt.map(r => r.operationId), ['op-1']);
  assert.equal(t.server.links.aristo.find(l => l.id === 'l1').revision, 4, 'uma única transição no servidor');
});

test('arquivar com revisão do registro divergente: recusa visível, link segue ativo, sem reenvio com outra revisão', async () => {
  const t = setup();
  await t.syncNow();
  await t.click(archiveBtn(t, 'l1'));
  t.server.links.aristo[0].revision = 9; // alguém alterou o registro entre leitura e confirmação
  await t.click('[data-ov-action="op-confirm"]');
  assert.equal(opState(t), 'rejected');
  assert.match(t.text('[data-ov-op]'), /Revisão do registro mudou/);
  assert.equal(t.server.links.aristo[0].state, 'active');
  assert.equal(t.calls.beginMutation.length, 1);
  assert.equal(t.calls.submit.length, 1);
  assert.ok(t.q('[data-ov-link-row="l1"]'), 'continua na lista ativa');
});

test('dispose com envio pendente: resposta tardia não remonta nada nem gera chamadas', async () => {
  const t = setup();
  await t.syncNow();
  await t.review();
  t.hold('submit');
  t.q('[data-ov-action="op-confirm"]').click(); await t.flush();
  const reads = t.calls.read.length, contexts = t.calls.context;
  t.inst.dispose();
  t.release('submit'); await t.flush();
  assert.equal(t.host.childNodes.length, 0);
  assert.equal(t.calls.read.length, reads, 'nenhuma releitura depois do dispose');
  assert.equal(t.calls.context, contexts, 'nem leitura de contexto depois do dispose');
  assert.equal(t.calls.receipt.length, 0);
  assert.equal(t.calls.submit.length, 1);
});

test('rascunho: limpo após criação confirmada, preservado após recusa', async () => {
  const t = setup();
  await t.syncNow();
  await t.review();
  await t.click('[data-ov-action="op-confirm"]');
  assert.equal(opState(t), 'confirmed');
  for (const k of ['destination', 'origin', 'surface', 'campaign', 'date']) assert.equal(t.q('[data-ov-draft="' + k + '"]').value, '', k);
  await t.click('[data-ov-action="op-dismiss"]');
  t.modes.submit = 'reject';
  await t.review({ destination: 'https://oaristocrata.com/products/outro', origin: 'whatsapp', surface: 'dm', campaign: 'recusado' });
  await t.click('[data-ov-action="op-confirm"]');
  assert.equal(opState(t), 'rejected');
  assert.equal(t.q('[data-ov-draft="campaign"]').value, 'recusado');
  // Rascunho preservado pode ser revisado de novo, mas só vira envio com nova confirmação explícita:
  t.q('[data-ov-form="link-create"]').dispatchEvent({ type: 'submit' }); await t.flush();
  assert.equal(opState(t), 'prepared');
  assert.equal(t.calls.beginMutation.length, 3);
  assert.equal(t.calls.submit.length, 2, 'só as duas confirmações viraram envio');
});

test('mesmo endereço de um link arquivado: servidor devolve o arquivado e a UI não o reativa nem oferece cópia', async () => {
  const t = setup();
  t.server.links.aristo.push({ id: 'arq', brandId: 'aristo', destination: 'https://oaristocrata.com/products/novo', url: 'https://oaristocrata.com/products/novo?utm_source=instagram_social&utm_medium=story&utm_campaign=20261005_kit_novo', origin: 'instagram_social', surface: 'story', state: 'archived', revision: 2, createdAt: '2026-09-01T12:00:00.000Z' });
  await t.syncNow();
  await t.review();
  await t.click('[data-ov-action="op-confirm"]');
  assert.equal(opState(t), 'confirmed');
  assert.ok(t.q('[data-ov-op-state="archived-existing"]'));
  assert.equal(t.q('[data-ov-action="copy-result"]'), null);
  assert.equal(t.server.links.aristo.find(l => l.id === 'arq').state, 'archived');
  assert.ok(t.q('[data-ov-archived-row="arq"]'));
  assert.equal(t.q('[data-ov-link-row="arq"]'), null);
});

test('campos estranhos no contexto (token/chave) nunca chegam ao DOM nem às requisições', async () => {
  const t = setup({ ctx: { bearer: 'SEGREDO-BEARER', masterKey: 'SEGREDO-MESTRE', readKey: 'SEGREDO-LEITURA', role: 'master', capabilities: {} } });
  await t.syncNow();
  assert.doesNotMatch(t.text(), /SEGREDO/);
  const html = JSON.stringify(t.host.querySelectorAll('[value]').map(e => e.value));
  assert.doesNotMatch(html, /SEGREDO/);
  assert.doesNotMatch(JSON.stringify(t.calls.read.map(c => c.req)), /SEGREDO|bearer|Key/);
  assert.equal(submitBtn(t).disabled, true, 'papel Mestre sem capability continua fechado');
});

test('mudança de sessionRevision invalida o contexto e descarta a revisão preparada', async () => {
  const t = setup();
  await t.syncNow();
  await t.review();
  assert.equal(opState(t), 'prepared');
  t.setCtx({ sessionRevision: 's2' });
  await t.syncNow();
  assert.equal(opState(t), '');
  assert.equal(t.calls.submit.length, 0);
});

test('servidor confirmou na marca anterior, resposta chega após a troca: nada é aplicado à nova marca', async () => {
  const t = setup();
  await t.syncNow();
  await t.review();
  t.hold('submit', { eager: true });
  t.q('[data-ov-action="op-confirm"]').click(); await t.flush();
  assert.equal(t.server.links.aristo.length, 2, 'execução registrada na marca anterior');
  t.setCtx({ effectiveBrand: 'fish', contextRevision: 'r2' });
  await t.syncNow();
  t.draft({ campaign: 'rascunho_fish' });
  const contexts = t.calls.context, reads = t.calls.read.length;
  t.release('submit'); await t.flush();
  assert.equal(opState(t), '');
  assert.equal(t.q('[data-ov-draft="campaign"]').value, 'rascunho_fish', 'rascunho da nova marca intacto');
  assert.equal(t.calls.context, contexts);
  assert.equal(t.calls.read.length, reads);
  assert.doesNotMatch(t.text('[data-ov-section="links"]'), /oaristocrata/);
});
