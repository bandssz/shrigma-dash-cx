'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {project} = require((process.env.DASHBOARD_ACCESS_TEST_RUNTIME||require('node:path').resolve(__dirname,'../services/dashboard-operational'))+'/afiliados-read-contract.cjs');
const scope = {brand: 'fish', ini: '2026-10-01', fim: '2026-10-12'};
const source = () => ({
  janela: {ini: scope.ini, fim: scope.fim}, gerado_em: '2026-10-12T03:15:07Z',
  kpis: [{marca: 'fish', gmv: '12.34', pedidos: 1, comissao: null}, {marca: 'aristo', gmv: 99}],
  fila: [{marca: 'fish', application_id: 'synthetic-fish', username: 'synthetic', approve_expira_em: null, internal_note: 'private'}, {marca: 'aristo', application_id: 'synthetic-aristo'}],
  envio: [], target: [{marca: 'fish', colab_id: 'synthetic', produtos: ['Synthetic product'], has_free_sample: false}],
  frescor: [{marca: 'fish', ultima_ok: '2026-09-01T03:30:00Z', ultima_ok_todas: false, erros: 'SOURCE_UNAVAILABLE'}]
});
test('one brand reaches the browser and foreign rows/unknown fields do not', () => {
  const out = project(source(), scope);
  assert.deepEqual(out.brands, ['fish']); assert.equal(out.kpis.length, 1); assert.equal(out.fila.length, 1);
  assert.equal(out.fila[0].application_id, 'synthetic-fish'); assert.equal(Object.hasOwn(out.fila[0], 'internal_note'), false);
  assert.equal(JSON.stringify(out).includes('synthetic-aristo'), false);
});
test('projection preserves actual decimal, null, false and unknown metric absence', () => {
  const out = project(source(), scope); assert.equal(out.kpis[0].gmv, '12.34'); assert.equal(out.kpis[0].comissao, null);
  assert.equal(Object.hasOwn(out.kpis[0], 'criadores'), false); assert.equal(out.target[0].has_free_sample, false);
});
test('missing blocks differ from confirmed empty arrays', () => {
  const out = project(source(), scope); assert.equal(Object.hasOwn(out, 'criadores'), false); assert.deepEqual(out.envio, []);
});
test('old collection and original errors remain visible, never refreshed by projection', () => {
  const out = project(source(), scope); assert.equal(out.frescor[0].ultima_ok, '2026-09-01T03:30:00Z');
  assert.equal(out.frescor[0].ultima_ok_todas, false); assert.match(out.frescor[0].erros, /Falha de coleta registrada/);
});
for (const brand of ['todas', 'olivas', undefined]) test('reject unadmitted requested brand ' + brand, () => assert.throws(() => project(source(), {...scope, brand}), {code: 'AFFILIATE_BRAND_REQUIRED'}));
for (const change of [row => delete row.marca, row => row.marca = 'unknown', row => row.brand = 'aristo']) test('never guess row ownership ' + change.toString(), () => {
  const value = source(); change(value.fila[0]); assert.throws(() => project(value, scope), {code: 'AFFILIATE_SOURCE_BRAND_UNCONFIRMED'});
});
test('even a foreign unscoped row rejects the source envelope', () => {
  const value = source(); value.kpis[1].marca = 'unknown'; assert.throws(() => project(value, scope), {code: 'AFFILIATE_SOURCE_BRAND_UNCONFIRMED'});
});
test('source period mismatch rejects; it is not relabelled', () => {
  const value = source(); value.janela.fim = '2026-10-11'; assert.throws(() => project(value, scope), {code: 'AFFILIATE_SOURCE_WINDOW_UNCONFIRMED'});
});
test('invalid calendar date and reversed period reject', () => {
  assert.throws(() => project(source(), {...scope, ini: '2026-02-30'})); assert.throws(() => project(source(), {...scope, ini: '2026-10-13'}));
});
test('credential in unknown source field is refused before projection', () => {
  const value = source(); value.extra = {secret: 'synthetic-credential'};
  assert.throws(() => project(value, {...scope, credential: 'synthetic-credential'}), {code: 'AFFILIATE_RESPONSE_CREDENTIAL_LEAK'});
});
test('escaped credential in a permitted text field cannot survive projection', () => {
  const value = source(), credential = 'synthetic-"\\-credential'; value.fila[0].username = 'prefix-' + credential + '-suffix';
  assert.throws(() => project(value, {...scope, credential}), {code: 'AFFILIATE_RESPONSE_CREDENTIAL_LEAK'});
});
test('provider error request details do not reach an analyst response', () => {
  const value = source(); value.frescor[0].erros = 'request included synthetic-provider-secret';
  value.autorizacao = [{marca: 'fish', ultimo_erro_canal: 'synthetic-provider-secret'}];
  const out = project(value, scope); assert.equal(out.frescor[0].ultima_ok_todas, false);
  assert.equal(JSON.stringify(out).includes('synthetic-provider-secret'), false); assert.match(out.autorizacao[0].ultimo_erro_canal, /Falha de coleta registrada/);
});
test('source decision and rule mode survive without inventing defaults', () => {
  const value = source(); Object.assign(value.fila[0], {tier_sugerido: 'comprovado', decisao: 'APPROVE', dry_run: false, decisao_motivo: 'Synthetic decision'});
  value.regra = [{marca: 'fish', modo: 'ativo', atualizado_em: '2026-10-12T03:15:07Z'}, {marca: 'aristo', modo: 'dry_run'}];
  const out = project(value, scope); assert.equal(out.fila[0].tier_sugerido, 'comprovado'); assert.equal(out.fila[0].dry_run, false);
  assert.equal(out.fila[0].decisao, 'APPROVE'); assert.equal(out.fila[0].decisao_motivo, 'Synthetic decision'); assert.equal(out.regra.length, 1); assert.equal(out.regra[0].modo, 'ativo');
  const missing = project(source(), scope); assert.equal(Object.hasOwn(missing, 'regra'), false); assert.equal(Object.hasOwn(missing.fila[0], 'decisao'), false);
});
test('invalid array, invalid metric and invalid timestamp do not become zero', () => {
  for (const change of [p => p.fila = {}, p => p.kpis[0].gmv = false, p => p.kpis[0].pedidos = NaN, p => p.frescor[0].ultima_ok = 'yesterday']) {
    const value = source(); change(value); assert.throws(() => project(value, scope));
  }
});
test('prototype objects are not data envelopes', () => assert.throws(() => project(Object.create(source()), scope)));
test('projection does not mutate input or share mutable arrays', () => {
  const value = source(), before = structuredClone(value), out = project(value, scope);
  out.target[0].produtos.push('extra'); assert.deepEqual(value, before);
});
