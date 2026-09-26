const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const GUT=require('../growth-utm');
const {parseHTML}=require('linkedom');
test('reads all literal UTM patterns, HTML entities and encoded values without rewriting content',()=>{
 const input='<a href="https://fishermans.com.br/products/a?utm_source=email&amp;utm_medium=fluxo&amp;utm_campaign=fish-carrinho&amp;utm_content=30min">A</a>\nhttps://fishermans.com.br/products/b?utm_source=whatsapp&utm_medium=fluxo&utm_content=24h&utm_term=vers%C3%A3o-b';
 assert.deepEqual(GUT.fromContent(input),[{source:'email',medium:'fluxo',campaign:'fish-carrinho',content:'30min'},{source:'whatsapp',medium:'fluxo',content:'24h',term:'versão-b'}]);
 assert.ok(input.includes('&amp;'));assert.equal(GUT.fromContent(input+'\n'+input).length,2);
});
test('preserves source expressions and full runtime URLs without evaluating Go',()=>{
 const input='<a href="{{ .Tx.Data.checkout_url }}?utm_source={{ .Tx.Data.utm_source }}&utm_medium=fluxo&utm_campaign=fish-cart">A</a>';
 const rows=GUT.fromContent(input);assert.equal(rows[0].source,'{{ .Tx.Data.utm_source }}');
 assert.deepEqual(GUT.dynamicFields(input),['.Tx.Data.checkout_url']);
 const rendered=GUT.render({rows,dynamic:GUT.dynamicFields(input)});assert.match(rendered,/Variável de source/);assert.match(rendered,/\{\{ .Tx.Data.utm_source \}\}/);assert.match(rendered,/Endereço preenchido no disparo/);
 assert.equal(GUT.fromContent('{{ .Tx.Data.checkout_url }}').length,0);
});
test('native default literals and conditional fallback suffixes remain inspectable',()=>{
 assert.equal(GUT.fromContent('<a href="{{ default "https://x.test/?utm_source=email" .Tx.Data.order_url }}">A</a>')[0].source,'email');
 assert.equal(GUT.fromContent('<a href="{{ if .Tx.Data.order_url }}{{ .Tx.Data.order_url }}{{ else }}https://x.test{{ end }}?utm_source=email&utm_campaign=aristo-transacional">A</a>')[0].campaign,'aristo-transacional');
 assert.equal(GUT.fromContent('https://x.test/#utm_source=not-a-query').length,0);
});
test('duplicate source values stay visible; missing values and historical generator stay unknown',()=>{
 assert.deepEqual(GUT.fromContent('https://x.test/?utm_source=a&utm_source=b')[0].source,['a','b']);
 const html=GUT.render({rows:[{source:'listmonk'}],mode:'registered'});assert.match(html,/não informa a variável/);assert.doesNotMatch(html,/Valor fixo/);assert.match(html,/Não informado/);
 assert.match(GUT.render({rows:[]}),/UTMs não disponíveis/);assert.doesNotMatch(GUT.render({rows:[]}),/listmonk/);
});
test('Listmonk shorthand is not a UTM value and full conditional URLs stay separate',()=>{
 assert.equal(GUT.fromContent('https://x.test/?utm_source=listmonk&utm_term=lm-160-l3@TrackLink')[0].term,'lm-160-l3');
 const rows=GUT.fromContent('{{ if .Tx.Data.order_url }}https://x.test/?utm_source=email&utm_campaign=primary{{ else }}https://y.test/?utm_source=whatsapp&utm_campaign=fallback{{ end }}');
 assert.equal(rows.length,2);assert.equal(rows[0].source,'email');assert.equal(rows[0].campaign,'primary');assert.equal(rows[1].source,'whatsapp');assert.equal(rows[1].campaign,'fallback');assert.equal(rows.conditional,true);
 const unsupported=GUT.fromContent('https://x.test/?utm_source={{ if .Tx.Data.order_url }}email{{ else }}whatsapp{{ end }}');
 assert.equal(unsupported.length,0);assert.equal(unsupported.unresolvedConditional,true);assert.match(GUT.render({rows:unsupported}),/UTMs montadas por condições/);
});
test('inspection never emits executable markup or customer URLs',()=>{
 const html=GUT.render({rows:[{source:'<img src=x onerror=alert(1)>',campaign:'fish-cart'}],evidence:'<script>no</script>',dynamic:['<svg onload=no>']});
 assert.doesNotMatch(html,/<img|<script|<svg/);assert.match(html,/&lt;img/);
 const content='https://store.test/checkouts/private-customer-token?key=secret&utm_source=email&utm_campaign=fish-cart';
 const safe=GUT.render({rows:GUT.fromContent(content)});assert.doesNotMatch(safe,/private-customer-token|key=secret|store.test/);
});
test('automation uses exact selected template and brand; no channel-derived source',()=>{
 const ctx=vm.createContext({console,URLSearchParams});
 for(const name of ['growth-utm.js','growth-builder.js'])vm.runInContext(fs.readFileSync(require.resolve('../'+name),'utf8'),ctx);
 const result=vm.runInContext(`(()=>{const step={key:'mail',channel:'email',template_id:'1'},f={brand:'fish',available_steps:[{...step,name:'Carrinho'}]};
 GB.state.templates={'fish:email':[{brand:'aristo',channel:'email',id:'1',name:'Outra marca',components:{body_html:'https://x.test/?utm_source=aristo-secret'}},{brand:'fish',channel:'email',id:'1',name:'Carrinho Fish',components:{body_html:'{{ .Tx.Data.checkout_url }}?utm_source=email&utm_medium=fluxo&utm_campaign=fish-cart'}}]};
 const current=GB.trackingHtml(step,f,true);const missing=GB.trackingHtml({...step,template_id:'9'},f,true);return {current,missing,out:GB.trackingHtml(step,{...f,brand:'olivas'})};})()`,ctx);
 assert.match(result.current,/fish-cart/);assert.match(result.current,/\.Tx\.Data\.checkout_url/);assert.doesNotMatch(result.current,/aristo-secret/);assert.match(result.missing,/Use Atualizar/);assert.doesNotMatch(result.missing,/utm_source=email/);assert.equal(result.out,'');
});
test('WhatsApp exposes the URL button source variable; body text is not a tracking rule',()=>{
 const t={channel:'whatsapp',components:[{type:'BODY',text:'Ignore https://x.test/?utm_source=body-only'},{type:'BUTTONS',buttons:[{type:'URL',url:'https://x.test/{{1}}?utm_source={{2}}&utm_medium=fluxo'},{type:'PHONE_NUMBER',url:'https://x.test/?utm_source=not-a-url-button'}]}]};
 const content=GUT.templateContent(t);assert.equal(GUT.fromContent(content)[0].source,'{{2}}');assert.doesNotMatch(content,/body-only|not-a-url-button/);
});
test('verified runtime source description stays escaped and separate from template links',()=>{
 const context=vm.createContext({console,URLSearchParams,GURT:{read:()=>({rows:[{source:'whatsapp',campaign:'verified-cart'}],sourceExpression:"Valor fixo 'whatsapp' <script>blocked</script>",evidence:'Conferido em 25/09/2026',label:'Regra conferida do envio',scope:'Parâmetros anteriores são preservados.'})}});
 for(const name of ['growth-utm.js','growth-builder.js'])vm.runInContext(fs.readFileSync(require.resolve('../'+name),'utf8'),context);
 const html=vm.runInContext(`(()=>{const step={key:'wa',channel:'whatsapp',template_id:'1'},f={key:'fish:cart',brand:'fish',available_steps:[step]};GB.state.templates={'fish:whatsapp':[{brand:'fish',channel:'whatsapp',id:'1',name:'Template',components:[{type:'BUTTONS',buttons:[{type:'URL',url:'https://x.test/?utm_source=template-only'}]}]}]};return GB.trackingHtml(step,f,true);})()`,context);
 const {document}=parseHTML(html);assert.equal(document.querySelector('script'),null);
 assert.match(document.querySelector('.crm-utm').textContent,/Valor fixo 'whatsapp' <script>blocked<\/script>/);
 assert.match(html,/utm_campaign=verified-cart/);assert.match(html,/Links escritos no template/);assert.match(html,/utm_source=template-only/);
 assert.match(html,/Conferido em 25\/09\/2026/);assert.equal(document.querySelector('.crm-utm-note').getAttribute('title'),'Parâmetros anteriores são preservados.');
 const empty=parseHTML(GUT.render({rows:[],sourceExpression:'Origem não comprovada'})).document;assert.match(empty.querySelector('.crm-utm-source-rule').textContent,/Origem não comprovada/);
});
test('CRM managers retain journey and step UTM inspection for email and WhatsApp in both brands',()=>{
 const page=parseHTML(fs.readFileSync(require.resolve('../growth.html'),'utf8')).document;
 assert.equal(page.querySelector('#control-fluxos').closest('[data-crm-owner-only]'),null);
 for(const brand of ['fish','aristo']){
  const {document}=parseHTML('<html><body data-crm-view="manager"><section id="control-fluxos"></section></body></html>'),calls=[];
  const ctx=vm.createContext({document,console,URLSearchParams,setTimeout,fetch:()=>{calls.push(true);throw Error('inspection must not request');},GTA:{caps:()=>({endpoint:'/fixture'})},brand});
  for(const name of ['growth-utm.js','growth-runtime-utm.js','growth-builder.js'])vm.runInContext(fs.readFileSync(require.resolve('../'+name),'utf8'),ctx);
  vm.runInContext(`(()=>{
   const email={key:'email:carrinho-30min',channel:'email',flow:'carrinho',piece:'carrinho-30min',variant:'',template_id:'1',name:'Após 30 minutos',enabled:true};
   const wa={key:'whatsapp:carrinho-24h:b',channel:'whatsapp',flow:'carrinho',piece:'carrinho-24h',variant:'b',template_id:'2',name:'Após 24 horas',enabled:true};
   const f={key:brand+':carrinho',brand,name:'Carrinho',trigger:'Carrinho abandonado',version:6,published_version:6,runtime_ready:true,enabled:true,available_steps:[email,wa],draft:{name:'Carrinho',steps:[email,wa]}};
   GB.ctx={marca:brand};GB.state.loaded=true;GB.state.selected=f.key;GB.state.flows=[f];GB.state.draft=JSON.parse(JSON.stringify(f.draft));GB.state.templates={
    [brand+':email']:[{brand,channel:'email',id:'1',name:'Mensagem e-mail',components:{body_html:'{{ .Tx.Data.checkout_url }}?utm_source={{ .Tx.Data.source }}&utm_campaign='+brand+'-template'}}],
    [brand+':whatsapp']:[{brand,channel:'whatsapp',id:'2',name:'Mensagem WhatsApp',components:[{type:'BUTTONS',buttons:[{type:'URL',url:'https://example.test/{{1}}?utm_source={{2}}&utm_campaign='+brand+'-wa-template'}]}]}]
   };globalThis.before=JSON.stringify({draft:GB.state.draft,flows:GB.state.flows});GB.render();globalThis.after=JSON.stringify({draft:GB.state.draft,flows:GB.state.flows});
  })()`,ctx);
  const panel=document.querySelector('#control-fluxos'),summary=panel.querySelector('[data-journey-utm]');assert.ok(summary);assert.equal(summary.closest('[data-crm-owner-only]'),null);
  for(const el of panel.querySelectorAll('.crm-utm')){assert.equal(el.closest('[data-crm-owner-only]'),null);assert.equal(el.hasAttribute('hidden'),false);el.open=true;}
  const manager=panel.cloneNode(true);manager.querySelectorAll('[data-crm-owner-only]').forEach(el=>el.remove());
  const expected=[brand+'-carrinho',brand==='fish'?'fishermans-carrinho':'aristocrata-carrinho','{{ .Tx.Data.source }}','{{2}}','Variável de source','Valor literal "email"','Valor literal "whatsapp"','Links escritos no template'];
  for(const value of expected)assert.ok(manager.querySelector('[data-journey-utm]').textContent.includes(value),brand+': '+value);
  assert.equal(manager.querySelectorAll('[data-stage] .crm-utm[data-utm-key]').length,2);assert.match(manager.querySelector('[data-journey-utm]').textContent,/Conferido em .*registro da regra/);assert.match(manager.querySelector('[data-journey-utm] .crm-utm-note').getAttribute('title'),/não é consulta da configuração ao vivo/);
  assert.equal(ctx.before,ctx.after);assert.equal(calls.length,0);
 }
});
test('thirteen patterns collapse common fields once and preserve every complete tuple',()=>{
 const rows=Array.from({length:13},(_,i)=>({source:'listmonk',medium:'campanha',campaign:'fixture',content:i%2?'footer':'hero',term:'dispatch-'+i})),before=JSON.stringify(rows);
 const {document}=parseHTML(GUT.render({rows,mode:'registered',evidence:'Consulta sintética'})),group=document.querySelector('.crm-utm-group'),common=group.querySelector('dl');
 assert.deepEqual([...common.querySelectorAll('[data-utm-field]')].map(e=>e.dataset.utmField),['source','medium','campaign']);
 assert.deepEqual([...group.querySelectorAll('thead [data-utm-field]')].map(e=>e.dataset.utmField),['content','term']);
 const tableRows=[...group.querySelectorAll('tbody tr')];assert.equal(tableRows.length,13);
 for(const [i,row] of tableRows.entries()){assert.equal(row.dataset.utmPattern,String(i+1));assert.equal(row.querySelector('[data-utm-value=content]').textContent,rows[i].content);assert.equal(row.querySelector('[data-utm-value=term]').textContent,rows[i].term);}
 const queries=[...group.querySelectorAll('.crm-utm-complete li')];assert.equal(queries.length,13);
 for(const [i,item] of queries.entries())assert.equal(item.querySelector('code').textContent,'utm_source=listmonk&utm_medium=campanha&utm_campaign=fixture&utm_content='+rows[i].content+'&utm_term='+rows[i].term);
 assert.equal(group.querySelectorAll('dt').length,4);assert.equal((document.querySelector('.crm-utm').textContent.match(/Variável de source/g)||[]).length,1);assert.equal(document.querySelectorAll('.crm-utm-evidence').length,1);assert.equal(group.querySelector('.crm-utm-complete').hasAttribute('open'),false);assert.equal(JSON.stringify(rows),before);
});
test('grouping preserves original pairings, duplicate parameter order, missing fields and source variables',()=>{
 const expression='{{ .Tx.Data.utm_source }}',rows=[{source:expression,campaign:'one',content:'hero',term:'a'},{source:expression,campaign:'one',content:'footer',term:'b'},{source:expression,campaign:'one',content:'hero',term:'a'}];
 const {document}=parseHTML(GUT.render({rows}));assert.equal(document.querySelectorAll('tbody tr').length,2);assert.equal((document.querySelector('.crm-utm').textContent.match(/Variável de source/g)||[]).length,1);assert.ok(document.querySelector('dl').textContent.includes(expression));
 const absent=parseHTML(GUT.render({rows:[{source:['a','b'],campaign:'one'},{source:['b','a'],campaign:'one',term:'second'}]})).document;
 assert.deepEqual([...absent.querySelectorAll('tbody [data-utm-value=source]')].map(e=>[...e.querySelectorAll('code')].map(c=>c.textContent)),[['a','b'],['b','a']]);assert.equal(absent.querySelector('tbody [data-utm-value=term]').textContent,'Não informado');assert.equal(absent.querySelectorAll('.crm-utm-complete li').length,2);
});
test('one pattern retains the simple view and grouped values remain inert text',()=>{
 const single=parseHTML(GUT.render({rows:[{source:'email',campaign:'fixture'}]})).document;
 assert.equal(single.querySelector('table'),null);assert.equal(single.querySelector('.crm-utm-complete'),null);assert.equal(single.querySelectorAll('dl [data-utm-field]').length,5);assert.equal(single.querySelector('.crm-utm-query').textContent,'utm_source=email&utm_campaign=fixture');
 const payload='<img src=x onerror=alert(1)>',html=GUT.render({rows:[{source:payload,content:'<script>one</script>'},{source:payload,content:'<svg onload=two>'}],evidence:'<script>evidence</script>'}),grouped=parseHTML(html).document;
 assert.equal(grouped.querySelector('script,img,svg'),null);assert.equal(grouped.querySelectorAll('tbody tr').length,2);assert.ok(grouped.querySelector('dl').textContent.includes(payload));assert.ok(grouped.querySelector('tbody').textContent.includes('<script>one</script>'));assert.match(html,/&lt;svg/);
});
