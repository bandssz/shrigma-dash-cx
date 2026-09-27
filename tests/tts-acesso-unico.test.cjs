'use strict';
// Acesso único no TikTok: chave de painel com escrita decide e edita regra; portões abertos; principal da chave usada.
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),crypto=require('node:crypto');
const P=require('../n8n/tiktok/acesso-unico-patch.cjs');
const sha=t=>crypto.createHash('sha256').update(t,'utf8').digest('hex');
const SHA_BYTES="function sha256Bytes(msg){return Uint8Array.from(require('crypto').createHash('sha256').update(Buffer.from(msg)).digest());}";
const ESC="const ESCRITA = 'chave-antiga-sintetica';\n";
const fake=()=>({id:'LCODPC1y6kRPQ6hI',versionId:'v1',activeVersionId:'v1',nodes:[
 {name:'Valida',parameters:{jsCode:ESC+"const incoming=$json.body||{};\nif(incoming.acao==='regra'){const b=incoming;if (String(b.k || '') !== ESCRITA) throw new Error('chave invalida');return [{json:{_route:'regra'}}];}\nif(typeof incoming.k!=='string'||incoming.k!==ESCRITA)throw Error('chave invalida');\nconst principal=digest({scope:'tts-manual-v1',credential:ESCRITA});\nreturn [{json:{_route:'manual',principal}}];\n"+SHA_BYTES+"\nfunction digest(v){return 'd:'+v.credential;}"}},
 {name:'Manual consulta',parameters:{jsCode:ESC+"if(typeof $json.headers?.['x-tts-write-key']!=='string'||$json.headers['x-tts-write-key']!==ESCRITA)return [{json:{status:401}}];\nif($json.query.acao==='capacidades')return [{json:{write:false,cutover_verified:false,admission_verified:false}}];\nreturn [{json:{p:digest({scope:'tts-manual-v1',credential:ESCRITA})}}];\n"+SHA_BYTES+"\nfunction digest(v){return 'd:'+v.credential;}"}},
 {name:'Manual preflight',parameters:{jsCode:"const readiness={cutoverVerified:false,admissionVerified:false};return [{json:readiness}];"}}]});
const run=(w,nome,$json)=>JSON.parse(JSON.stringify(vm.runInNewContext(`(()=>{${w.nodes.find(n=>n.name===nome).parameters.jsCode}})()`,{$json,require,Buffer,Uint8Array,Array,Set,String,unescape,encodeURIComponent,Error})[0].json));
const PAINEL='chave-do-gestor-sintetica';

test('chave de painel com hash liberado decide, edita regra e consulta; outras chaves continuam recusadas',()=>{
 const w=P.patchWorkflow(fake(),{expectedVersionId:'v1',hashes:[sha(PAINEL)]});
 assert.equal(run(w,'Valida',{body:{acao:'revisar',k:PAINEL}}).principal,'d:'+PAINEL,'principal = chave usada');
 assert.equal(run(w,'Valida',{body:{acao:'revisar',k:'chave-antiga-sintetica'}}).principal,'d:chave-antiga-sintetica','chave antiga segue valendo');
 assert.equal(run(w,'Valida',{body:{acao:'regra',k:PAINEL}})._route,'regra');
 assert.throws(()=>run(w,'Valida',{body:{acao:'revisar',k:'outra'}}),/chave invalida/);assert.throws(()=>run(w,'Valida',{body:{acao:'regra',k:''}}),/chave invalida/);
 assert.deepEqual(run(w,'Manual consulta',{headers:{'x-tts-write-key':PAINEL},query:{acao:'capacidades'}}),{write:true,cutover_verified:true,admission_verified:true});
 assert.equal(run(w,'Manual consulta',{headers:{'x-tts-write-key':PAINEL},query:{acao:'operacao'}}).p,'d:'+PAINEL);
 assert.equal(run(w,'Manual consulta',{headers:{'x-tts-write-key':'x'},query:{acao:'capacidades'}}).status,401);
 assert.deepEqual(run(w,'Manual preflight',{}),{cutoverVerified:true,admissionVerified:true});
 assert.ok(!JSON.stringify(w).includes(PAINEL),'a chave em si nunca entra no workflow');
});
test('recusa workflow velho, hash inválido, reaplicação e trecho ausente',()=>{
 assert.throws(()=>P.patchWorkflow({...fake(),activeVersionId:'v0'},{expectedVersionId:'v1',hashes:[sha(PAINEL)]}),/fresco/);
 assert.throws(()=>P.patchWorkflow(fake(),{expectedVersionId:'v1',hashes:['abc']}),/hashes/);
 const w=P.patchWorkflow(fake(),{expectedVersionId:'v1',hashes:[sha(PAINEL)]});assert.throws(()=>P.patchWorkflow(w,{expectedVersionId:'v1',hashes:[sha(PAINEL)]}),/já aplicado/);
 const f=fake();f.nodes[2].parameters.jsCode='return []';assert.throws(()=>P.patchWorkflow(f,{expectedVersionId:'v1',hashes:[sha(PAINEL)]}),/trecho ausente/);
});
