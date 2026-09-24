/* Nicho do creator e lente de link no painel de Influs. O nicho entra pelo cadastro, porque
   crm_influ_roi não o conhece; a lente de link é separada da de cupom e só a parte "sem cupom"
   pode ser somada a ela sem contar a mesma venda duas vezes. */
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '../influs.html'), 'utf8');
const ctx = vm.createContext({});
const a = html.indexOf('  influPor(roi, marca, campo){'), b = html.indexOf('  influResumo(cupons, marca){', a);
assert.ok(a > 0 && b > a, 'trecho do G não encontrado');
vm.runInContext('const G={' + html.slice(a, b) + '};globalThis.G=G;', ctx);
const G = ctx.G;
const influs = [
  { marca: 'aristo', influ: 'a', nicho: 'pesca esportiva' },
  { marca: 'aristo', influ: 'b', nicho: 'lifestyle' },
  { marca: 'aristo', influ: 'c', nicho: null },
  { marca: 'fish', influ: 'd', nicho: 'pesca esportiva' },
];

test('lista de nichos por marca, sem vazio e sem repetição', () => {
  assert.deepEqual([...G.nichos(influs, 'aristo')], ['lifestyle', 'pesca esportiva']);
  assert.deepEqual([...G.nichos(influs, 'todas')], ['lifestyle', 'pesca esportiva']);
  assert.deepEqual([...G.nichos(influs, 'olivas')], []);
});

test('ROI ganha o nicho do cadastro sem mudar o resto da linha', () => {
  const roi = [{ marca: 'aristo', influ: 'a', receita: 100, investimento: 50 }, { marca: 'aristo', influ: 'z', receita: 10 }];
  const r = G.comNicho(roi, influs);
  assert.equal(r[0].nicho, 'pesca esportiva'); assert.equal(r[0].receita, 100);
  assert.equal(r[1].nicho, null, 'creator fora do cadastro fica sem nicho, não some');
  assert.equal(roi[0].nicho, undefined, 'não altera o array original');
});

test('filtro: vazio passa tudo, __sem__ só quem não tem, valor exato para o resto', () => {
  assert.equal(G.passaNicho('lifestyle', ''), true);
  assert.equal(G.passaNicho(null, ''), true);
  assert.equal(G.passaNicho(null, '__sem__'), true);
  assert.equal(G.passaNicho('lifestyle', '__sem__'), false);
  assert.equal(G.passaNicho('lifestyle', 'lifestyle'), true);
  assert.equal(G.passaNicho('pesca esportiva', 'lifestyle'), false);
});

test('corte por nicho soma receita e investimento e mantém quem não informou', () => {
  const roi = G.comNicho([
    { marca: 'aristo', influ: 'a', receita: 300, investimento: 100 },
    { marca: 'aristo', influ: 'b', receita: 100, investimento: 100 },
    { marca: 'aristo', influ: 'c', receita: null, investimento: 80 },
  ], influs);
  const g = G.influPor(roi, 'aristo', 'nicho');
  const por = Object.fromEntries(g.map(x => [x.chave, x]));
  assert.equal(por['pesca esportiva'].roi, 3);
  assert.equal(por['lifestyle'].roi, 1);
  assert.equal(por['(não informado)'].investimento, 80, 'custo de quem não tem nicho continua aparecendo');
  assert.equal(g[0].chave, 'pesca esportiva', 'ordenado pelo ROI');
});

test('vendas pelo link: zero explícito quando não há linha, números quando há', () => {
  assert.deepEqual({ ...G.vendasLink([], 'aristo', 'a') }, { pedidos: 0, receita: 0, semCupom: 0, receitaSemCupom: 0 });
  const r = G.vendasLink([{ marca: 'aristo', influ: 'a', pedidos: 3, receita: '170.00', pedidos_sem_cupom: 2, receita_sem_cupom: '70.00' }], 'aristo', 'a');
  assert.equal(r.pedidos, 3); assert.equal(r.receita, 170); assert.equal(r.semCupom, 2); assert.equal(r.receitaSemCupom, 70);
  assert.equal(G.vendasLink([{ marca: 'fish', influ: 'a', pedidos: 9 }], 'aristo', 'a').pedidos, 0, 'mesma slug em outra marca não conta');
});

test('os três caminhos de cadastro enviam nicho', () => {
  const envios = [];
  for (let i = html.indexOf("acao:'salvar_influ'"); i >= 0; i = html.indexOf("acao:'salvar_influ'", i + 1))
    envios.push(html.slice(i, html.indexOf('}});', i)));
  assert.equal(envios.length, 3);
  for (const e of envios) assert.match(e, /nicho:/);
});

test('o editor mostra o link gerado e oferece copiar', () => {
  assert.match(html, /id="ed-link" readonly/);
  assert.match(html, /\$\('#ed-link'\)\.value=i\.link\|\|''/);
  assert.match(html, /class="btn sec cr-link"/);
});
