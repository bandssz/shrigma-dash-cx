'use strict';
// Registro de links UTM do Orgânico: montagem igual à planilha, validação no servidor, chave do painel, UI.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
const L=require('../organico-links.js'),W=require('../n8n/organico/links-utm-workflow.cjs');
const SQL=fs.readFileSync(path.join(__dirname,'../n8n/organico/links-utm.sql'),'utf8');
const KEY='organico-chave-sintetica',sha=t=>crypto.createHash('sha256').update(t).digest('hex');
async function db(){const d=new PGlite();await d.exec(`CREATE TABLE crm_dash_chave(chave text,dono text,painel text,ativo boolean,revogada_em timestamptz,expira_em timestamptz,chave_hash text,chave_hash_curta text);
 INSERT INTO crm_dash_chave VALUES('c1','Gestor Orgânico','organico',true,NULL,NULL,'${sha(KEY)}',NULL),('c2','Gestor Influs','influs',true,NULL,NULL,'${sha('influs-chave-sintetica')}',NULL),('c3','Revogada','organico',true,now(),NULL,'${sha('revogada-sintetica')}',NULL);`);
 await d.exec(SQL);await d.exec(SQL);return d;}
const call=async(d,p)=>(await d.query('SELECT organico_link_utm_v1($1::jsonb) AS r',[JSON.stringify(p)])).rows[0].r;
const base={marca:'fish',destino:'https://fishermans.com.br/products/kit-duas-aguas',utm_source:'instagram_social',utm_medium:'story',campanha:'kit_duas_aguas',dia:'2026-09-16'};

test('SQL: chave do Orgânico grava, outras recusam; montagem igual à planilha; repetido não duplica',async()=>{
 const d=await db();
 assert.match((await call(d,{k:'influs-chave-sintetica',acao:'listar'})).erro,/Orgânico/);assert.match((await call(d,{k:'revogada-sintetica',acao:'listar'})).erro,/Orgânico/);
 const seed=(await call(d,{k:KEY,acao:'listar'})).links;assert.equal(seed.length,7,'links históricos da planilha');assert.ok(seed.some(l=>/divergente/.test(l.observacao)));
 const r=await call(d,{k:KEY,acao:'salvar',data:{...base,dia:'2026-09-30',campanha:'kit_novo'}});assert.equal(r.ok,true);assert.equal(r.repetido,false);
 assert.equal(r.link.url,'https://fishermans.com.br/products/kit-duas-aguas?utm_source=instagram_social&utm_medium=story&utm_campaign=20260930_kit_novo');assert.equal(r.link.criado_por,'Gestor Orgânico');
 const planilha=await call(d,{k:KEY,acao:'salvar',data:base});assert.equal(planilha.repetido,true,'mesmo link da planilha já existe');
 const sem=await call(d,{k:KEY,acao:'salvar',data:{...base,dia:'',campanha:'bio_fixa',destino:'https://fishermans.com.br/?ref=x'}});assert.match(sem.link.url,/\?ref=x&utm_source=instagram_social&utm_medium=story&utm_campaign=bio_fixa$/);
 const arq=await call(d,{k:KEY,acao:'arquivar',data:{id:r.link.id}});assert.equal(arq.arquivado,true);assert.equal((await call(d,{k:KEY,acao:'listar'})).links.some(l=>l.id===r.link.id),false);
});
test('SQL: destino fora do site da marca, UTM no destino, lista fechada e campanha com espaço são recusados',async()=>{
 const d=await db();
 for(const [data,re] of [[{destino:'https://oaristocrata.com/x'},/site da marca/],[{destino:'http://fishermans.com.br/'},/https/],[{destino:'https://fishermans.com.br/?utm_source=a'},/sem UTM/],
  [{utm_source:'google'},/Origem/],[{utm_medium:'cpc'},/Superfície/],[{campanha:'com espaço'},/Campanha/],[{dia:'30/09/2026'},/Data/],[{marca:'olivas'},/marca/]])
  assert.match((await call(d,{k:KEY,acao:'salvar',data:{...base,...data}})).erro,re);
 assert.match((await call(d,{k:KEY,acao:'apagar'})).erro,/inválida/);
});
test('UI: prévia bate com o servidor, validação local e vendas por link no período (último clique)',()=>{
 assert.equal(L.monta(base).url,'https://fishermans.com.br/products/kit-duas-aguas?utm_source=instagram_social&utm_medium=story&utm_campaign=20260916_kit_duas_aguas');
 assert.match(L.valida({...base,destino:'https://oaristocrata.com/'}),/Fishermans/);assert.match(L.valida({...base,campanha:'a b'}),/Campanha/);assert.equal(L.valida(base),'');
 const link={marca:'fish',utm_source:'instagram_social',utm_medium:'story',utm_campaign:'20260916_kit_duas_aguas'};
 const api={organico_attribution:{daily:[{model:'last_click',marca:'fishermans',dia:'2026-09-17',...link,pedidos:2,receita_liquida:300},{model:'last_non_direct',marca:'fishermans',dia:'2026-09-17',...link,pedidos:9,receita_liquida:900},{model:'last_click',marca:'fishermans',dia:'2026-08-01',...link,pedidos:5,receita_liquida:1}]}};
 assert.deepEqual(L.vendas(api,link,'2026-09-01','2026-09-30'),{pedidos:2,receita:300});assert.equal(L.vendas({},link,'2026-09-01','2026-09-30'),null);
});
test('UI real: lista, salva com a chave do painel e nunca manda chave na URL',async()=>{
 const {parseHTML}=require('linkedom');const {document}=parseHTML('<html><body><div id="h"></div></body></html>');const calls=[];
 const links=[{id:'1',marca:'fish',dia:'2026-09-16',destino:'https://fishermans.com.br/products/kit-duas-aguas',utm_source:'instagram_social',utm_medium:'story',utm_campaign:'20260916_kit_duas_aguas',url:'https://fishermans.com.br/x',observacao:'',origem:'planilha',criado_por:'planilha da Júlia'}];
 const fetchImpl=async(url,init)=>{const b=JSON.parse(init.body);calls.push({url,b});return {ok:true,json:async()=>b.acao==='listar'?{ok:true,links}:{ok:true,repetido:false,link:{...links[0],url:'https://fishermans.com.br/novo'}}};};
 const ui=L.create({document,endpoint:()=>'https://n8n.invalid/webhook/x',key:()=>KEY,getApi:()=>({}),getMarca:()=>'fish',getPeriod:()=>({ini:'2026-09-01',fim:'2026-09-30'}),fetchImpl});
 ui.mount(document.querySelector('#h'));await new Promise(r=>setTimeout(r,5));
 assert.match(document.querySelector('#h').textContent,/20260916_kit_duas_aguas/);assert.match(document.querySelector('#h').textContent,/planilha/);
 const f=document.querySelector('#ol-form');f.querySelector('[name=destino]').value='https://fishermans.com.br/products/novo';f.querySelector('[name=campanha]').value='novo';
 await f.onsubmit({preventDefault(){}});
 const s=calls.find(c=>c.b.acao==='salvar');assert.ok(s);assert.equal(s.b.k,KEY);assert.equal(s.b.data.campanha,'novo');assert.ok(calls.every(c=>!c.url.includes(KEY)));
});
test('workflow: webhook registrado, corpo como parâmetro nativo, sem histórico de sucesso, CORS do painel',()=>{
 const w=W.buildWorkflow({webhookPath:'organico-links-utm-0a1b2c3d4e5f'});
 assert.equal(w.nodes[0].webhookId,'organico-links-utm-0a1b2c3d4e5f');assert.equal(w.settings.saveDataSuccessExecution,'none');
 assert.equal(w.nodes.find(n=>n.name==='Executa').parameters.options.queryReplacement,'={{ $json.args }}');
 const out=vm.runInNewContext(`(()=>{${W.MONTA}})()`,{$json:{body:{acao:'listar',k:'x'}},JSON,Array,Error})[0].json;assert.equal(out.sql,'SELECT public.organico_link_utm_v1($1::jsonb) AS r');assert.equal(JSON.parse(out.args[0]).acao,'listar');
 assert.throws(()=>vm.runInNewContext(`(()=>{${W.MONTA}})()`,{$json:{body:{acao:'drop'}},JSON,Array,Error}),/acao/);
 assert.ok(JSON.stringify(w).includes('https://bandssz.github.io'));assert.throws(()=>W.buildWorkflow({webhookPath:'x'}),/webhook/);
});
