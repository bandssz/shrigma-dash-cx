'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const path = require('node:path');
const file = path.resolve(__dirname, '../influs-tts.js');
const TTS = require(file), source = fs.readFileSync(file, 'utf8');
const start = source.indexOf('  function renderCriadores() {'), end = source.indexOf('\n  function renderColabs()', start);
assert(start > 0 && end > start);
function render(data, front = 'afiliados') {
  const area = {innerHTML: ''};
  const ctx = {TTS, DADOS: data, PRODUCT_FRONT: {id: front}, marcaAtual: () => 'fish', $: () => area,
    nf: x => x == null ? '—' : String(x), rf: x => x == null ? '—' : 'R$ ' + x,
    pf: x => x == null ? '—' : Math.round(x) + '%', esc: x => String(x ?? ''), tag: x => x,
    dobra: rows => rows.join(''), ligarDobras() {}};
  vm.runInNewContext(source.slice(start, end) + '\nrenderCriadores();', ctx);
  return area.innerHTML;
}
const creator = (gmv, username = 'synthetic') => ({marca: 'fish', username, gmv, pedidos: 1, comissao: 2});
test('capped ranking share uses original brand/window GMV, not ranking total', () => {
  const html = render({kpis: [{marca: 'fish', gmv: 400}], criadores: [creator(100)]});
  assert.match(html, />25%</); assert.doesNotMatch(html, />100%</);
});
test('missing KPI denominator does not fall back to a partial ranking sum', () => {
  const html = render({criadores: [creator(100)]}); assert.doesNotMatch(html, />100%</); assert.match(html, />—<\/td>/);
});
test('another brand cannot supply the denominator', () => {
  const html = render({kpis: [{marca: 'aristo', gmv: 400}], criadores: [creator(100)]}); assert.doesNotMatch(html, />25%</); assert.doesNotMatch(html, />100%</);
});
test('incomplete GMV refuses percentage instead of presenting an invented complete ranking', () => {
  const html = render({kpis: [{marca: 'fish', gmv: 400}], criadores: [creator(100), creator(null, 'synthetic-second')]});
  assert.doesNotMatch(html, />25%</); assert.doesNotMatch(html, />100%</); assert.doesNotMatch(html, /NaN/);
});
test('legacy percentage remains ranking based and unchanged', () => {
  const html = render({kpis: [{marca: 'fish', gmv: 400}], criadores: [creator(100)]}, 'legacy'); assert.match(html, />100%</);
});
