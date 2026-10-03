'use strict';
/* Front do painel growth para o contrato de leitura por marca (§9.5/§9.2 de
   docs/crm/PARIDADE-LEITURA-PORTAL-20261003.md). Prova, em fixture sintética e nas duas marcas:
   - OFF (servidor não anuncia `capabilities.templates.read_content` + `read_contract`): requisições
     byte a byte iguais às da base declarada (fixture explícita em tests/fixtures/claude-front-read-brand,
     cópia de 1405de5 conferida por sha256, bytes e blob git — não depende de histórico do checkout);
   - ON: marca fish|aristo obrigatória, paginação offset/limit, pedidos aceitos pela ponte real;
   - resposta com item de outra marca/sem marca descartada inteira, com mensagem, nunca exibida;
   - mídia: `legacy:true` (saída real do validador) etiquetado e não contado como da marca.
   Nada sai da máquina. */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const {webcrypto}=crypto,{parseHTML}=require('linkedom');
const Bridge=require('../services/dashboard-operational/crm-template-read-bridge.cjs');
const MediaRead=require('../services/dashboard-operational/crm-media-read-validator.cjs');

const ROOT=path.join(__dirname,'..'),E='https://example.invalid/templates',CONTRACT='crm-template-read-v1';
const read=f=>fs.readFileSync(path.join(ROOT,f),'utf8');
// Base portátil: arquivo da base copiado na fixture; o manifesto fixa commit, sha256, bytes e blob git.
const FIXTURE=path.join(__dirname,'fixtures','claude-front-read-brand'),MANIFEST=JSON.parse(fs.readFileSync(path.join(FIXTURE,'manifest.json'),'utf8'));
function baseSource(f){const [name,meta]=Object.entries(MANIFEST.files).find(([,m])=>m.source===f)||[];if(!meta)throw Error('fixture de base ausente para '+f);
 const b=fs.readFileSync(path.join(FIXTURE,name));
 assert.equal(b.length,meta.bytes,f+': bytes da base');assert.equal(crypto.createHash('sha256').update(b).digest('hex'),meta.sha256,f+': sha256 da base');
 assert.equal(crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${b.length}\0`),b])).digest('hex'),meta.git_blob,f+': blob git da base');
 return b.toString('utf8');}
const hex=(n,c)=>c.repeat(n);
function loadGTA(source){const c=vm.createContext({URLSearchParams,AbortSignal,Intl,Date,console});vm.runInContext(source+'\nthis.GTA=GTA;',c);return c.GTA;}
// Registro do que vai para a rede: URL inteira e init sem o sinal (o AbortSignal é um objeto novo a cada chamada).
function recorder(reply){const calls=[];const fetch=async(url,init={})=>{const {signal,...rest}=init;calls.push({url:String(url),init:JSON.stringify(rest),signal:!!signal});return reply(String(url),init);};return {calls,fetch};}
const ok=body=>({status:200,json:async()=>JSON.parse(JSON.stringify(body))});
const tpl=(brand,id,over={})=>({key:'email.template.'+id,brand,channel:'email',id:String(id),name:`Template ${brand} ${id} <b>&</b>`,type:'campaign',draft_id:null,components:{subject:'Assunto '+id,body_html:'<p>Corpo '+id+'</p>',altbody:null},content_available:true,content_hash:hex(64,'a'),updated_at:'2026-10-03T12:00:00Z',...over});
// Servidor sintético no contrato crm-template-read-v1: cada marca tem seu catálogo; `poison` injeta um item no pedido indicado.
function server(catalog,{poison=null,history={},submissions={}}={}){
 return recorder(url=>{
  const q=new URL(url).searchParams,brand=q.get('marca'),acao=q.get('acao');
  if(acao==='listar'){
   const all=catalog[brand]||[],offset=Number(q.get('offset')),limit=Number(q.get('limit')),templates=all.slice(offset,offset+limit).map(x=>({...x}));
   if(poison&&poison.brand===brand&&poison.offset===offset)templates[poison.at??0]=poison.item;
   return ok({contract:CONTRACT,brand:poison?.topBrand||brand,channel:'email',templates,offset,limit,total:all.length,next_offset:offset+limit<all.length?offset+limit:null,coverage:'registered_email_only',consultado_em:'2026-10-03T12:00:00Z',schedule_proof:false});
  }
  if(acao==='historico'){const h=history[q.get('draft_id')];return h?ok({contract:'crm-template-history-read-v1',brand:h.brand,draft_id:q.get('draft_id'),events:h.events,truncated:false,read_at:'2026-10-03T12:00:00Z'}):{status:404,json:async()=>({erro:'not_found'})};}
  if(acao==='submissao'){const s=submissions[q.get('submission_id')];return s?ok({contract:'crm-template-submission-read-v1',brand:s.brand,submission_id:q.get('submission_id'),draft_id:s.draft_id,draft_version:2,provider:'listmonk',estado:s.estado,provider_status:s.provider_status??null,rejected_reason:null,checked_at:'2026-10-03T12:00:00Z',read_at:'2026-10-03T12:00:00Z',provider_polled:false}):{status:404,json:async()=>({erro:'not_found'})};}
  throw Error('ação inesperada '+acao);
 });
}
// Toda requisição ON precisa ser aceita pela ponte real (mesmo vocabulário), e o que ela reescreve vai ao destino.
function bridgeAccepts(url){const q=new URL(url).searchParams;return Bridge.decision('templates','GET',q);}

/* ---------------- OFF: idêntico ao código-base ---------------- */
test('OFF: sem read_contract (ou com outro valor) as leituras saem byte a byte iguais às da base (fixture 1405de5), ignorando a marca extra',async()=>{
 const now=loadGTA(read('growth-templates-api.js')),before=loadGTA(baseSource('growth-templates-api.js'));
 for(const templates of [undefined,{read_content:true,list_history:true},{read_content:true,read_contract:'crm-template-read-v2'},{read_content:true,read_contract:true},{read_content:true,read_contract:' crm-template-read-v1'}]){
  const api={capabilities:{templates,endpoints:{templates:E}}},caps=now.caps(api);
  assert.equal(caps.leitura_marca,false);
  const run=async(G,leituraMarca)=>{const r=recorder(()=>ok({templates:[]}));const c=G.cliente({endpoint:E,fetch:r.fetch,chaveLeitura:'synthetic-read',chaveEscrita:'synthetic-write',leituraMarca});
   for(const [m,canal] of [['fish'],['aristo','email'],['aristo','whatsapp'],['todas'],['olivas'],[undefined]])await c.listar(m,canal);
   await c.historico({key:'fish_paid'},'aristo');await c.historico({draft_id:'d_1'},'fish');await c.submissao('s_1','aristo');await c.submissao('s_2');
   return r.calls;};
  const a=await run(now,caps.leitura_marca),b=await run(before,undefined);
  assert.deepEqual(a,b);
  assert.deepEqual(a.map(x=>x.url),[`${E}?acao=listar&marca=fish`,`${E}?acao=listar&marca=aristo&canal=email`,`${E}?acao=listar&marca=aristo&canal=whatsapp`,`${E}?acao=listar`,`${E}?acao=listar&marca=olivas`,`${E}?acao=listar`,`${E}?acao=historico&key=fish_paid`,`${E}?acao=historico&draft_id=d_1`,`${E}?acao=submissao&submission_id=s_1`,`${E}?acao=submissao&submission_id=s_2`]);
 }
 // O resto das capacidades e a tradução de erro não mudam.
 const api={capabilities:{templates:{read_content:true,draft:true},endpoints:{templates:E}}},{leitura_marca,...rest}=now.caps(api);
 assert.deepEqual(JSON.parse(JSON.stringify(rest)),JSON.parse(JSON.stringify(before.caps(api))));assert.equal(leitura_marca,false);
 for(const res of [{rede:true},{status:401},{status:403,body:{capability:'x'}},{status:502,body:{}},{status:500}])assert.deepEqual(JSON.parse(JSON.stringify(now.erro(res,'listar'))),JSON.parse(JSON.stringify(before.erro(res,'listar'))));
});

/* ---------------- ON: marca e paginação ---------------- */
test('ON: listar pagina com offset/limit=20 só da marca pedida, nas duas marcas, em pedidos aceitos pela ponte',async()=>{
 const G=loadGTA(read('growth-templates-api.js'));
 assert.equal(G.caps({capabilities:{templates:{read_content:true,read_contract:CONTRACT},endpoints:{templates:E}}}).leitura_marca,true);
 const catalog={fish:Array.from({length:45},(_,i)=>tpl('fish',i+1)),aristo:Array.from({length:7},(_,i)=>tpl('aristo',100+i))};
 for(const [brand,pages,total] of [['fish',3,45],['aristo',1,7]]){
  const s=server(catalog),c=G.cliente({endpoint:E,fetch:s.fetch,chaveLeitura:'synthetic-read',leituraMarca:true}),res=await c.listar(brand);
  assert.equal(res.ok,true);assert.equal(res.body.templates.length,total);assert.ok(res.body.templates.every(t=>t.brand===brand));assert.equal(res.body.paginas,pages);
  assert.deepEqual(s.calls.map(x=>x.url),Array.from({length:pages},(_,i)=>`${E}?acao=listar&marca=${brand}&canal=email&offset=${i*20}&limit=20`));
  for(const call of s.calls){const d=bridgeAccepts(call.url);assert.equal(d.brand,brand);assert.equal(d.query.get('channel'),'email');}
  // Mesmo transporte de leitura de hoje: Bearer da chave de leitura, sem credencial na URL, sem cookies.
  assert.deepEqual(JSON.parse(s.calls[0].init),{headers:{Authorization:'Bearer synthetic-read'},cache:'no-store',credentials:'omit',redirect:'error'});
  assert.equal(new URL(s.calls[0].url).searchParams.has('k'),false);
  // A página real valida também na ponte (mesmo contrato).
  const page=await (await s.fetch(s.calls[0].url)).json();assert.doesNotThrow(()=>Bridge.responseShape(bridgeAccepts(s.calls[0].url),page));
 }
});

test('ON: marca todas/olivas/ausente, canal WhatsApp e histórico por key não disparam leitura',async()=>{
 const G=loadGTA(read('growth-templates-api.js')),s=server({fish:[tpl('fish',1)]}),c=G.cliente({endpoint:E,fetch:s.fetch,chaveLeitura:'synthetic-read',leituraMarca:true});
 const results=[await c.listar('todas'),await c.listar('olivas'),await c.listar(undefined),await c.listar(''),await c.listar('fish','whatsapp'),await c.historico({key:'fish_paid'},'fish'),await c.historico({draft_id:'d_1'},'todas'),await c.historico({draft_id:'d_1'},'olivas'),await c.submissao('s_1','todas'),await c.submissao('s_1','olivas'),await c.submissao('s_1')];
 assert.equal(s.calls.length,0);
 for(const r of results){assert.equal(r.ok,false);assert.equal(typeof r.semLeitura,'string');const e=G.erro(r,'listar');assert.match(e.texto,/Nada foi consultado\./);assert.equal(e.tipo,'indisponivel');}
 assert.match(results[0].semLeitura,/Escolha Fishermans ou O Aristocrata/);
});

test('ON: historico e submissao levam a marca e o identificador; pedidos aceitos pela ponte e respostas válidas nela',async()=>{
 const G=loadGTA(read('growth-templates-api.js'));
 const s=server({},{history:{d_fish:{brand:'fish',events:[{at:'2026-10-03T11:00:00Z',who:'gestor',action:'rascunho',from_version:null,to_version:1,result:'201',detail:null}]}},submissions:{s_aristo:{brand:'aristo',draft_id:'d_aristo',estado:'publicado'}}});
 const c=G.cliente({endpoint:E,fetch:s.fetch,chaveLeitura:'synthetic-read',leituraMarca:true});
 const h=await c.historico({draft_id:'d_fish'},'fish'),sub=await c.submissao('s_aristo','aristo');
 assert.equal(h.ok,true);assert.equal(h.body.events.length,1);assert.equal(sub.ok,true);assert.equal(sub.body.estado,'publicado');
 assert.deepEqual(s.calls.map(x=>x.url),[`${E}?acao=historico&marca=fish&draft_id=d_fish`,`${E}?acao=submissao&marca=aristo&submission_id=s_aristo`]);
 for(const call of s.calls){const d=bridgeAccepts(call.url);assert.doesNotThrow(()=>Bridge.responseShape(d,JSON.parse(JSON.stringify(call.url.includes('historico')?h.body:sub.body))));}
 // 404 da ponte (outra marca vira "não encontrado") segue a tradução de sempre.
 const miss=await c.submissao('s_inexistente','aristo');assert.equal(miss.ok,false);assert.equal(miss.status,404);
});

/* ---------------- ON: resposta de outra marca/sem marca ---------------- */
test('ON: item de outra marca, sem marca ou topo de outra marca descarta a resposta inteira (inclusive páginas já lidas)',async()=>{
 const G=loadGTA(read('growth-templates-api.js')),catalog={fish:Array.from({length:30},(_,i)=>tpl('fish',i+1)),aristo:Array.from({length:3},(_,i)=>tpl('aristo',50+i))};
 const cases=[['fish',{brand:'fish',offset:20,at:3,item:tpl('aristo',24)}],['aristo',{brand:'aristo',offset:0,at:1,item:tpl('fish',51)}],['fish',{brand:'fish',offset:0,item:(({brand,...x})=>x)(tpl('fish',1))}],['fish',{brand:'fish',offset:0,item:tpl(null,1)}],['aristo',{brand:'aristo',offset:0,item:tpl('olivas',50)}],['fish',{brand:'fish',offset:0,topBrand:'aristo',item:tpl('fish',1)}]];
 for(const [brand,poison] of cases){
  const s=server(catalog,{poison}),res=await G.cliente({endpoint:E,fetch:s.fetch,chaveLeitura:'r',leituraMarca:true}).listar(brand);
  assert.equal(res.ok,false);assert.equal(res.body,null,'nada da resposta é devolvido para exibir');assert.equal(res.recusada,G.RECUSA_MARCA);
  assert.deepEqual(JSON.parse(JSON.stringify(G.erro(res,'listar'))),{texto:G.RECUSA_MARCA,tipo:'incerto'});
  // A própria ponte também recusaria essa página.
  const last=s.calls.at(-1).url,page=await (await s.fetch(last)).json();assert.throws(()=>Bridge.responseShape(bridgeAccepts(last),page),/TEMPLATE_READ_RESPONSE_DENIED/);
 }
 const h=server({},{history:{d_1:{brand:'aristo',events:[]}},submissions:{s_1:{brand:'aristo',draft_id:'d_1',estado:'publicado'}}}),c=G.cliente({endpoint:E,fetch:h.fetch,chaveLeitura:'r',leituraMarca:true});
 for(const r of [await c.historico({draft_id:'d_1'},'fish'),await c.submissao('s_1','fish')]){assert.equal(r.ok,false);assert.equal(r.body,null);assert.equal(r.recusada,G.RECUSA_MARCA);}
 // Fora do contrato (sem paginação coerente) também é descartada.
 const bad=recorder(()=>ok({contract:CONTRACT,brand:'fish',channel:'email',templates:[tpl('fish',1)],offset:0,limit:20,total:5,next_offset:null,coverage:'registered_email_only',consultado_em:'2026-10-03T12:00:00Z',schedule_proof:false}));
 const r=await G.cliente({endpoint:E,fetch:bad.fetch,chaveLeitura:'r',leituraMarca:true}).listar('fish');assert.equal(r.ok,false);assert.equal(r.recusada,G.RECUSA_CONTRATO);
});

/* ---------------- tela de templates (growth-control): Carregar conteúdo ---------------- */
function control({api,fetch,marca='fish'}){
 const {document,window}=parseHTML('<body><div id="control-workflows"></div><div id="control-templates"></div></body>');
 const context=vm.createContext({document,window,Date,Intl,console,URL,URLSearchParams,AbortSignal,fetch,localStorage:{getItem:()=>'synthetic-read'},shrigmaChave:()=>'synthetic-read'}),run=s=>vm.runInContext(s,context);
 run(read('growth-templates-api.js'));run(read('growth-control.js'));context.ctx={api,marca,canal:'email'};run('GC.render(ctx)');
 return {document,run,context};
}
const controlApi=read_contract=>({crm_operacao:JSON.parse(read('tests/fixtures/growth-control.json')),capabilities:{templates:{read_content:true,list_history:true,...(read_contract?{read_contract}:{})},endpoints:{templates:E}}});
test('Carregar conteúdo: OFF pede como antes; ON pagina a marca do cabeçalho; outra marca nunca é exibida; todas não consulta',async()=>{
 const catalog={fish:Array.from({length:25},(_,i)=>tpl('fish',i+1)),aristo:[tpl('aristo',90)]};
 const off=recorder(()=>ok({templates:[{key:'fish_paid',name:'x',brand:'fish',channel:'whatsapp'}]})),x=control({api:controlApi(null),fetch:off.fetch});
 await x.run('GC.carregarConteudo(GC.previewContext)');assert.deepEqual(off.calls.map(c=>c.url),[`${E}?acao=listar&marca=fish`]);assert.deepEqual(Object.keys(x.run('GC.conteudo')),['fish_paid']);
 await x.run('GC.conteudo=null;GC.carregarHistorico(GC.previewContext,"fish_paid")');assert.equal(off.calls.at(-1).url,`${E}?acao=historico&key=fish_paid`);
 for(const brand of ['fish','aristo']){
  const s=server(catalog),y=control({api:controlApi(CONTRACT),fetch:s.fetch,marca:brand});await y.run('GC.carregarConteudo(GC.previewContext)');
  assert.deepEqual(s.calls.map(c=>c.url),brand==='fish'?[`${E}?acao=listar&marca=fish&canal=email&offset=0&limit=20`,`${E}?acao=listar&marca=fish&canal=email&offset=20&limit=20`]:[`${E}?acao=listar&marca=aristo&canal=email&offset=0&limit=20`]);
  const loaded=Object.values(y.run('GC.conteudo'));assert.equal(loaded.length,catalog[brand].length);assert.ok(loaded.every(t=>t.brand===brand));assert.equal(y.run('GC.conteudoErro'),null);
  // Histórico por key de template publicado não é servido pelo contrato: nenhuma leitura, mensagem acionável.
  await y.run('GC.carregarHistorico(GC.previewContext,"fish_paid")');assert.equal(s.calls.length,brand==='fish'?2:1);assert.match(y.run('GC.conteudoErro'),/não está disponível neste acesso/);assert.equal(y.run('GC.historicos.fish_paid'),undefined);
 }
 // Resposta com item da outra marca: descartada inteira, nada carregado, mensagem visível na tela.
 const poisoned=server(catalog,{poison:{brand:'fish',offset:20,item:tpl('aristo',21,{name:'<img src=x onerror=alert(1)> vazou'})}}),z=control({api:controlApi(CONTRACT),fetch:poisoned.fetch});
 await z.run('GC.carregarConteudo(GC.previewContext)');assert.equal(z.run('GC.conteudo'),null);assert.equal(z.run('GC.conteudoErro'),loadGTA(read('growth-templates-api.js')).RECUSA_MARCA);
 assert.doesNotMatch(z.document.body.innerHTML,/vazou|onerror/);
 // Marca todas no cabeçalho: nenhuma leitura nova.
 const none=recorder(()=>assert.fail('não deveria consultar')),w=control({api:controlApi(CONTRACT),fetch:none.fetch,marca:'todas'});
 await w.run('GC.carregarConteudo(GC.previewContext)');assert.equal(none.calls.length,0);assert.match(w.run('GC.conteudoErro'),/Escolha Fishermans ou O Aristocrata/);
});

/* ---------------- rascunhos (growth-drafts-ui): verificar submissão e histórico ---------------- */
const FILES=['growth-email-expressions.js','whatsapp-template-contract.js','growth-email-contract.js','growth-drafts.js','growth-templates-api.js','growth-template-journal.js','growth-table.js','growth-message-preview.js','growth-brand-state.js','growth-drafts-ui.js'];
function drafts({api,fetch,brand}){
 const {document,window}=parseHTML('<html><body><section id="control-drafts"></section></body></html>'),values=new Map();
 window.HTMLElement.prototype.focus=function(){};window.HTMLElement.prototype.scrollIntoView=function(){};
 const ctx=vm.createContext({document,window,localStorage:{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k)},crypto:webcrypto,TextEncoder,TextDecoder,URL,URLSearchParams,AbortSignal,Date,Intl,console,setInterval:()=>1,
  navigator:{locks:{request:async(_k,_o,fn)=>fn({})}},shrigmaChave:()=>'synthetic-read',shrigmaChaveOperador:()=>'synthetic-write',confirm:()=>{throw Error('native confirm forbidden');},fetch});
 for(const f of FILES)vm.runInContext(read(f),ctx,{filename:f});
 const run=s=>vm.runInContext(s,ctx);run('globalThis.ui=GRU;globalThis.gr=GR;');ctx.ui.render({marca:brand,api});
 const seed=(marca,servidor)=>run(`(()=>{const r=GR.novo({canal:'email',marca:${JSON.stringify(marca)}});r.servidor=${JSON.stringify(servidor)};GR.guarda(r);return r.id;})()`);
 const get=id=>ctx.gr.lista().find(r=>r.id===id);
 return {ctx,run,seed,get,values,document};
}
const draftApi=read_contract=>({capabilities:{templates:{read_content:true,list_history:true,...(read_contract?{read_contract}:{})},endpoints:{templates:E}}});
test('Rascunhos: OFF consulta submissão e histórico como antes; ON leva a marca dona do rascunho nas duas marcas',async()=>{
 const servidor=(brand,extra={})=>({draft_id:'d_'+brand,version:2,estado:'submetido',submission_id:'s_'+brand,provider:'listmonk',submitted_at:'2026-10-03T10:00:00Z',template_key:'tpl_'+brand,...extra});
 const off=recorder(url=>new URL(url).searchParams.get('acao')==='submissao'?ok({estado:'publicado',provider_status:'APPROVED'}):ok({events:[]}));
 const x=drafts({api:draftApi(null),fetch:off.fetch,brand:'fish'}),idOff=x.seed('fish',servidor('fish'));
 await x.ctx.ui.verificarSubmissao(x.get(idOff),true);await x.ctx.ui.carregarHistorico(x.get(idOff));
 assert.deepEqual(off.calls.map(c=>c.url),[`${E}?acao=submissao&submission_id=s_fish`,`${E}?acao=historico&key=tpl_fish`]);
 assert.equal(x.get(idOff).servidor.estado,'publicado');
 for(const brand of ['fish','aristo']){
  const s=server({},{history:{['d_'+brand]:{brand,events:[{at:'2026-10-03T11:00:00Z',who:'gestor',action:'validar',from_version:1,to_version:2,result:'200',detail:null}]}},submissions:{['s_'+brand]:{brand,draft_id:'d_'+brand,estado:'publicado',provider_status:'APPROVED'}}});
  const y=drafts({api:draftApi(CONTRACT),fetch:s.fetch,brand}),id=y.seed(brand,servidor(brand));
  await y.ctx.ui.verificarSubmissao(y.get(id),true);await y.ctx.ui.carregarHistorico(y.get(id));
  assert.deepEqual(s.calls.map(c=>c.url),[`${E}?acao=submissao&marca=${brand}&submission_id=s_${brand}`,`${E}?acao=historico&marca=${brand}&draft_id=d_${brand}`]);
  for(const c of s.calls)bridgeAccepts(c.url);
  assert.equal(y.get(id).servidor.estado,'publicado');assert.equal(y.get(id).servidor.historico.length,1);
 }
});

test('Rascunhos ON: submissão/histórico de outra marca é descartado sem alterar o rascunho; Olivas não consulta',async()=>{
 const s=server({},{history:{d_fish:{brand:'aristo',events:[{at:'2026-10-03T11:00:00Z',who:'<script>x</script>',action:'vazou',from_version:1,to_version:2,result:'200',detail:null}]}},submissions:{s_fish:{brand:'aristo',draft_id:'d_fish',estado:'publicado',provider_status:'APPROVED'}}});
 const y=drafts({api:draftApi(CONTRACT),fetch:s.fetch,brand:'fish'}),id=y.seed('fish',{draft_id:'d_fish',version:2,estado:'submetido',submission_id:'s_fish',provider:'listmonk'});
 const before=JSON.stringify(y.get(id).servidor);
 await y.ctx.ui.verificarSubmissao(y.get(id));assert.equal(JSON.stringify(y.get(id).servidor),before,'estado não muda com resposta de outra marca');
 assert.match(y.ctx.ui.state.msg,/outra marca ou sem marca\. A resposta foi descartada inteira/);
 await y.ctx.ui.carregarHistorico(y.get(id));assert.equal(y.get(id).servidor.historico,undefined);assert.match(y.ctx.ui.state.msg,/^Histórico indisponível: A consulta devolveu template de outra marca/);
 assert.doesNotMatch(y.document.body.innerHTML,/vazou|<script>x/);
 assert.equal(s.calls.length,2);
 // Rascunho legado de Olivas: nenhum pedido novo.
 const o=y.seed('olivas',{draft_id:'d_ol',version:1,estado:'submetido',submission_id:'s_ol',provider:'listmonk'});
 await y.ctx.ui.verificarSubmissao(y.get(o));await y.ctx.ui.carregarHistorico(y.get(o));assert.equal(s.calls.length,2);
});

/* ---------------- mídia: legado etiquetado ---------------- */
const UUID='11111111-1111-4111-8111-111111111111',SHA=hex(64,'b');
const mediaItem=(id,filename,over={})=>({id,filename,url:'https://email.shrigma.com.br/uploads/'+filename,thumb_url:'https://email.shrigma.com.br/uploads/thumb_'+filename,content_type:'image/png',width:600,height:300,created_at:'2026-10-01T10:00:00Z',...over});
function mediaPage(brand,items){return {contract:'crm-media-v1',brand,items,total:items.length,page:1,per_page:24,next_page:null};}
function media(body){
 const {document,window}=parseHTML('<html><body><section id="crm-media"></section></body></html>'),calls=[];
 const fetch=async(url)=>{calls.push(url);return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});};
 const context=vm.createContext({document,window,URL,URLSearchParams,AbortSignal,FormData,crypto:webcrypto,navigator:{locks:{request:async(_n,_o,fn)=>fn({})}},sessionStorage:{getItem:()=>null,setItem(){}},fetch});
 vm.runInContext(read('growth-media.js'),context);const api=vm.runInContext('GMedia',context);
 api.mount({marca:body.brand,api:{capabilities:{campaigns:{contract_version:'crm-campaign-v1',read:true,brands:['fish','aristo']},endpoints:{campaigns:'https://campaign.example/webhook/campaigns'}}},fetch,readKey:()=>'read-key'});
 return {document,calls,q:s=>document.querySelector(s),qa:s=>[...document.querySelectorAll(s)]};
}
const tick=()=>new Promise(r=>setTimeout(r,0));
test('Mídia: saída do validador (§9.2) etiqueta o legado "Arquivo antigo (sem marca)" e não o conta como da marca; resposta antiga fica igual',async()=>{
 for(const [brand,other] of [['fish','aristo'],['aristo','fish']]){
  const own=`crm-${brand}-${UUID}-${SHA}.png`;
  const raw=mediaPage(brand,[mediaItem(1,own),mediaItem(2,'banner-antigo.png'),mediaItem(3,'promo-'+other+'.png'),mediaItem(4,`crm-${other}-x.png`)]);
  const {body,summary}=MediaRead.validateMediaLibraryResponse(raw,{brand,page:1,per_page:24});
  assert.deepEqual([summary.brand_items,summary.legacy_items,summary.excluded_foreign_prefix],[1,2,1]);
  const x=media(body);x.q('#crm-media-library-load').click();await tick();await tick();
  const buttons=x.qa('[data-media-index]');assert.equal(buttons.length,3);
  assert.equal(buttons[0].querySelector('.crm-media-legacy'),null);
  for(const b of buttons.slice(1)){assert.equal(b.hasAttribute('data-media-legacy'),true);assert.equal(b.querySelector('.crm-media-legacy').textContent,'Arquivo antigo (sem marca)');}
  assert.equal(x.q('#crm-media-library-status').textContent,'1 imagem(ns) da marca e 2 arquivo(s) antigo(s) sem marca carregado(s).');
 }
 // Escape: nome de arquivo com marcação aparece como texto (o validador aceita; o front escapa).
 const tricky=mediaPage('fish',[{...mediaItem(7,'x.png'),filename:'<img src=x onerror=alert(1)>.png',legacy:true}]);
 const t=media(tricky);t.q('#crm-media-library-load').click();await tick();await tick();
 assert.equal(t.q('[data-media-index] span').textContent,'<img src=x onerror=alert(1)>.png');assert.equal(t.q('[data-media-index] span img'),null);
 // Resposta antiga (sem legacy): mesmo HTML e mesma contagem de antes.
 const old=mediaPage('fish',[mediaItem(1,`crm-fish-${UUID}-${SHA}.png`),mediaItem(2,'antigo.png')]),now=media(old);now.q('#crm-media-library-load').click();await tick();await tick();
 assert.equal(now.qa('.crm-media-legacy').length,0);assert.equal(now.q('#crm-media-library-status').textContent,'2 imagem(ns) carregada(s).');
 const {document,window}=parseHTML('<html><body><section id="crm-media"></section></body></html>');
 const fetch=async()=>new Response(JSON.stringify(old),{status:200});const c=vm.createContext({document,window,URL,URLSearchParams,AbortSignal,FormData,crypto:webcrypto,navigator:{locks:{request:async(_n,_o,fn)=>fn({})}},sessionStorage:{getItem:()=>null,setItem(){}},fetch});
 vm.runInContext(baseSource('growth-media.js'),c);vm.runInContext('GMedia',c).mount({marca:'fish',api:{capabilities:{campaigns:{contract_version:'crm-campaign-v1',read:true,brands:['fish','aristo']},endpoints:{campaigns:'https://campaign.example/webhook/campaigns'}}},fetch,readKey:()=>'read-key'});
 document.querySelector('#crm-media-library-load').click();await tick();await tick();
 assert.equal(now.q('#crm-media-library').innerHTML,document.querySelector('#crm-media-library').innerHTML);
 assert.equal(now.calls[0],'https://campaign.example/webhook/campaigns/media?brand=fish&page=1&per_page=24');
 // legacy com tipo errado: resposta recusada inteira.
 const wrong=media(mediaPage('fish',[{...mediaItem(1,'a.png'),legacy:'sim'}]));wrong.q('#crm-media-library-load').click();await tick();await tick();
 assert.equal(wrong.qa('[data-media-index]').length,0);assert.match(wrong.q('#crm-media-library-status').textContent,/não está disponível/);
});

test('base portátil: fixture explícita confere sha256, bytes e blob git do commit declarado; adulterada é recusada',()=>{
 assert.match(MANIFEST.base_commit,/^[0-9a-f]{40}$/);
 for(const meta of Object.values(MANIFEST.files))assert.ok(baseSource(meta.source).length===meta.bytes||Buffer.byteLength(baseSource(meta.source))===meta.bytes);
 const [name,meta]=Object.entries(MANIFEST.files)[0],b=fs.readFileSync(path.join(FIXTURE,name));b[0]^=1;
 assert.notEqual(crypto.createHash('sha256').update(b).digest('hex'),meta.sha256);
});
