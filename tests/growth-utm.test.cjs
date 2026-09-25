const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const GUT=require('../growth-utm');
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
