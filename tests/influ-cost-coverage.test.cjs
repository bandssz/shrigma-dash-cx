const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync(require('node:path').join(__dirname,'../influs.html'),'utf8');
const a=html.indexOf('  coberturaCusto('),b=html.indexOf('  // agrupa por porte',a),ctx=vm.createContext({Intl,Date});
vm.runInContext('const G={'+html.slice(a,b)+'};globalThis.cover=G.coberturaCusto;',ctx);
vm.runInContext(html.slice(html.indexOf('function compAtual('),html.indexOf('function renderAvisoCusto('))+'globalThis.month=compAtual;',ctx);
const creator=(influ,modelo,marca='fish',more={})=>({influ,modelo,marca,ativo:true,...more});
test('partial month exposes missing fixed/permuta/model without requiring monthly fees from commission-only creators',()=>{
 const p={influs:[creator('known','fixo'),creator('missing','hibrido'),creator('gift','permuta'),creator('unknown',null),creator('percent','comissao'),creator('inactive','fixo','fish',{ativo:false}),creator('future','fixo','fish',{desde:'2026-10-01'})],custos:[{marca:'fish',influ:'known',competencia:'2026-09',fixo:0}]};
 assert.deepEqual(Array.from(ctx.cover(p,'fish','2026-09'),x=>x.influ),['missing','gift','unknown']);
 assert.equal(ctx.cover(p,'aristo','2026-09').length,0);
 assert.equal(ctx.cover(p,'fish','2026-08').length,4);
});
test('creator identity is brand-scoped; absent source is unknown, not complete coverage',()=>{
 const p={influs:[creator('same','fixo'),creator('same','fixo','aristo')],custos:[{marca:'aristo',influ:'same',competencia:'2026-09'}]};
 assert.deepEqual(Array.from(ctx.cover(p,'todas','2026-09'),x=>x.marca),['fish']);
 assert.equal(ctx.cover({influs:[]},'fish','2026-09'),null);
});
test('current competence follows Brasilia at UTC month rollover',()=>{
 assert.equal(ctx.month(new Date('2026-10-01T01:00:00Z')),'2026-09');
 assert.equal(ctx.month(new Date('2026-10-01T03:00:00Z')),'2026-10');
});
