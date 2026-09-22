/* Pedidos e ticket médio por creator. A regra que importa: as duas métricas vivem na lente do
   CUPOM. A receita da linha assinada entra no ROI por outro caminho e não pode dividir esta conta —
   se entrasse, o ticket contaria venda que não tem pedido contado aqui. */
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '../influs.html'), 'utf8');
const ctx = vm.createContext({ Intl, Date });
const a = html.indexOf('  influKPI(roi, marca)'), b = html.indexOf('  // Coverage is per active creator', a);
vm.runInContext('const G={' + html.slice(a, b) + '};globalThis.kpi=G.influKPI;', ctx);
const linha = (o = {}) => ({ marca: 'fish', influ: 'x', receita: null, pedidos: 0, custo_lancado: 0, comissao: 0, patrocinio: 0, ...o });

test('pedidos somam por marca e o ticket é receita ÷ pedidos', () => {
  const k = ctx.kpi([
    linha({ influ: 'a', receita: 1000, pedidos: 10 }),
    linha({ influ: 'b', receita: 500, pedidos: 5 }),
  ], 'fish');
  assert.equal(k.pedidos, 15);
  assert.equal(k.receita, 1500);
  assert.equal(k.ticketMedio, 100);
});

test('sem pedido o ticket é null, nunca zero', () => {
  const k = ctx.kpi([linha({ custo_lancado: 800 })], 'fish');
  assert.equal(k.pedidos, 0);
  assert.equal(k.ticketMedio, null, 'dividir por zero não pode virar 0,00 na tela');
});

test('creator com custo e sem receita não entra no ticket, mas continua no investimento', () => {
  const k = ctx.kpi([
    linha({ influ: 'vendeu', receita: 900, pedidos: 6 }),
    linha({ influ: 'nao-vendeu', receita: null, pedidos: 0, custo_lancado: 2000 }),
  ], 'fish');
  assert.equal(k.pedidos, 6);
  assert.equal(k.ticketMedio, 150, 'o cachê de quem não vendeu não pode mexer no ticket');
  assert.equal(k.custo, 2000, 'mas continua contado como investimento');
  assert.equal(k.semReceita, 1);
});

test('o filtro de marca recorta pedidos e ticket junto com o resto', () => {
  const dados = [
    linha({ marca: 'fish', influ: 'f', receita: 400, pedidos: 4 }),
    linha({ marca: 'aristo', influ: 'a', receita: 3000, pedidos: 10 }),
  ];
  assert.equal(ctx.kpi(dados, 'fish').ticketMedio, 100);
  assert.equal(ctx.kpi(dados, 'aristo').ticketMedio, 300);
  const todas = ctx.kpi(dados, 'todas');
  assert.equal(todas.pedidos, 14);
  assert.equal(todas.ticketMedio, 3400 / 14);
});

test('pedido registrado sem receita conhecida não inventa ticket', () => {
  // receita null significa desconhecido; a linha fica fora de comRec e dos dois números
  const k = ctx.kpi([linha({ influ: 'incerto', receita: null, pedidos: 3 })], 'fish');
  assert.equal(k.pedidos, 0, 'pedido de linha sem receita conhecida não entra na conta do ticket');
  assert.equal(k.ticketMedio, null);
});
