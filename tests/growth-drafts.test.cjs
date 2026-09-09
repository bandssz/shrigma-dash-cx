const test=require('node:test'),assert=require('node:assert/strict');
const GR=require('../growth-drafts.js');

test('variáveis são extraídas em ordem e sem repetição; exemplos preenchem a prévia sem inventar',()=>{
 assert.deepEqual(GR.variaveis('Oi {{2}}, pedido {{1}} e {{ 2 }}'),[1,2]);
 assert.equal(GR.preenche('Oi {{1}}, código {{2}}',{1:'Ana'}),'Oi Ana, código {{2}}');
 assert.equal(GR.preenche(null,{}),'');
});
test('validação local: limites da Meta, sequência de variáveis, botões e categoria',()=>{
 const ok=GR.novo({nome:'fish_rastreio_v3',corpo:'Olá {{1}}, seu pedido {{2}} saiu.',exemplos:{1:'Ana',2:'#123'},botoes:[{tipo:'url',texto:'Acompanhar',valor:'https://conta.fishermans.com.br'}]});
 assert.deepEqual(GR.valida(ok),{erros:[],avisos:[]});
 const ruim=GR.novo({nome:'Nome Com Espaço',corpo:'{{1}} e {{3}} '+'x'.repeat(1030),botoes:[{tipo:'url',texto:'Ir',valor:'http://x'},{tipo:'phone',texto:'',valor:'abc'}]});
 const v=GR.valida(ruim);
 assert(v.erros.some(e=>/limite da Meta é 1024/.test(e)));
 assert(v.erros.some(e=>/sequência a partir de \{\{1\}\}/.test(e)));
 assert(v.erros.some(e=>/https:\/\//.test(e)));assert(v.erros.some(e=>/Botão 2 sem texto/.test(e)));assert(v.erros.some(e=>/formato internacional/.test(e)));
 assert(v.avisos.some(a=>/minúsculas/.test(a)));assert(v.avisos.some(a=>/começa ou termina com variável/.test(a)));
 const wame=GR.novo({nome:'a_b',corpo:'Oi.',botoes:[{tipo:'url',texto:'Suporte',valor:'https://wa.me/55'}]});
 assert(GR.valida(wame).avisos.some(a=>/wa\.me/.test(a)));
 const util=GR.novo({nome:'a_b',categoria:'UTILITY',corpo:'Use o cupom 25OFF.'});
 assert(GR.valida(util).avisos.some(a=>/reclassificar Utility/.test(a)));
 const mail=GR.novo({canal:'email',nome:'carta 2',corpo:'x',botoes:[{tipo:'url',texto:'Ver',valor:'https://loja.com/p'}]});
 const vm=GR.valida(mail);assert(vm.erros.some(e=>/assunto/.test(e)));assert(vm.avisos.some(a=>/UTM/.test(a)));
 assert.deepEqual(GR.valida(null).erros,['Rascunho inválido.']);
});
test('exportação não leva id local nem chave, e importação só aceita campos conhecidos',()=>{
 const r=GR.novo({nome:'x_y',corpo:'Oi {{1}}',exemplos:{1:'Ana'},botoes:[{tipo:'quick_reply',texto:'Sim',valor:'',extra:'nao'}]});
 const txt=GR.exporta(r);const j=JSON.parse(txt);
 assert.equal(j.tipo,'shrigma-growth-rascunho');assert.equal(j.rascunho.id,undefined);assert.match(j.origem,/não é template publicado/);
 assert.doesNotMatch(txt,/shrigma_k|GROWTH|synthetic/);
 const volta=GR.importa(txt);
 assert.equal(volta.rascunho.nome,'x_y');assert.notEqual(volta.rascunho.id,r.id);assert.deepEqual(volta.rascunho.botoes,[{tipo:'quick_reply',texto:'Sim',valor:''}]);
 assert.equal(GR.importa('{"tipo":"outra","x":1}').erro,'Arquivo não contém um rascunho reconhecido.');
 assert.equal(GR.importa('nao json').erro,'Arquivo não é JSON válido.');
 const legado=GR.importa(JSON.stringify({corpo:'texto',nome:'n',chave_api:'segredo',botoes:'x'}));
 assert.equal(legado.rascunho.chave_api,undefined);assert.deepEqual(legado.rascunho.botoes,[]);
 assert.match(GR.nomeArquivo(GR.novo({nome:'Fish Rastreio v3',marca:'fish'})),/^rascunho-whatsapp-fish-fish-rastreio-v3\.json$/);
});
test('armazenamento local: guarda, atualiza no lugar, remove e ignora lixo',()=>{
 const mem=new Map();global.localStorage={getItem:k=>mem.get(k)??null,setItem:(k,v)=>mem.set(k,v),removeItem:k=>mem.delete(k)};
 try{
  assert.deepEqual(GR.lista(),[]);
  const a=GR.guarda(GR.novo({nome:'a',corpo:'1'})),b=GR.guarda(GR.novo({nome:'b',corpo:'2'}));
  assert.deepEqual(GR.lista().map(r=>r.nome),['b','a']);
  GR.guarda({...a,corpo:'1b'});assert.equal(GR.lista().length,2);assert.equal(GR.lista().find(r=>r.id===a.id).corpo,'1b');
  GR.remove(b.id);assert.deepEqual(GR.lista().map(r=>r.nome),['a']);
  mem.set(GR.CHAVE,'{"nao":"array"}');assert.deepEqual(GR.lista(),[]);
  mem.set(GR.CHAVE,'[1,null,{"id":"z","nome":"z"}]');assert.deepEqual(GR.lista().map(r=>r.id),['z']);
 }finally{delete global.localStorage;}
});
