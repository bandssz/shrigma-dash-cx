const test=require('node:test'),assert=require('node:assert/strict');
const GT=require('../growth-table.js');

test('ordenação deixa ausente por último nas duas direções e é estável',()=>{
 const rows=[{n:'b',v:3},{n:'a',v:null},{n:'c',v:10},{n:'d',v:''},{n:'e',v:'2'}];
 assert.deepEqual(GT.ordena(rows,'v','desc').map(r=>r.n),['c','b','e','a','d']);
 assert.deepEqual(GT.ordena(rows,'v','asc').map(r=>r.n),['e','b','c','a','d']);
 assert.deepEqual(GT.ordena(rows,'n','asc').map(r=>r.n),['a','b','c','d','e']);
 assert.deepEqual(GT.ordena(rows,null).map(r=>r.n),['b','a','c','d','e']);
 assert.deepEqual(GT.ordena([{p:'Peça 10'},{p:'peça 2'},{p:'Ação'}],'p','asc').map(r=>r.p),['Ação','peça 2','Peça 10']);
});
test('próxima ordem inverte a coluna ativa e começa pela direção natural da coluna nova',()=>{
 assert.deepEqual(GT.proximaOrdem({sort:'receita',dir:'desc'},'receita',true),{sort:'receita',dir:'asc'});
 assert.deepEqual(GT.proximaOrdem({sort:'receita',dir:'desc'},'enviados',true),{sort:'enviados',dir:'desc'});
 assert.deepEqual(GT.proximaOrdem({sort:'receita',dir:'desc'},'piece',false),{sort:'piece',dir:'asc'});
});
test('busca ignora acento e caixa e exige todos os termos',()=>{
 const rows=[{nome:'Lançamento Frescor',utm:'frescor-vip'},{nome:'Carta do fundador',utm:'carta-01'},{nome:null,utm:'x'}];
 assert.equal(GT.busca(rows,'LANCAMENTO',['nome','utm']).length,1);
 assert.equal(GT.busca(rows,'carta fundador',['nome','utm']).length,1);
 assert.equal(GT.busca(rows,'carta frescor',['nome','utm']).length,0);
 assert.equal(GT.busca(rows,'  ',['nome']).length,3);
 assert.equal(GT.busca(rows,'x',[r=>r.utm]).length,1);
});
test('CSV: ausente é célula vazia, número usa vírgula, texto perigoso é escapado',()=>{
 const cols=[{chave:'peca',rotulo:'Peça'},{chave:'enviados'},{chave:'taxa'},{chave:'ok'}];
 const rows=[{peca:'carrinho; "30min"',enviados:42,taxa:95.238,ok:true},{peca:'=SOMA(A1)',enviados:null,taxa:undefined,ok:false},{peca:'-2 linhas\nquebra',enviados:0,taxa:'',ok:null}];
 const csv=GT.csv(cols,rows,{recorte_marca:'Fishermans',periodo_inicio:'2026-09-01'});
 const linhas=csv.split('\r\n');
 assert.equal(linhas[0],'\uFEFFPeça;enviados;taxa;ok;recorte_marca;periodo_inicio');
 assert.equal(linhas[1],'"carrinho; ""30min""";42;95,238;sim;Fishermans;2026-09-01');
 assert.equal(linhas[2],"'=SOMA(A1);;;não;Fishermans;2026-09-01");
 assert.equal(linhas[3],"'-2 linhas quebra;0;;;Fishermans;2026-09-01");
 assert.equal(linhas[4],'');
 assert.doesNotMatch(csv,/synthetic|shrigma_k/);
});
test('CSV aceita coluna calculada e não confunde zero com ausente',()=>{
 const csv=GT.csv([{chave:'x',pega:r=>r.a===null?null:r.a*2}],[{a:0},{a:null},{a:'3'}]);
 assert.deepEqual(csv.trim().split('\r\n').slice(1),['0','','6']);
});
test('nome do arquivo carrega recorte e período sem caracteres inválidos',()=>{
 assert.equal(GT.nomeArquivo('campanhas',{recorte_marca:'O Aristocrata',recorte_canal:'E-mail',periodo_inicio:'2026-09-01',periodo_fim:'2026-09-07'}),'growth-campanhas-o-aristocrata-e-mail-2026-09-01_2026-09-07.csv');
 assert.equal(GT.nomeArquivo('templates',{recorte_marca:'Consolidada'}),'growth-templates-consolidada.csv');
});
test('hash da URL só aceita chaves conhecidas e faz ida e volta',()=>{
 const estado={marca:'fish',canal:'whatsapp',p:'7',sec:'regua',aba:'workflows',flow:'carrinho 30min'};
 const hash=GT.escreveHash(estado);
 assert.deepEqual(GT.leHash(hash),estado);
 assert.deepEqual(GT.leHash('#k=chave-secreta&marca=aristo&x=1&ini='),{marca:'aristo'});
 assert.deepEqual(GT.leHash(''),{});
 assert.equal(GT.escreveHash({marca:null,canal:'todos'}),'#canal=todos');
});
