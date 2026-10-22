'use strict';
// Links UTM: criar/reler/copiar/arquivar permitido vs fechado, confirmação + leitura falha,
// ACK incerto sem repetir escrita, journal pendente e respostas fora de contexto.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./harness.cjs');

const submitBtn = t => t.q('[data-ov-form="link-create"] button[type="submit"]');
const opState = t => t.q('[data-ov-op]').getAttribute('data-ov-op');

test('fechado sem capability: nenhum begin, arquivar e criar desabilitados com motivo', async () => {
  const t = setup({ ctx: { capabilities: {} } });
  await t.syncNow();
  assert.equal(submitBtn(t).disabled, true);
  assert.match(t.text('[data-ov-cap]'), /não admitida pelo integrador/);
  await t.review();
  assert.ok(t.qa('[data-ov-action="archive"]').every(b => b.disabled));
  t.qa('[data-ov-action="archive"]')[0].click(); await t.flush();
  assert.equal(t.calls.beginMutation.length, 0);
  assert.equal(t.qa('[data-ov-action="copy"]')[0].disabled, false, 'copiar é leitura e segue disponível');
});

test('fechado sem métodos de gravação no gateway mesmo com capability', async () => {
  const t = setup();
  delete t.gateway.beginMutation;
  await t.syncNow();
  assert.equal(submitBtn(t).disabled, true);
  assert.match(t.text('[data-ov-cap]'), /Gravação não instalada/);
});

test('criar permitido: revisar → confirmar → reler → copiar, com ID e vínculo do servidor', async () => {
  const t = setup();
  await t.syncNow();
  assert.equal(submitBtn(t).disabled, false);
  await t.review();
  assert.equal(t.calls.beginMutation.length, 1);
  const b = t.calls.beginMutation[0];
  assert.equal(b.kind, 'link.create');
  assert.equal(b.expectedContextRevision, 'r1');
  assert.deepEqual(Object.keys(b.payload).sort(), ['campaign', 'date', 'destination', 'origin', 'surface']);
  assert.ok(!('brand' in b.payload) && !('brandId' in b.payload) && !('operationId' in b), 'marca e ID ficam com o servidor');
  assert.equal(opState(t), 'prepared');
  assert.equal(t.calls.submit.length, 0, 'nada gravado antes de confirmar');
  assert.equal(t.doc.activeElement.getAttribute('data-ov-action'), 'op-confirm');
  const readsBefore = t.calls.read.length;
  await t.click('[data-ov-action="op-confirm"]');
  assert.deepEqual(t.calls.submit, [{ operationId: 'op-1', expectedContextRevision: 'r1' }]);
  assert.equal(opState(t), 'confirmed');
  assert.ok(t.calls.read.length > readsBefore, 'releu a lista');
  assert.equal(t.q('[data-ov-refresh]').getAttribute('data-ov-refresh'), 'ok');
  assert.ok(t.q('[data-ov-link-row="new-1"]'), 'link novo vem da releitura do servidor');
  await t.click('[data-ov-action="copy-result"]');
  assert.deepEqual(t.doc.clipboardWrites, ['https://oaristocrata.com/products/novo?utm_source=instagram_social&utm_medium=story&utm_campaign=20261005_kit_novo']);
  await t.click('[data-ov-action="copy"][data-ov-link="l1"]');
  assert.match(t.doc.clipboardWrites[1], /20261001_x/);
  assert.match(t.text('[data-ov-message]'), /Link copiado/);
  assert.equal(submitBtn(t).disabled, false, 'após confirmação e releitura, nova gravação liberada');
});

test('copiar sem área de transferência seleciona o link para cópia manual', async () => {
  const t = setup();
  t.doc.clipboardMode = 'fail';
  await t.syncNow();
  await t.click('[data-ov-action="copy"][data-ov-link="l1"]');
  assert.equal(t.doc.selected.getAttribute('data-ov-url'), 'l1');
  assert.match(t.text('[data-ov-message]'), /Ctrl\+C/);
});

test('recusa do servidor: nada gravado, motivo visível e nova tentativa permitida', async () => {
  const t = setup();
  t.modes.submit = 'reject';
  await t.syncNow();
  await t.review();
  await t.click('[data-ov-action="op-confirm"]');
  assert.equal(opState(t), 'rejected');
  assert.match(t.text('[data-ov-op]'), /Destino recusado pelo servidor/);
  assert.equal(submitBtn(t).disabled, false);
  assert.equal(t.server.links.aristo.length, 1);
});

test('POST confirmado + GET falho: confirmação preservada, só a leitura pode ser repetida', async () => {
  const t = setup();
  await t.syncNow();
  await t.review();
  t.modes.read.links = 'throw';
  await t.click('[data-ov-action="op-confirm"]');
  assert.equal(opState(t), 'confirmed');
  assert.match(t.text('[data-ov-op]'), /Criação confirmada pelo servidor/);
  assert.equal(t.q('[data-ov-refresh]').getAttribute('data-ov-refresh'), 'failed');
  assert.equal(submitBtn(t).disabled, true);
  assert.match(t.text('[data-ov-cap]'), /atualize/);
  assert.ok(t.qa('[data-ov-action="archive"]').every(b => b.disabled));
  assert.equal(t.calls.submit.length, 1);
  t.modes.read.links = undefined;
  await t.click('[data-ov-op] [data-ov-action="refresh"]');
  assert.equal(t.q('[data-ov-refresh]').getAttribute('data-ov-refresh'), 'ok');
  assert.ok(t.q('[data-ov-link-row="new-1"]'));
  assert.equal(t.calls.submit.length, 1, 'atualizar leitura nunca reenvia');
  assert.equal(submitBtn(t).disabled, false);
});

test('ACK ausente: bloqueia nova gravação e consulta a MESMA operação, sem segundo envio', async () => {
  const t = setup();
  t.modes.submit = 'lose-ack';
  await t.syncNow();
  await t.review();
  await t.click('[data-ov-action="op-confirm"]');
  assert.equal(opState(t), 'uncertain');
  assert.match(t.text('[data-ov-op]'), /Resultado desconhecido/);
  assert.equal(submitBtn(t).disabled, true);
  assert.ok(t.qa('[data-ov-action="archive"]').every(b => b.disabled));
  await t.review({ campaign: 'outra' });
  await t.syncNow();
  assert.equal(opState(t), 'uncertain', 'releitura não apaga a incerteza');
  assert.equal(t.calls.beginMutation.length, 1);
  assert.equal(t.calls.submit.length, 1);
  t.modes.receipt = 'throw';
  await t.click('[data-ov-action="receipt"]');
  assert.equal(opState(t), 'uncertain');
  assert.equal(t.calls.submit.length, 1, 'falha na consulta não reenvia');
  t.modes.receipt = 'journal';
  await t.click('[data-ov-action="receipt"]');
  assert.deepEqual(t.calls.receipt.map(r => r.operationId), ['op-1', 'op-1']);
  assert.ok(t.calls.receipt.every(r => r.expectedContextRevision === 'r1'));
  assert.equal(opState(t), 'confirmed');
  assert.equal(t.calls.submit.length, 1);
  assert.equal(t.calls.beginMutation.length, 1);
  assert.equal(t.server.links.aristo.length, 2, 'uma única gravação no servidor sintético');
});

test('estado pending no submit fica incerto até o recibo; recibo de outra operação é descartado', async () => {
  const t = setup();
  t.modes.submit = 'foreign-id';
  await t.syncNow();
  await t.review();
  await t.click('[data-ov-action="op-confirm"]');
  assert.equal(opState(t), 'uncertain', 'resposta com outro operationId não confirma nada');
  assert.match(t.text('[data-ov-op]'), /não corresponde à operação original/);
  await t.click('[data-ov-action="receipt"]');
  assert.equal(opState(t), 'confirmed');
  assert.equal(t.calls.submit.length, 1);
});

test('operação pendente no journal do contexto bloqueia gravação e é recuperada pelo recibo', async () => {
  const t = setup();
  t.server.journal.set('op-77', { state: 'confirmed', binding: { kind: 'link.create', effectiveBrand: 'aristo' }, result: { id: 'z', brandId: 'aristo', url: 'https://oaristocrata.com/?utm_campaign=z' } });
  t.setCtx({ pendingOperations: [{ operationId: 'op-77', kind: 'link.create' }] });
  await t.syncNow();
  assert.equal(submitBtn(t).disabled, true);
  assert.match(t.text('[data-ov-cap]'), /operação pendente no journal/);
  await t.click('[data-ov-pending] [data-ov-action="receipt"]');
  assert.equal(t.calls.receipt[0].operationId, 'op-77');
  assert.equal(opState(t), 'confirmed');
  assert.equal(t.calls.submit.length, 0);
  assert.equal(t.calls.beginMutation.length, 0);
});

test('contexto sem journal informado mantém gravação fechada', async () => {
  const t = setup({ ctx: { pendingOperations: undefined } });
  await t.syncNow();
  assert.equal(submitBtn(t).disabled, true);
  assert.match(t.text('[data-ov-cap]'), /journal/);
});

test('arquivar: confirma com revisão do registro e mantém histórico, sem desarquivar', async () => {
  const t = setup();
  await t.syncNow();
  await t.click('[data-ov-action="archive"][data-ov-link="l1"]');
  const b = t.calls.beginMutation[0];
  assert.equal(b.kind, 'link.archive');
  assert.equal(b.recordId, 'l1');
  assert.equal(b.expectedRecordRevision, 3);
  assert.equal(opState(t), 'prepared');
  await t.click('[data-ov-action="op-confirm"]');
  assert.equal(opState(t), 'confirmed');
  assert.equal(t.q('[data-ov-link-row="l1"]'), null);
  assert.ok(t.q('[data-ov-archived-row="l1"]'), 'continua no histórico arquivado');
  assert.doesNotMatch(t.text('[data-ov-section="links"]'), /Desarquivar|Reativar/);
  assert.equal(t.q('[data-ov-archived-row="l1"] [data-ov-action]'), null);
});

test('retrato antigo da lista de links é somente leitura: sem gravar nem copiar', async () => {
  const t = setup();
  t.server.linksEnvelope = { freshness: 'stale' };
  await t.syncNow();
  assert.equal(submitBtn(t).disabled, true);
  assert.match(t.text('[data-ov-cap]'), /Retrato antigo/);
  assert.ok(t.qa('[data-ov-action="copy"]').every(b => b.disabled));
});

test('falha na preparação: nada executado, gravação travada até reler', async () => {
  const t = setup();
  t.modes.begin = 'throw';
  await t.syncNow();
  await t.review();
  assert.equal(t.calls.submit.length, 0);
  assert.equal(opState(t), '');
  assert.match(t.text('[data-ov-message]'), /Preparação não confirmada/);
  assert.equal(submitBtn(t).disabled, true);
  t.modes.begin = 'prepared';
  await t.syncNow();
  assert.equal(submitBtn(t).disabled, false);
});

test('troca de marca com envio em andamento: resposta atrasada não aparece na nova marca', async () => {
  const t = setup();
  await t.syncNow();
  await t.review();
  t.hold('submit');
  t.q('[data-ov-action="op-confirm"]').click(); await t.flush();
  assert.equal(opState(t), 'submitting');
  t.setCtx({ effectiveBrand: 'fish', contextRevision: 'r2' });
  await t.syncNow();
  t.release('submit'); await t.flush();
  assert.equal(opState(t), '', 'operação da marca anterior não repovoa a nova marca');
  assert.doesNotMatch(t.text('[data-ov-section="links"]'), /oaristocrata/);
  assert.equal(t.calls.submit.length, 1);
});

test('cancelar revisão não grava nada e devolve o foco ao formulário', async () => {
  const t = setup();
  await t.syncNow();
  await t.review();
  await t.click('[data-ov-action="op-cancel"]');
  assert.equal(opState(t), '');
  assert.equal(t.calls.submit.length, 0);
  assert.equal(t.doc.activeElement.getAttribute('data-ov-focus'), 'link-review');
});
