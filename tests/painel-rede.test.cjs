const test=require('node:test'),assert=require('node:assert/strict');
const R=require('../painel-rede.js');
const sem=()=>Promise.resolve();

test('uma leitura que falha por rede é repetida e a segunda resposta vale',async()=>{
 let n=0;const v=await R.ler(async()=>{n++;if(n===1)throw new TypeError('Failed to fetch');return 'ok';},{dormir:sem});
 assert.equal(v,'ok');assert.equal(n,2);
});
test('5xx marcado como passageiro é repetido até três tentativas, depois desiste',async()=>{
 let n=0;await assert.rejects(R.ler(async()=>{n++;throw R.marca(Error('x'),502);},{dormir:sem}));
 assert.equal(n,3);
});
test('erro de regra (chave, validação, 4xx) não é repetido',async()=>{
 let n=0;await assert.rejects(R.ler(async()=>{n++;throw R.marca(Error('Chave inválida'),401);},{dormir:sem}),/Chave inválida/);
 assert.equal(n,1);
});
test('consulta cancelada ou vencida não é repetida',async()=>{
 let n=0;const abort=Object.assign(Error('aborted'),{name:'AbortError'});
 await assert.rejects(R.ler(async()=>{n++;throw abort;},{dormir:sem}));assert.equal(n,1);
 n=0;await assert.rejects(R.ler(async()=>{n++;throw new TypeError('Failed to fetch');},{dormir:sem,parar:()=>true}));assert.equal(n,1);
});
test('a mensagem troca o texto técnico do navegador e mantém a do servidor',()=>{
 assert.equal(R.mensagem(new TypeError('Failed to fetch')),'O servidor demorou para responder. Tente de novo em instantes.');
 assert.equal(R.mensagem(Error('Informe o mês.')),'Informe o mês.');
});
test('os módulos de leitura usam a nova tentativa e as gravações não',()=>{
 const fs=require('node:fs'),path=require('node:path');
 for(const f of ['influ-escopo.js','partner-candidaturas.js','tts-cobranca.js','organico-links.js']){
  const s=fs.readFileSync(path.join(__dirname,'..',f),'utf8');
  assert.match(s,/REDE\(\)\.ler\(/,f+' lê com nova tentativa');
  assert.doesNotMatch(s,/REDE\(\)\.ler\(\(\)=>call(Apr)?\(\{?acao:'(aprovar|envio|encerrar|salvar|arquivar)'/,f+' não repete gravação');
 }
 const m=JSON.parse(fs.readFileSync(path.join(__dirname,'..','tools/panel-build/manifest.json'),'utf8'));
 for(const p of ['influs','organico'])assert.ok(m[p].scripts.indexOf('painel-rede.js')>0,p+' carrega o painel-rede.js');
});
