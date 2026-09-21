const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const arquivo=fs.readFileSync(path.join(__dirname,'..','n8n','ra-bookmarklet.js'),'utf8');
// O cabeçalho é documentação e pode citar o formato antigo; só o código executável importa.
const src=arquivo.slice(arquivo.indexOf('javascript:(async function'));
assert.ok(src.length>800,'o trecho executável foi encontrado');
test('the RA key never travels in the URL',()=>{
 assert.doesNotMatch(src,/cx-ra-metatags\?/,'a URL do webhook não carrega query string');
 assert.doesNotMatch(src,/\?k=/,'nenhum ?k= sobrou');
 assert.match(src,/body:JSON\.stringify\(\{k:K,/,'a chave vai no corpo do POST');
});
test('the placeholder is still a placeholder — no real key in the public repo',()=>{
 assert.match(src,/var K='CHAVE';/);
 const linhas=src.split('\n').filter(l=>/K\s*=/.test(l));
 assert.equal(linhas.length,1,'só uma atribuição de chave, e é o placeholder');
 assert.doesNotMatch(src,/\bra-[0-9a-f]{16,}\b/,'nenhuma chave do coletor no arquivo');
 assert.doesNotMatch(src,/shrigma-[a-z]+-[0-9a-f]{8,}/,'nenhuma chave de painel no arquivo');
});
test('the bookmarklet still sends the brand and the metrics the collector writes',()=>{
 assert.match(src,/marca:marca,ra:ra/);
 for(const campo of ['nota','resposta_pct','solucao_pct','voltaria_pct','reclamacoes','avaliacoes','status_ra'])
  assert.match(src,new RegExp(campo+':'),'campo '+campo+' continua sendo lido');
 for(const fila of ['pendentes_agora','respondidas_agora','avaliadas_agora','ativas_agora'])
  assert.match(src,new RegExp(fila),'fila '+fila+' continua sendo lida');
});
test('it still refuses to run outside a known brand page',()=>{
 assert.match(src,/if\(!marca\)\{alert\(/,'sem marca reconhecida, não envia nada');
 assert.match(src,/o-aristocrata|aristocrata/);assert.match(src,/fishermans/);
});
