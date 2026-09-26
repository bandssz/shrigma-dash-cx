'use strict';
// Prévia dos posts: leitura da Graph, gravação com URL que expira, e anexo no cache do Orgânico. Fixtures sintéticas.
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const P=require('../n8n/organico/previa-posts.cjs');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
const monta=(posts,resp)=>vm.runInNewContext(`(()=>{${P.montaCode()}})()`,{$:()=>({all:()=>posts.map(json=>({json}))}),$input:{all:()=>resp.map(json=>({json}))},RegExp,String,Error})[0].json;
const CDN='https://scontent.cdninstagram.com/v/t51/x.jpg?oe=ABC';
// Cópia do nó "Monta upsert" em produção (26/09/2026), sem segredos.
const MONTA_ATUAL="// Grava o payload do Orgânico no cache. Dollar-quoting ($orgjson$) evita escapar 1 MB de JSON; se por acaso a tag aparecer no texto, cai para o escape simples.\nconst r = $input.first().json;\nconst payload = (r && r.body !== undefined) ? r.body : r;\nif (!payload || typeof payload !== 'object' || !payload.gerado_em) throw new Error('payload inesperado da API: ' + JSON.stringify(payload).slice(0, 200));\nlet txt = JSON.stringify(payload);\nconst origemMs = Math.max(0, Math.round(Date.now() - Number($('Marca o relógio').first().json.ms || Date.now())));   // quanto a API de leitura levou\nconst lit = txt.includes('$orgjson$') ? \"'\" + txt.replace(/'/g, \"''\") + \"'\" : '$orgjson$' + txt + '$orgjson$';\nconst sql = `INSERT INTO dash_payload_cache (painel, payload, gerado_em, bytes, origem_ms) VALUES ('organico', ${lit}::jsonb, now(), ${txt.length}, ${origemMs})\n  ON CONFLICT (painel) DO UPDATE SET payload = EXCLUDED.payload, gerado_em = now(), bytes = EXCLUDED.bytes, origem_ms = EXCLUDED.origem_ms`;\nreturn [{ json: { sql, bytes: txt.length, blocos: Object.keys(payload).length } }];";
const cache=()=>({name:'cache',nodes:[
 {name:'A cada 10 min',type:'n8n-nodes-base.scheduleTrigger',position:[0,0],parameters:{}},
 {name:'Marca o relógio',type:'n8n-nodes-base.postgres',position:[260,100],credentials:{postgres:{id:'pg-sintetico',name:'pg'}},parameters:{}},
 {name:'API de leitura (painel=organico)',type:'n8n-nodes-base.httpRequest',position:[520,100],parameters:{}},
 {name:'Monta upsert',type:'n8n-nodes-base.code',position:[780,100],parameters:{jsCode:MONTA_ATUAL}},
 {name:'Grava dash_payload_cache',type:'n8n-nodes-base.postgres',position:[1040,100],parameters:{}}],
 connections:{'A cada 10 min':{main:[[{node:'Marca o relógio',type:'main',index:0}]]},'Marca o relógio':{main:[[{node:'API de leitura (painel=organico)',type:'main',index:0}]]},
  'API de leitura (painel=organico)':{main:[[{node:'Monta upsert',type:'main',index:0}]]},'Monta upsert':{main:[[{node:'Grava dash_payload_cache',type:'main',index:0}]]}}});

test('imagem usa media_url, vídeo usa a capa, URL fora da CDN da Meta vira sem prévia',()=>{
 const posts=[{obj_id:'1',marca:'fishermans',conta:'fish'},{obj_id:'2',marca:'fishermans',conta:'fish'},{obj_id:'3',marca:'aristocrata',conta:'ar'},{obj_id:'4',marca:'aristocrata',conta:'ar'}];
 const out=monta(posts,[{id:'1',media_type:'IMAGE',media_url:CDN},{id:'2',media_type:'VIDEO',media_url:'https://video.cdninstagram.com/v.mp4',thumbnail_url:'https://scontent-gru1-1.cdninstagram.com/t.jpg'},
  {id:'3',media_type:'CAROUSEL_ALBUM',media_url:'https://evil.example/x.jpg'},{error:{code:100,message:'Unsupported get request'}}]);
 assert.equal(out.lidos,3);assert.equal(out.n_falhas,1);
 assert.match(out.sql,/'1','fishermans','fish','IMAGE','https:\/\/scontent\.cdninstagram\.com/);
 assert.match(out.sql,/'2','fishermans','fish','VIDEO','https:\/\/scontent-gru1-1\.cdninstagram\.com\/t\.jpg'/);assert.doesNotMatch(out.sql,/v\.mp4/);
 assert.match(out.sql,/'3','aristocrata','ar','CAROUSEL_ALBUM',NULL,true/);assert.doesNotMatch(out.sql,/evil/);
 assert.match(out.sql,/'4','aristocrata','ar',NULL,NULL,false,'#100 Unsupported/);
 assert.throws(()=>monta(posts.slice(0,1),[{error:{code:190,message:'x'}}]),/todas as leituras falharam/);
});

test('SQL real: erro preserva a última URL sem renová-la; o cache só publica URL verificada em 72 h',async()=>{
 const db=new PGlite();await db.exec(P.SQL);await db.exec(P.SQL);
 const posts=[{obj_id:'10',marca:'fishermans',conta:'fish'},{obj_id:'11',marca:'fishermans',conta:'fish'}];
 await db.exec(monta(posts,[{id:'10',media_type:'IMAGE',media_url:CDN},{id:'11',media_type:'IMAGE',media_url:CDN+'2'}]).sql);
 await db.exec("UPDATE cx_social_post_midia SET verificado_em=now()-interval '80 hours' WHERE post_id='11'");
 await db.exec(monta(posts,[{id:'10',media_type:'IMAGE',media_url:CDN+'novo'},{error:{code:4,message:'limite'}}]).sql);
 const r=(await db.query("SELECT post_id,previa_url,ok,verificado_em < now()-interval '79 hours' velho FROM cx_social_post_midia ORDER BY post_id")).rows;
 assert.deepEqual(r,[{post_id:'10',previa_url:CDN+'novo',ok:true,velho:false},{post_id:'11',previa_url:CDN+'2',ok:false,velho:true}]);
 const pub=JSON.parse((await db.query(P.PREVIA_SQL)).rows[0].midia);
 assert.deepEqual(pub,[{post_id:'10',tipo:'IMAGE',previa_url:CDN+'novo'}]);
 await db.exec('DELETE FROM cx_social_post_midia');assert.equal((await db.query(P.PREVIA_SQL)).rows[0].midia,'[]');
});

test('workflow novo: credenciais existentes por id, webhook registrado, nada embutido e histórico de sucesso desligado',()=>{
 const w=P.buildWorkflow({webhookPath:'organico-previa-posts-1a2b3c4d'});
 assert.deepEqual(w.nodes.map(n=>n.name),['Diario 05:55','Forcar (GET)','Lista posts','Midia do post','Monta SQL','Grava previa']);
 assert.equal(w.nodes.find(n=>n.name==='Forcar (GET)').webhookId,'organico-previa-posts-1a2b3c4d');
 assert.equal(w.nodes.find(n=>n.name==='Midia do post').credentials.httpHeaderAuth.name,'Meta WA — token permanente (Bearer)');
 assert.doesNotMatch(JSON.stringify(w),/access_token|EAA[A-Za-z0-9]{10}/);assert.equal(w.settings.saveDataSuccessExecution,'none');
 assert.match(P.LISTA_SQL,/rede='instagram' AND origem='organico'/);
 assert.throws(()=>P.buildWorkflow({webhookPath:'x'}),/webhook/);
});

test('cache: anexa só prévias https, falha da leitura não derruba o payload e o resto do SQL fica igual',()=>{
 const w=P.patchCache(cache());
 assert.deepEqual(w.connections['API de leitura (painel=organico)'].main[0].map(x=>x.node),[P.CACHE_PREVIA]);
 assert.deepEqual(w.connections[P.CACHE_PREVIA].main[0].map(x=>x.node),['Monta upsert']);
 const no=w.nodes.find(n=>n.name===P.CACHE_PREVIA);assert.equal(no.alwaysOutputData,true);assert.equal(no.credentials.postgres.id,'pg-sintetico');
 assert.throws(()=>P.patchCache(w),/já tem/);
 const code=w.nodes.find(n=>n.name==='Monta upsert').parameters.jsCode;
 const run=(midia,api={body:{gerado_em:'2026-09-26T10:00:00Z',_escopo:'organico',cx_post:[]}})=>vm.runInNewContext(`(()=>{${code}})()`,{
  $:name=>({first:()=>({json:name==='API de leitura (painel=organico)'?api:name==='Marca o relógio'?{ms:Date.now()}:{midia}})}),$input:{first:()=>({json:'não usar'})},JSON,Math,Number,Date,Object,Array,Error})[0].json;
 const ok=run(JSON.stringify([{post_id:'10',tipo:'IMAGE',previa_url:CDN},{post_id:'11',previa_url:'http://inseguro'},{post_id:12,previa_url:CDN}]));
 const payload=JSON.parse(ok.sql.split('$orgjson$')[1]);
 assert.deepEqual(payload.cx_post_midia,[{post_id:'10',tipo:'IMAGE',previa_url:CDN}]);assert.deepEqual(payload.cx_post,[]);
 const semLeitura=JSON.parse(run(undefined).sql.split('$orgjson$')[1]);assert.deepEqual(semLeitura.cx_post_midia,[]);
 const quebrado=JSON.parse(run('{nao json').sql.split('$orgjson$')[1]);assert.deepEqual(quebrado.cx_post_midia,[]);
 assert.throws(()=>run('[]',{body:{}}),/payload inesperado/);
 const mudou=cache();mudou.nodes[3].parameters.jsCode='return []';assert.throws(()=>P.patchCache(mudou),/mudou/);
});

test('Post a post: prévia só de URL da Meta, moldura sem prévia, sem coluna de sentimento e filtro de formato',()=>{
 const fs=require('node:fs'),path=require('node:path'),{parseHTML}=require('linkedom');
 const html=fs.readFileSync(path.join(__dirname,'../organico.html'),'utf8');
 const {document}=parseHTML(`<html><body><select id="post-formato"><option value="">todos</option></select><table id="tab-posts"><thead><tr><th class="ord" data-c="publicado_em"></th></tr></thead><tbody></tbody></table></body></html>`);
 const ths=[...parseHTML(html).document.querySelectorAll('#tab-posts th')].map(t=>t.textContent);assert.ok(!ths.some(t=>/Negativ/i.test(t)),'sentimento fora da visão');
 assert.doesNotMatch(html.slice(html.indexOf('function pintaKPIs(){'),html.indexOf('/* ---------- grade:')),/negativos/);
 const a=html.indexOf('let MIDIA=null;'),b=html.indexOf('function posts(ini,fim){'),c=html.indexOf('function pintaPosts(lista){'),d=html.indexOf('/* ---------- stories ---------- */');
 const ctx=vm.createContext({document,$:s=>document.querySelector(s),esc:v=>String(v??'').replace(/[<>&"]/g,x=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[x])),
  nf:String,pc:v=>v==null?'—':v+'%',tag:m=>m,FILTRO:'todos',ORD:{col:'publicado_em',dir:-1},Date,
  API:{cx_post_midia:[{post_id:'1',previa_url:CDN},{post_id:'2',previa_url:'https://evil.example/x.jpg'},{post_id:'3',previa_url:'javascript:alert(1)'}]}});
 vm.runInContext(html.slice(a,b)+html.slice(c,d)+';globalThis.previas=previas;globalThis.pintaPosts=pintaPosts;',ctx);
 const mid=ctx.previas();const post=(id,o={})=>({post_id:id,publicado_em:'2026-09-20T12:00:00Z',marca:'fish',formato:'REELS',permalink:'https://www.instagram.com/reel/x/',eq:1,percentil:50,previa:(mid[id]||{}).previa_url||null,...o});
 ctx.pintaPosts([post('1'),post('2'),post('3',{formato:'FEED',permalink:'javascript:alert(1)'})]);
 const imgs=[...document.querySelectorAll('#tab-posts img')];assert.equal(imgs.length,1);assert.equal(imgs[0].getAttribute('src'),CDN);assert.equal(imgs[0].getAttribute('referrerpolicy'),'no-referrer');
 assert.equal(document.querySelectorAll('.post-thumb.sem-previa').length,2);assert.doesNotMatch(document.body.innerHTML,/javascript:|evil/);
 assert.match(document.querySelector('#post-formato').innerHTML,/reels \(2\)/);
 document.querySelector('#post-formato').innerHTML+='';for(const o of document.querySelectorAll('#post-formato option'))o.toggleAttribute('selected',o.value==='FEED');
 ctx.pintaPosts([post('1'),post('3',{formato:'FEED'})]);assert.equal(document.querySelectorAll('#tab-posts tbody tr').length,1);
});
