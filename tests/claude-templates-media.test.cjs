'use strict';
/* Percurso 3 (CRM) — templates de e-mail e imagens, em fixture sintética.
   O "servidor" é um dublê com estado: valida e renderiza o e-mail com o Code emitido pelo
   patch do envelope (mesmo contrato compartilhado) e responde à consulta de recibo com a
   projeção real de n8n/growth/template-operation-receipt.cjs. Nada sai da máquina. */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {webcrypto,createHash}=require('node:crypto'),{Blob,File}=require('node:buffer'),{parseHTML}=require('linkedom');
const R=require('../n8n/growth/template-operation-receipt.cjs'),P=require('../n8n/growth/email-template-envelope-patch.cjs');
const {createMediaExecutor,canonicalFilename}=require('../services/crm-campaign/media.cjs');
const {createServer,MEDIA_PATH}=require('../services/crm-campaign/server.cjs');
const {AUTH_SQL}=require('../services/crm-campaign/transport.cjs');

const ROOT=path.join(__dirname,'..'),ENDPOINT='https://example.invalid/templates',ACTOR='synthetic-editor',WRITE='synthetic-write-key',READONLY='synthetic-read-only';
const API={capabilities:{templates:{draft:true,validate:true,submit:true,submit_email:true},endpoints:{templates:ENDPOINT}}};
const FILES=['growth-email-expressions.js','whatsapp-template-contract.js','growth-email-contract.js','growth-drafts.js','growth-templates-api.js','growth-template-journal.js','growth-table.js','growth-message-preview.js','growth-brand-state.js','growth-drafts-ui.js'];
const BRAND={fish:{name:'Fishermans',domain:'fishermans.com.br'},aristo:{name:'O Aristocrata',domain:'oaristocrata.com'}};

function serverEmailRules(){
 const source=end=>`// Email drafts become new Listmonk templates. Existing production IDs are immutable here.\nfunction emailErrors(r) {\n  const errors=[];\n  if(!r.corpo)errors.push({codigo:'EMAIL_CONTENT',campo:'corpo',mensagem:'O corpo está vazio.'});\n  return errors;\n}\nfunction emailPayload(r) { return {legacy:true}; }\n\n${end}\n`;
 const fresh={versionId:'synthetic',nodes:[{name:'Prepara',type:'n8n-nodes-base.code',parameters:{jsCode:source('// API de escrita de templates')}},{name:'Decide escrita',type:'n8n-nodes-base.code',parameters:{jsCode:source('// Decide a escrita com o estado')}},{name:'Formata leitura',type:'n8n-nodes-base.code',parameters:{jsCode:P.LEGACY_FIELDS}}]};
 const code=P.patchWorkflow(fresh,{expectedVersionId:'synthetic'}).workflow.nodes[0].parameters.jsCode,c=vm.createContext({});
 vm.runInContext(code+'\nthis.rules={errors:emailErrors,payload:emailPayload};',c);return c.rules;
}
function backend(){
 const rules=serverEmailRules(),drafts=new Map(),receipts=[],posts=[],gets=[];let seq=0;
 const b={rules,drafts,receipts,posts,gets,lose:false,failGets:0,reject:null};
 const json=(status,body)=>({status,json:async()=>JSON.parse(JSON.stringify(body))});
 b.fetch=async(url,options={})=>{
  const u=new URL(url);assert.equal(u.origin+u.pathname,ENDPOINT);
  if(options.method!=='POST'){
   gets.push(url);const q=u.searchParams,key=options.headers?.['X-Template-Key'];
   assert.equal(q.get('acao'),'operacao');assert.equal(q.has('k'),false,'credentials never travel in the URL');
   if(b.failGets>0){b.failGets--;return json(503,{erro:'synthetic_unavailable'});}
   if(key!==WRITE&&key!==READONLY)return json(401,{erro:'invalid_key'});
   if(key===READONLY)return json(403,{erro:'capability_missing',capability:{rascunho:'draft',validar:'validate',submeter:'submit'}[q.get('operacao')]});
   const id=q.get('idempotency_key');
   return json(200,R.operationReceipt({operation_key:id,operation_action:q.get('operacao'),who:ACTOR},{receipts:receipts.filter(x=>x.idempotency_key===id),claims:[]}));
  }
  const {k,...wire}=JSON.parse(options.body);posts.push(wire);
  if(k!==WRITE)return json(401,{erro:'invalid_key'});
  assert.equal(options.headers['Idempotency-Key'],wire.idempotency_key);assert.equal(wire.acao,'rascunho','this fixture only saves drafts');
  const replay=receipts.find(x=>x.idempotency_key===wire.idempotency_key);if(replay)return json(replay.response.status,replay.response.body);
  const r=wire.rascunho,errors=r.canal==='email'?rules.errors(r):[],at='2026-10-02T12:00:00Z';let status,body;
  if(b.reject){status=422;body={erros:[b.reject],who:ACTOR};b.reject=null;}
  else if(errors.length){status=422;body={erros:errors,who:ACTOR};}
  else if(wire.draft_id){
   const d=drafts.get(wire.draft_id);
   if(!d||d.version!==wire.expected_version){status=409;body={erro:'version_conflict',current_version:d?.version??null,changed_by:'outra-chave',changed_at:at,who:ACTOR};}
   else{d.version++;d.rascunho=structuredClone(r);d.payload=rules.payload(r);status=200;body={draft_id:wire.draft_id,version:d.version,estado:'rascunho',salvo_em:at,who:ACTOR};}
  }else{const id='d_synthetic_'+(++seq);drafts.set(id,{version:1,rascunho:structuredClone(r),payload:rules.payload(r)});status=201;body={draft_id:id,version:1,estado:'rascunho',salvo_em:at,who:ACTOR};}
  receipts.push({idempotency_key:wire.idempotency_key,acao:wire.acao,actor:ACTOR,request_payload:{acao:wire.acao,rascunho:wire.rascunho??null,draft_id:wire.draft_id??null,expected_version:wire.expected_version??null,confirm:wire.confirm??null},response:{status,body}});
  if(b.lose){if(b.lose==='with-receipt')b.failGets=1;b.lose=false;throw Error('synthetic lost response');}
  return json(status,body);
 };
 return b;
}
function page({brand,values=new Map(),server=backend(),key=WRITE,extraFiles=[]}){
 const {document,window}=parseHTML('<html><body><section id="control-drafts"></section></body></html>');let focused;
 window.HTMLElement.prototype.focus=function(){focused=this;};window.HTMLElement.prototype.scrollIntoView=function(){};
 Object.defineProperty(document,'activeElement',{get:()=>focused?.isConnected?focused:document.body});
 // linkedom has no select setter; complete the DOM API only.
 Object.defineProperty(Object.getPrototypeOf(document.createElement('select')),'value',{configurable:true,get(){return [...this.options].find(o=>o.hasAttribute('selected'))?.value||this.options[0]?.value||'';},set(v){for(const o of this.options)o.toggleAttribute('selected',o.value===String(v));}});
 const held=new Set(),pending=[];
 const ctx=vm.createContext({document,window,localStorage:{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k)},crypto:webcrypto,TextEncoder,TextDecoder,URL,URLSearchParams,Date,Intl,console,setInterval:()=>1,
  navigator:{locks:{request:async(k,_o,fn)=>{if(held.has(k))return fn(null);held.add(k);try{return await fn({name:k});}finally{held.delete(k);}}}},
  shrigmaChaveOperador:()=>key,confirm:()=>{throw Error('native confirm forbidden');},fetch:server.fetch,__track:p=>pending.push(p)});
 for(const f of [...FILES.slice(0,-1),...extraFiles,FILES.at(-1)])vm.runInContext(fs.readFileSync(path.join(ROOT,f),'utf8'),ctx,{filename:f});
 vm.runInContext("for(const n of ['salvarServidor','consultarOperacao']){const o=GRU[n];GRU[n]=function(...a){const p=o.apply(this,a);__track(p);return p;};}globalThis.ui=GRU;globalThis.gr=GR;globalThis.gta=GTA;globalThis.gec=GEC;if(typeof GENU!=='undefined')globalThis.genu=GENU;",ctx);
 ctx.ui.render({marca:brand,api:API});
 const $=s=>document.querySelector(s),settle=async()=>{while(pending.length)await pending.shift();};
 const type=(sel,value)=>{const el=$(sel);assert.ok(el,'campo '+sel);el.value=value;(el.oninput||el.onchange)();};
 const click=async sel=>{const el=$(sel);assert.ok(el,'botão '+sel);el.click();await settle();};
 // Same calls as trocaMarca() in growth.html: refuse while blocked, preserve, then render the next brand.
 const switchBrand=next=>{if(ctx.ui.contextStatus().blocked)return false;try{ctx.ui.preserve();}catch{return false;}ctx.ui.render({marca:next,api:API});return true;};
 return {ui:ctx.ui,gr:ctx.gr,gta:ctx.gta,gec:ctx.gec,genu:ctx.genu,ctx,document,values,server,$,type,click,settle,switchBrand};
}
const sample=brand=>{const b=BRAND[brand];return {nome:'qa-template-'+brand,from_email:`${b.name} QA <qa@${b.domain}>`,reply_to:`atendimento@${b.domain}`,assunto:`Assunto sintético ${brand} {{ .Tx.Data.first_name }}`,preheader:`Pré-header sintético ${brand} & "aspas"`,peca:`qa-${brand}-etapa`,
 corpo:`<p>Olá {{ .Tx.Data.first_name }}, conteúdo sintético.</p><p><img src="https://email.shrigma.com.br/uploads/crm-${brand}-sintetico.png" alt="Imagem sintética" width="600"></p>`,botao:{texto:'Ver produto',valor:`https://${b.domain}/products/sintetico?utm_source=crm&utm_medium=email`}};};
const expected=(brand,f)=>({canal:'email',marca:brand,idioma:'pt_BR',categoria:'UTILITY',nome:f.nome,peca:f.peca,cabecalho:'',corpo:f.corpo,rodape:'',assunto:f.assunto,from_email:f.from_email,reply_to:f.reply_to,preheader:f.preheader,exemplos:{},botoes:[{tipo:'url',texto:f.botao.texto,valor:f.botao.valor}]});
async function fillNewEmail(s,f){
 await s.click('#drafts-novo-email');
 for(const [sel,value] of [['#d-nome',f.nome],['#d-from-email',f.from_email],['#d-reply-to',f.reply_to],['#d-assunto',f.assunto],['#d-preheader',f.preheader],['#d-peca',f.peca],['#d-corpo',f.corpo]])s.type(sel,value);
 await s.click('#d-botao-add');s.type('[data-botao-campo="texto"]',f.botao.texto);s.type('[data-botao-campo="valor"]',f.botao.valor);
}
// linkedom keeps textarea RCDATA entity-encoded; a browser decodes it. Decode only what GRU.e encodes.
const rcdata=v=>v.replace(/&(lt|gt|quot|#39|amp);/g,(_,n)=>({lt:'<',gt:'>',quot:'"','#39':"'",amp:'&'}[n]));
function editorValues(s){return {nome:s.$('#d-nome').value,from_email:s.$('#d-from-email').value,reply_to:s.$('#d-reply-to').value,assunto:s.$('#d-assunto').value,preheader:s.$('#d-preheader').value,peca:s.$('#d-peca').value,corpo:rcdata(s.$('#d-corpo').value),botao:{texto:s.$('[data-botao-campo="texto"]').value,valor:s.$('[data-botao-campo="valor"]').value}};}
const plain=v=>JSON.parse(JSON.stringify(v));

/* ---------------- aceite: salvar → reabrir → editar → salvar, nas duas marcas ---------------- */
for(const brand of ['fish','aristo'])test(`${brand}: e-mail de teste criado, salvo no CRM, reaberto após recarregar e salvo de novo mantém todos os campos`,async()=>{
 const server=backend(),values=new Map(),f=sample(brand),first=page({brand,values,server});
 await fillNewEmail(first,f);assert.deepEqual(first.ui.state.rascunho.botoes.length,1);assert.equal(first.gr.valida(first.ui.state.rascunho).erros.length,0);
 await first.click('#d-servidor');
 assert.equal(server.posts.length,1,'uma única escrita');assert.equal(server.gets.length,2,'consulta prévia e recibo exato');
 const draftId=[...server.drafts.keys()][0],stored=server.drafts.get(draftId);
 assert.deepEqual(plain(stored.rascunho),expected(brand,f),'o servidor recebe todos os campos do contrato');
 assert.equal(stored.payload.subject,f.assunto);assert.equal(stored.payload.name,'CRM '+brand+' · '+f.nome);assert.equal(stored.payload.body,first.gec.html(stored.rascunho),'o servidor renderiza o mesmo HTML do painel');
 assert.equal((stored.payload.body.match(/data-crm-preheader/g)||[]).length,1);assert.ok(stored.payload.body.includes('Pré-header sintético '+brand+' &amp; &quot;aspas&quot;'));
 assert.match(first.$('#d-save-status').textContent,/Salvo no CRM · versão 1/);assert.equal(first.ui.contextStatus().dirty,false);assert.equal(first.ui.journal().inspect().blocked,false);
 await first.click('#d-cancelar');assert.equal(first.ui.state.rascunho,null);

 // Recarregar: nova página, mesmo navegador e mesmo servidor.
 const second=page({brand,values,server});assert.equal(second.document.querySelectorAll('[data-draft-edit]').length,1);
 await second.click('[data-draft-edit]');assert.deepEqual(editorValues(second),f,'reabrir mostra cada campo como foi salvo');
 assert.deepEqual(plain(second.gr.conteudo(second.ui.state.rascunho)),expected(brand,f));
 assert.deepEqual(plain(second.gta.situacao(second.ui.state.rascunho)).estado,'rascunho');assert.equal(second.gta.situacao(second.ui.state.rascunho).sujo,false);
 assert.match(second.$('#d-save-status').textContent,/Salvo no CRM · versão 1/);

 // Editar e salvar a revisão seguinte.
 const v2={...f,assunto:`Novo assunto ${brand}`,preheader:`Novo pré-header ${brand}`};second.type('#d-assunto',v2.assunto);second.type('#d-preheader',v2.preheader);
 assert.match(second.$('#d-save-status').textContent,/Alterações ainda não salvas no CRM/);
 await second.click('#d-servidor');assert.equal(server.posts.length,2);assert.equal(server.posts[1].draft_id,draftId);assert.equal(server.posts[1].expected_version,1);
 assert.equal(stored.version,2);assert.deepEqual(plain(stored.rascunho),expected(brand,v2));assert.match(second.$('#d-save-status').textContent,/Salvo no CRM · versão 2/);

 // Resposta perdida e recibo indisponível: fica incerto, nada é repetido, e a mesma tentativa é conciliada.
 const v3={...v2,corpo:v2.corpo+'<p>Terceira revisão.</p>'};second.type('#d-corpo',v3.corpo);server.lose='with-receipt';
 await second.click('#d-servidor');assert.equal(server.posts.length,3);assert.equal(stored.version,3,'o servidor aplicou');
 assert.match(second.document.body.textContent,/Operação sem confirmação/);assert.equal(second.ui.journal().inspect().operations.at(-1).phase,'unknown');
 await second.click('#d-servidor');assert.equal(server.posts.length,3,'resultado incerto nunca repete o POST');
 const uncertain=second.ui.journal().inspect().operations.at(-1).id;await second.click(`[data-template-operacao="${uncertain}"]`);
 assert.equal(server.posts.length,3);assert.equal(second.ui.journal().inspect().operations.at(-1).phase,'confirmed');assert.equal(second.ui.state.rascunho.servidor.version,3);assert.equal(second.ui.journal().inspect().blocked,false);
 await second.click('[data-template-operacao="'+uncertain+'"]');assert.equal(server.posts.length,3,'abrir o recibo de novo não reenvia');

 // Recusa do servidor aparece com a frase dele e não trava a próxima tentativa.
 server.reject={codigo:'NAME_TAKEN',campo:'nome',mensagem:'Já existe um template com este nome nesta marca. Escolha outro nome.'};second.type('#d-nome',f.nome+'-b');
 await second.click('#d-servidor');assert.equal(server.posts.length,4);assert.equal(second.ui.state.msg,'Já existe um template com este nome nesta marca. Escolha outro nome.');
 assert.equal(second.ui.journal().inspect().operations.at(-1).phase,'rejected');assert.equal(second.ui.journal().inspect().blocked,false);assert.equal(stored.version,3);
 await second.click('#d-servidor');assert.equal(server.posts.length,5);assert.equal(stored.version,4);
 await second.click('#d-cancelar');

 const third=page({brand,values,server});await third.click('[data-draft-edit]');
 assert.deepEqual(editorValues(third),{...v3,nome:f.nome+'-b'});assert.equal(third.ui.state.rascunho.servidor.version,4);assert.deepEqual(plain(stored.rascunho),expected(brand,{...v3,nome:f.nome+'-b'}));
});

test('cada marca lista só os seus templates; a outra marca continua intacta',async()=>{
 const server=backend(),values=new Map();
 for(const brand of ['fish','aristo']){const s=page({brand,values,server});await fillNewEmail(s,sample(brand));await s.click('#d-servidor');await s.click('#d-cancelar');}
 for(const brand of ['fish','aristo']){
  const s=page({brand,values,server}),cards=[...s.document.querySelectorAll('[data-draft]')];
  assert.equal(cards.length,1);assert.match(cards[0].textContent,new RegExp('qa-template-'+brand));assert.doesNotMatch(cards[0].textContent,new RegExp('qa-template-'+(brand==='fish'?'aristo':'fish')));
 }
 assert.equal(server.posts.length,2);
});

test('HTML inválido ou inseguro é recusado antes do envio, com o que corrigir, e o servidor aplica as mesmas regras',async()=>{
 for(const brand of ['fish','aristo']){
  const s=page({brand}),f=sample(brand);await fillNewEmail(s,f);
  for(const [patch,message] of [
   [{corpo:'<p onclick="alert(1)">Oi</p>'},'Remova scripts, formulários e conteúdo interativo do e-mail.'],
   [{corpo:'<p><a href="javascript:alert(1)">Oi</a></p>'},'Remova scripts, formulários e conteúdo interativo do e-mail.'],
   [{corpo:'<p class="sem-fechar>Oi</p>'},'Confira o HTML: há uma tag, aspas ou comentário sem fechamento válido.'],
   [{corpo:'<html><head><meta http-equiv="refresh" content="0;url=https://example.invalid"></head><body><p>Oi</p></body></html>'},'Use apenas metadados UTF-8, viewport padrão e esquemas de cores permitidos. Redirecionamentos e outras instruções meta não são permitidos.'],
   [{corpo:'<link rel="stylesheet" href="https://example.invalid/x.css"><p>Oi</p>'},'Use apenas a folha de fontes Google Fonts permitida. Outros recursos externos via link não são aceitos.'],
   [{from_email:'QA <qa@example.invalid>'},'Informe um remetente com o domínio de '+BRAND[brand].name+'.'],
   [{reply_to:'qa@'+BRAND[brand==='fish'?'aristo':'fish'].domain},'Informe um e-mail de resposta com o domínio de '+BRAND[brand].name+'.'],
   [{preheader:''},'Escreva um pré-header de 1 a 200 caracteres, em uma linha.'],
  ]){
   const [field,value]=Object.entries(patch)[0],selector={corpo:'#d-corpo',from_email:'#d-from-email',reply_to:'#d-reply-to',preheader:'#d-preheader'}[field];
   s.type(selector,value);await s.click('#d-servidor');
   assert.equal(s.server.posts.length,0,'nada é enviado');assert.equal(s.ui.state.msg,'Corrija as pendências do conteúdo antes de salvar no CRM.');
   assert.ok([...s.document.querySelectorAll('#d-checagens .draft-erro')].some(n=>n.textContent===message),message);
   assert.ok(s.server.rules.errors({...expected(brand,f),...patch}).some(e=>e.mensagem===message),'servidor: '+message);
   s.type(selector,f[field]);
  }
  assert.equal(s.gr.valida(s.ui.state.rascunho).erros.length,0);assert.equal(s.ui.journal().inspect().operations.length,0);
 }
});

/* ---------------- defeitos: recibo aberto de outra edição ou de outra marca ---------------- */
test('abrir o recibo de outro template não descarta a edição aberta e ainda não salva',async()=>{
 const s=page({brand:'fish'});await fillNewEmail(s,sample('fish'));await s.click('#d-servidor');await s.click('#d-cancelar');
 const op=s.ui.journal().inspect().operations[0].id;
 await s.click('#drafts-novo-email');s.type('#d-nome','rascunho-b-nao-salvo');s.type('#d-corpo','<p>Texto ainda não salvo.</p>');assert.equal(s.ui.contextStatus().dirty,true);
 await s.click(`[data-template-operacao="${op}"]`);
 assert.equal(s.ui.state.rascunho?.nome,'rascunho-b-nao-salvo','a edição aberta continua no editor');assert.equal(s.ui.state.rascunho.corpo,'<p>Texto ainda não salvo.</p>');
 assert.equal(s.server.posts.length,1);assert.equal(s.ui.journal().inspect().operations[0].applied,true);
 assert.match(s.ui.state.msg,/A edição aberta foi preservada/);assert.equal(s.gr.lista().find(d=>d.nome==='qa-template-fish').servidor.version,1);
});

test('abrir na Fishermans o recibo de um template d\'O Aristocrata não mistura as marcas nem trava a troca de marca',async()=>{
 const s=page({brand:'aristo'});await fillNewEmail(s,sample('aristo'));await s.click('#d-servidor');await s.click('#d-cancelar');
 const op=s.ui.journal().inspect().operations[0].id;
 assert.equal(s.switchBrand('fish'),true);await s.click(`[data-template-operacao="${op}"]`);
 assert.notEqual(s.ui.state.rascunho?.marca,'aristo','o editor da Fishermans não abre um template d\'O Aristocrata');assert.match(s.ui.state.msg,/O template é de O Aristocrata; selecione essa marca no cabeçalho/);
 assert.equal(s.switchBrand('aristo'),true);assert.equal(s.switchBrand('fish'),true);
 assert.equal(s.ui.contextError,'','a preparação da Fishermans não guarda template de outra marca');
 assert.equal(s.switchBrand('aristo'),true,'a troca de marca continua disponível');
 assert.equal(page({brand:'fish',values:s.values,server:s.server}).ui.contextError,'','recarregar a Fishermans não fica preso');
 assert.equal(s.gr.lista().find(d=>d.marca==='aristo').servidor.version,1);assert.equal(s.server.posts.length,1);
});

/* ---------------- defeito: permissão recusada na consulta prévia ---------------- */
test('chave sem a capacidade de salvar recebe a recusa de permissão, sem envio nem reserva',async()=>{
 for(const brand of ['fish','aristo']){
  const s=page({brand,key:READONLY});await fillNewEmail(s,sample(brand));await s.click('#d-servidor');
  assert.equal(s.server.posts.length,0);assert.equal(s.ui.journal().inspect().operations.length,0);
  assert.match(s.ui.state.msg,/não tem a capacidade "draft"/);assert.match(s.ui.state.msg,/Nada foi enviado/);
 }
});

/* ---------------- defeito: rodapé herdado invisível no editor de e-mail ---------------- */
test('rodapé herdado do WhatsApp fica visível no e-mail para que a pendência possa ser corrigida',async()=>{
 const s=page({brand:'fish'});await s.click('#drafts-novo');s.type('#d-nome','qa_whatsapp');s.type('#d-rodape','Rodapé do WhatsApp');
 s.type('#d-canal','email');assert.equal(s.ui.state.rascunho.canal,'email');assert.equal(s.ui.state.rascunho.rodape,'Rodapé do WhatsApp');
 s.type('#d-preheader','Resumo');s.type('#d-assunto','Assunto');s.type('#d-corpo','<!doctype html><html><body><p>Oi</p></body></html>');
 assert.ok(s.gr.valida(s.ui.state.rascunho).erros.includes('O HTML completo deve incluir seus próprios botões e rodapé. Remova os campos extras ou use um fragmento.'));
 assert.ok(s.$('#d-rodape'),'o campo que a mensagem manda remover está no editor');assert.equal(s.$('#d-rodape').value,'Rodapé do WhatsApp');
 s.type('#d-rodape','');assert.equal(s.gr.valida(s.ui.state.rascunho).erros.length,0);
});

/* ---------------- defeito: cópia de e-mail publicado duplica o pré-header ---------------- */
test('copiar um e-mail publicado pelo painel mantém um único pré-header, com o texto publicado',()=>{
 for(const brand of ['fish','aristo']){
  const s=page({brand,extraFiles:['growth-email-native-ui.js']}),f=sample(brand),published=s.gec.payload(expected(brand,f));
  const copy=s.genu.derive({name:'Publicado',subject:published.subject,body:published.body},brand);
  assert.equal(copy.preheader,f.preheader,'o pré-header publicado vira o campo da cópia');
  const html=s.gec.html(copy);assert.equal((html.match(/data-crm-preheader/g)||[]).length,1,'um só pré-header');assert.equal(html,published.body,'a cópia renderiza o mesmo e-mail publicado');
  assert.equal(s.gr.valida(copy).erros.length,0);
  const legacy=s.genu.derive({name:'Legado',subject:'Assunto legado',body:'<p>Sem pré-header.</p>'},brand);assert.equal(legacy.corpo,'<p>Sem pré-header.</p>');assert.equal(legacy.preheader,'Assunto legado');
 }
});

/* ---------------- imagens ---------------- */
const operation='11111111-1111-4111-8111-111111111111';
function png(width=2,height=3){const signature=Buffer.from([137,80,78,71,13,10,26,10]),ihdr=Buffer.alloc(25),iend=Buffer.alloc(12);ihdr.writeUInt32BE(13,0);ihdr.write('IHDR',4);ihdr.writeUInt32BE(width,8);ihdr.writeUInt32BE(height,12);ihdr[16]=8;ihdr[17]=2;iend.writeUInt32BE(0,0);iend.write('IEND',4);return Buffer.concat([signature,ihdr,iend]);}
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const item=(filename,id)=>({id,filename,content_type:'image/png',url:'https://email.shrigma.com.br/uploads/'+filename,thumb_url:null,meta:{width:2,height:3},created_at:'2026-09-30T10:00:00Z'});
const nativePage=results=>({status:200,body:{data:{results,total:results.length,page:1,per_page:50}}});
function authPool(caps){let calls=0;return {get calls(){return calls;},async query(sql){calls++;assert.equal(sql,AUTH_SQL);return {rows:[{auth:{actor:'synthetic-media',caps}}]};}};}

test('biblioteca de uma marca não lista arquivos gerados para a outra marca',async()=>{
 const fish=canonicalFilename('fish',operation,'a'.repeat(64),'png'),aristo=canonicalFilename('aristo',operation,'b'.repeat(64),'png');
 const native={origin:'https://email.shrigma.com.br',list:async()=>nativePage([item(fish,1),item(aristo,2),item('legado-sem-marca.png',3)]),upload:async()=>assert.fail('read only')};
 const execute=createMediaExecutor({pool:authPool(['read_content']),native});
 for(const [brand,own,other] of [['fish',fish,aristo],['aristo',aristo,fish]]){
  const r=await execute({key:'read',method:'GET',input:{brand,page:1,per_page:24}}),names=r.body.items.map(x=>x.filename);
  assert.equal(r.status,200);assert.equal(r.body.brand,brand);assert.ok(names.includes(own));assert.ok(names.includes('legado-sem-marca.png'),'arquivo sem marca continua disponível');
  assert.equal(names.includes(other),false,'arquivo da outra marca não aparece');
 }
});

test('leitura não sobe arquivo e a consulta da biblioteca exige autenticação',async t=>{
 const bytes=png();let uploads=0,lists=0;const native={origin:'https://email.shrigma.com.br',list:async()=>{lists++;return nativePage([]);},upload:async()=>{uploads++;}};
 const reader=createMediaExecutor({pool:authPool(['read_content']),native});
 const denied=await reader({key:'read',method:'POST',input:{brand:'fish',operation_id:operation,sha256:sha(bytes),content_type:'image/png',bytes}});
 assert.equal(denied.status,403);assert.equal(denied.body.posted,false);assert.equal(denied.body.message,'Esta chave não tem permissão para esta ação.');assert.equal(uploads,0);assert.equal(lists,0);
 const noRead=await createMediaExecutor({pool:authPool(['edit_content']),native})({key:'edit',method:'GET',input:{brand:'fish',page:1,per_page:24}});assert.equal(noRead.status,403);assert.equal(lists,0);
 const app=createServer({revision:'a'.repeat(40),enabled:true,mediaEnabled:true,executor:async()=>({status:200,body:{}}),mediaExecutor:async()=>assert.fail('unauthenticated request reached the executor')});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(()=>app.stop());
 const response=await fetch(`http://127.0.0.1:${app.server.address().port}${MEDIA_PATH}?brand=fish&page=1&per_page=24`);assert.equal(response.status,401);assert.equal((await response.json()).error,'UNAUTHORIZED');
});

function memory(){const values=new Map;return {getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,String(v)),values};}
const mediaApi={capabilities:{campaigns:{contract_version:'crm-campaign-v1',read:true,brands:['fish','aristo']},endpoints:{campaigns:'https://campaign.example/webhook/campaigns'}}};
function mediaBoot(fetchImpl){
 const {document,window}=parseHTML('<html><body><section id="crm-media"></section></body></html>'),store=memory(),calls=[],locks={request:async(_n,_o,fn)=>fn({})};
 const context=vm.createContext({document,window,URL,URLSearchParams,Blob,File,FormData,TextEncoder,crypto:globalThis.crypto,confirm:()=>true,navigator:{locks,clipboard:{writeText:async()=>{}}},sessionStorage:store,fetch:async(url,init)=>{calls.push({url,init});return fetchImpl(url,init);}});
 vm.runInContext(fs.readFileSync(path.join(ROOT,'growth-media.js'),'utf8'),context);const api=vm.runInContext('GMedia',context);
 api.mount({marca:'fish',api:mediaApi,storage:store,locks,fetch:context.fetch,readKey:()=>'read-key',writeKey:()=>'edit-key',uuid:()=>operation,createObjectURL:()=>'blob:preview'});
 return {document,window,api,calls,store,q:s=>document.querySelector(s)};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const listed=(brand,names)=>new Response(JSON.stringify({contract:'crm-media-v1',brand,items:names.map((filename,i)=>({id:i+1,filename,url:'https://email.shrigma.com.br/uploads/'+filename,thumb_url:null,content_type:'image/png',width:2,height:3,created_at:null})),total:names.length,page:1,per_page:24,next_page:null}),{status:200});

test('recusa de permissão ou de origem na biblioteca aparece como tal, sem virar "indisponível"',async()=>{
 for(const [body,pattern] of [[{error:'CAPABILITY_MISSING',message:'Esta chave não tem permissão para esta ação.',posted:false},/permissão/],[{error:'ORIGIN_DENIED',message:'Origem não permitida.'},/origem/i]]){
  const x=mediaBoot(async()=>new Response(JSON.stringify(body),{status:403}));x.q('#crm-media-library-load').click();await tick();
  const status=x.q('#crm-media-library-status').textContent;assert.match(status,pattern);assert.doesNotMatch(status,/não está disponível agora/);assert.equal(x.q('#crm-media-upload-fields').hidden,true);
 }
 const off=mediaBoot(async()=>new Response(JSON.stringify({error:'MEDIA_DISABLED',message:'A biblioteca de imagens ainda não está disponível.',posted:false}),{status:503}));off.q('#crm-media-library-load').click();await tick();
 assert.match(off.q('#crm-media-library-status').textContent,/não está disponível/);
});

test('troca de marca não leva a biblioteca carregada nem o arquivo escolhido para a outra marca; tipo e tamanho são recusados antes do envio',async()=>{
 const x=mediaBoot(async url=>listed(new URL(url).searchParams.get('brand'),['crm-'+new URL(url).searchParams.get('brand')+'-'+operation+'-'+'c'.repeat(64)+'.png']));
 x.q('#crm-media-library-load').click();await tick();assert.equal(x.document.querySelectorAll('[data-media-index]').length,1);assert.match(x.q('#crm-media-library').textContent,/crm-fish-/);
 x.api.mount({marca:'aristo'});assert.equal(x.document.querySelectorAll('[data-media-index]').length,0,'a biblioteca da Fishermans não aparece n\'O Aristocrata');assert.doesNotMatch(x.q('#crm-media-library').textContent,/crm-fish-/);
 x.q('#crm-media-library-load').click();await tick();assert.match(x.q('#crm-media-library').textContent,/crm-aristo-/);assert.doesNotMatch(x.q('#crm-media-library').textContent,/crm-fish-/);
 for(const file of [new File(['<svg></svg>'],'x.svg',{type:'image/svg+xml'}),new File([new Uint8Array(2*1024*1024+1)],'grande.png',{type:'image/png'})]){
  Object.defineProperty(x.q('#crm-media-file'),'files',{configurable:true,value:[file]});x.q('#crm-media-file').dispatchEvent(new x.window.Event('change'));await tick();
  assert.equal(x.q('#crm-media-library-status').textContent,'Escolha PNG, JPEG ou GIF com até 2 MB.');assert.equal(x.q('#crm-media-upload').disabled,true);
 }
 assert.equal(x.calls.filter(c=>c.init.method==='POST').length,0);assert.ok(x.calls.every(c=>c.init.headers.Authorization==='Bearer read-key'));
});

test('biblioteca não abre vazia quando a página nativa só tem arquivos da outra marca',async()=>{
 // 24 arquivos recentes d'O Aristocrata ocupam a página 1 do Listmonk; os da Fishermans estão na página 2.
 const per=24,aristo=Array.from({length:per},(_,i)=>item(canonicalFilename('aristo',operation,String(i).padStart(64,'b'),'png'),100+i));
 const fish=[1,2,3].map(i=>item(canonicalFilename('fish',operation,String(i).padStart(64,'a'),'png'),i)),all=[...aristo,...fish],pages=[];
 const native={origin:'https://email.shrigma.com.br',list:async({page,perPage})=>{pages.push(page);return {status:200,body:{data:{results:all.slice((page-1)*perPage,page*perPage),total:all.length,page,per_page:perPage}}};},upload:async()=>assert.fail('read only')};
 const execute=createMediaExecutor({pool:authPool(['read_content']),native});
 const r=await execute({key:'read',method:'GET',input:{brand:'fish',page:1,per_page:per}});
 assert.equal(r.status,200);assert.deepEqual(r.body.items.map(x=>x.id),[1,2,3],'a primeira consulta já traz as imagens da marca');
 assert.equal(r.body.page,2);assert.equal(r.body.next_page,null);assert.deepEqual(pages,[1,2]);
 // Sem nenhum arquivo da marca, a varredura é limitada e devolve a próxima página para continuar.
 pages.length=0;const many=Array.from({length:per*6},(_,i)=>item(canonicalFilename('aristo',operation,String(i).padStart(64,'c'),'png'),500+i));
 native.list=async({page,perPage})=>{pages.push(page);return {status:200,body:{data:{results:many.slice((page-1)*perPage,page*perPage),total:many.length,page,per_page:perPage}}};};
 const empty=await execute({key:'read',method:'GET',input:{brand:'fish',page:1,per_page:per}});
 assert.equal(empty.status,200);assert.deepEqual(empty.body.items,[]);assert.equal(pages.length,4);assert.equal(empty.body.page,4);assert.equal(empty.body.next_page,5);
});
