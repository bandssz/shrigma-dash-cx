'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const {parseHTML}=require('linkedom');
const files=['whatsapp-template-contract.js','growth-email-expressions.js','growth-email-contract.js','growth-drafts.js','growth-templates-api.js','growth-template-journal.js','growth-table.js','growth-message-preview.js','growth-brand-state.js','growth-email-test.js','growth-email-replication.js','growth-email-replication-ui.js','growth-email-native-ui.js','growth-drafts-ui.js'];
function setup({brand='fish',capsPatch={},previewPatch={},wait=null,key='synthetic-manager'}={}){
 const {document,window}=parseHTML('<html><body><section id="control-drafts"></section></body></html>'),values=new Map(),calls=[];
 const storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)},locks={request:async(_k,_o,fn)=>fn({})};
 const native={id:101,name:'Native fixture',brand,channel:'email',draft_id:'NEVER_COPY',status:'APPROVED',components:{subject:'Assunto original',body_html:'<p>{{ default "Cliente" .Tx.Data.first_name }}</p><a href="{{ default "https://'+(brand==='fish'?'fishermans.com.br':'oaristocrata.com')+'/products/original?utm_term=lm-123" .Tx.Data.order_url }}">Pedido</a>{{ range .Tx.Data.items }}<p>{{ .name }}</p>{{ end }}'}};
 const context=vm.createContext({document,window,localStorage:storage,URL,URLSearchParams,Date,Intl,TextEncoder,TextDecoder,AbortController,setTimeout,clearTimeout,setInterval:()=>1,crypto:require('node:crypto').webcrypto,navigator:{locks},console,shrigmaChaveOperador:()=>key,fetch:async(url,init)=>{
  const q=new URL(url).searchParams,body=init.body?JSON.parse(init.body):null,action=body?.acao||q.get('acao');calls.push({url,init,body,action});let out;
  if(action==='email_capacidades')out={contract:'crm_email_native_preview_v1',policy_version:1,brands:['fish','aristo'],native_email_preview:true,native_email_derive:true,native_email_test:true,...capsPatch};
  else if(action==='listar'){assert.equal(q.get('canal'),'email');assert.equal(q.get('marca'),brand);out={templates:[native,{...native,id:102,brand:brand==='fish'?'aristo':'fish'}]};}
  else if(action==='email_previa'){if(wait)await wait;assert.deepEqual(Object.keys(body).sort(),['acao','rascunho']);out={contract:'crm_email_native_preview_v1',eligible:true,brand:body.rascunho.marca,subject:'Assunto renderizado',body_html:'<p>Cliente de exemplo</p><img src="https://example.invalid/image.png">',data:{items:[{name:'Produto fictício'}]},subscriber_context:'external',source_hash:'a'.repeat(64),...previewPatch};}
  else if(action==='rascunho')out={ok:false};else throw Error('Unexpected route '+action);
  return {status:200,text:async()=>JSON.stringify(out),json:async()=>out};
 }});
 for(const name of files)vm.runInContext(fs.readFileSync(path.join(__dirname,'..',name),'utf8'),context,{filename:name});
 vm.runInContext(`globalThis.x={GRU,GENU,GERU,GR,GEC,GTA};GRU.render({marca:'${brand}',api:{capabilities:{templates:{draft:true,validate:true,submit:true,submit_email:true},endpoints:{templates:'https://example.invalid/templates'}}}});`,context);
 return {...context.x,document,window,values,calls,native,context,$:s=>document.querySelector(s)};
}
for(const brand of ['fish','aristo'])test(brand+' native gallery → confirmed new draft → native preview → reviewed other-brand copy, without publication',async()=>{
 const s=setup({brand}),original=JSON.stringify(s.native);await s.GENU.open();assert.equal(s.GENU.session.templates.length,1);assert.equal(s.GRU.enterBrand(brand==='fish'?'aristo':'fish'),false);
 await s.GENU.select(101);assert.equal(s.GENU.session.draft.preheader,'Assunto original');assert.equal(s.GR.valida(s.GENU.session.draft).erros.length,0);assert.equal(s.GENU.session.preview,null);await s.GENU.review();assert.ok(s.GENU.session.preview);assert.equal(s.$('#native-create').disabled,true);assert.doesNotMatch(s.document.body.textContent,/\[object Object\]/);
 s.GENU.create();assert.equal(s.GR.lista().length,0);s.GENU.session.confirmed=true;s.GENU.create();s.GENU.create();assert.equal(s.GR.lista().length,1);const saved=s.GR.lista()[0];assert.notEqual(saved.id,'101');for(const k of ['draft_id','provider_id','servidor','status','operation_id','preview_token'])assert.equal(saved[k],undefined);assert.equal(saved.corpo,s.native.components.body_html);assert.equal(JSON.stringify(s.native),original);
 await s.GENU.previewEditor();assert.ok(s.$('#d-preview iframe'));assert.equal(s.$('#d-preview iframe').getAttribute('sandbox'),'');assert.doesNotMatch(s.$('#d-preview iframe').getAttribute('srcdoc'),/src="https:\/\/example/);
 s.GERU.open(saved.id);assert.ok(s.GERU.session);const session=s.GERU.session,to=brand==='fish'?'aristo':'fish',domain=s.GEC.BRANDS[to].domain;session.links.forEach((v,i)=>{v.reviewed=true;v.target='https://'+domain+'/products/reviewed';});await s.GERU.review();assert.ok(session.review);assert.ok(session.nativePreview);session.confirmed=true;s.GERU.create();assert.equal(s.GR.lista().length,2);const copied=s.GR.lista().find(r=>r.marca===to);assert.ok(copied);assert.equal(copied.servidor,undefined);assert.ok(copied.corpo.includes('{{ default "https://'+domain+'/products/reviewed" .Tx.Data.order_url }}'));assert.ok(copied.corpo.includes('{{ range .Tx.Data.items }}'));assert.equal(copied.corpo.includes('lm-123'),false);
 assert.ok(s.calls.every(c=>c.init.headers.Authorization==='Bearer synthetic-manager'));assert.ok(s.calls.filter(c=>c.init.method==='POST').every(c=>c.action==='email_previa'));assert.doesNotMatch([...s.values.values()].join(''),/synthetic-manager|NEVER_COPY/);
});
test('strict capability and journals block derivation; wrong-brand and stale preview cannot unlock a local copy',async()=>{
 const off=setup({capsPatch:{native_email_derive:false}});await off.GENU.open();assert.equal(off.calls.length,1);assert.equal(off.GR.lista().length,0);assert.match(off.GENU.session.error,/indisponíveis|disponíveis/);
 const missing=setup({key:''});await missing.GENU.open();assert.equal(missing.calls.length,0);
 const blocked=setup();blocked.values.set('shrigma_crm_template_operations_v1','{broken');blocked.GRU.journal=()=>({inspect:()=>({blocked:true,operations:[]})});await blocked.GENU.open();assert.equal(blocked.calls.length,0);
 const wrong=setup({previewPatch:{brand:'aristo'}});await wrong.GENU.open();await wrong.GENU.select(101);await wrong.GENU.review();assert.equal(wrong.GENU.session.preview,null);wrong.GENU.session.confirmed=true;wrong.GENU.create();assert.equal(wrong.GR.lista().length,0);
 let release;const gate=new Promise(r=>release=r),stale=setup({wait:gate});await stale.GENU.open();await stale.GENU.select(101);const p=stale.GENU.review();stale.GENU.session.draft.preheader='Mudou durante consulta';release();await p;assert.equal(stale.GENU.session.preview,null);assert.match(stale.GENU.session.error,/mudou/);
});
test('preheader must be reviewed and simple transactional fields take the native route without widening legacy fields',async()=>{
 const s=setup(),r=s.GENU.derive({name:'Template',subject:'Olá {{ .Tx.Data.first_name }}',body:'<p>{{ .Tx.Data.first_name }}</p>'},'fish');assert.equal(r.preheader,'');assert.ok(s.GR.valida(r).erros.some(e=>/pré-header/.test(e)));
 for(const [body,subject,expected] of [['<p>{{ .Tx.Data.first_name }}</p>','Assunto',false],['<p>{{ .Tx.Data.order_number }}</p>','Assunto',true],['<p>Texto</p>','Pedido {{ .Tx.Data.order_number }}',true],['<a href="{{ .Tx.Data.store_url }}">Loja</a>','Assunto',true],['{{ if .Tx.Data.first_name }}Olá{{ end }}','Assunto',true]])assert.equal(s.GENU.advanced({...r,corpo:body,assunto:subject,preheader:'Resumo'}),expected);
});
test('advanced writes use the captured manager Bearer; legacy writer stays compatible',async()=>{
 const s=setup(),content=s.GENU.derive({name:'Template',subject:'Assunto',body:'<p>{{ .Tx.Data.order_number }}</p>'},'fish');s.GRU.abrir(content,null);let headers;
 s.GRU.clienteSeguro=(key,r)=>{assert.equal(key,'synthetic-manager');return s.GRU.cliente(key,s.GENU.advanced(r));};
 await s.GRU.chamada('rascunho',s.GRU.state.rascunho,c=>c.rascunho(s.GR.conteudo(content),{idempotency_key:'fixture'}));
 const post=s.calls.find(c=>c.action==='rascunho');assert.ok(post);assert.equal(post.init.headers.Authorization,'Bearer synthetic-manager');assert.equal(post.body.rascunho.corpo,content.corpo);assert.ok(s.calls.findIndex(c=>c.action==='email_capacidades')<s.calls.indexOf(post));
 const legacy=s.GTA.cliente({endpoint:'https://example.invalid/templates',fetch:async(_u,i)=>{headers=i.headers;return{status:200,json:async()=>({})};},chaveEscrita:'legacy'});await legacy.rascunho({},{});assert.equal(headers.Authorization,undefined);
});
test('extended test confirmation displays structured examples and forwards only the frozen preview token',async()=>{
 const s=setup(),r=s.GENU.derive({name:'Teste',subject:'Assunto',body:'<p>{{ .Tx.Data.order_number }}</p>'},'fish');r.servidor={draft_id:'d_native',version:2,estado:'publicado',hash:s.GTA.hash(s.GR.conteudo(r))};s.GR.guarda(r);s.GRU.abrir(r,r.id);let sent;
 s.GRU.emailTestSession={local_id:r.id,brand:'fish',draft_id:'d_native',version:2,content:JSON.stringify(s.GR.conteudo(r)),client:{run:async input=>{sent=input;return{phase:'confirmed',operation:{http_accepted:true,ses:{}}};}},preview:{brand:'fish',version:2,recipient:'felipebandeira@oaristocrata.com',rendered_subject:'✅ FINAL — Assunto',body_html:'<p>Exemplo</p>',data:{items:[{name:'Item fictício'}]},render_policy:'crm_email_native_preview_v1',preview_token:'b'.repeat(64)}};
 s.GRU.render();assert.match(s.document.body.textContent,/Item fictício/);assert.doesNotMatch(s.document.body.textContent,/\[object Object\]/);assert.equal(sent,undefined);await s.GRU.emailTestSend();assert.equal(sent.preview_token,'b'.repeat(64));assert.equal(sent.render_policy,'crm_email_native_preview_v1');assert.equal(sent.confirm,'enviar_teste');assert.equal(s.GRU.emailTestSession,null);
});

test('unsaved editor changes block the native catalog without replacing content or making any request',async()=>{
 for(const brand of ['fish','aristo']){const s=setup({brand}),r=s.GENU.derive({name:'Em edição',subject:'Assunto',body:'<p>Conteúdo inicial</p>'},brand);s.GRU.abrir(r,null);s.GRU.state.rascunho.corpo='<p>Alteração ainda não salva</p>';const current=s.GRU.state.rascunho,before=JSON.stringify(current);assert.equal(s.GRU.contextStatus().dirty,true);await s.GENU.open();assert.equal(s.GRU.state.rascunho,current);assert.equal(JSON.stringify(s.GRU.state.rascunho),before);assert.equal(s.GENU.session,null);assert.equal(s.GRU.nativeEmailSession,false);assert.equal(s.calls.length,0);assert.equal(s.GR.lista().length,0);assert.match(s.GRU.state.msg,/Salve ou feche o rascunho atual/);}
});
