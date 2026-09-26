const test=require('node:test'),assert=require('node:assert/strict');
const R=require('../growth-email-replication.js'),GR=require('../growth-drafts.js'),GEC=require('../growth-email-contract.js');
const journal={available:true,blocked:false,operations:[]};
const source=(brand='fish',more={})=>GR.novo({canal:'email',marca:brand,nome:brand+'_carta',assunto:'Olá '+GEC.BRANDS[brand].name,preheader:'Novidades '+GEC.BRANDS[brand].name,from_email:'Contato <contato@'+GEC.BRANDS[brand].domain+'>',reply_to:'contato@'+GEC.BRANDS[brand].domain,corpo:'<p>'+GEC.BRANDS[brand].name+'</p><a href="https://'+GEC.BRANDS[brand].domain+'/products/origem?utm_source='+brand+'&amp;utm_campaign='+brand+'_novidade">Comprar</a><img src="https://cdn.example.test/image%2Flogo.png">',servidor:{draft_id:'d_old',version:4,receipt:'old'},test:{id:'old'},operation_id:'old',...more});
function review(plan){return {links:plan.links.map(l=>({id:l.id,reviewed:true,target:l.kind==='origin'?'https://'+GEC.BRANDS[plan.to].domain+'/products/produto-conferido':l.url}))};}
for(const from of ['fish','aristo'])test('complete local content copy '+from+' to the other brand requires explicit mapped paths',()=>{
 const to=from==='fish'?'aristo':'fish',s=source(from),original=JSON.stringify(s),plan=R.prepare(s,to,{journal});
 assert.throws(()=>R.apply(plan),/Confira todos/);assert.equal(plan.links.length,2);
 const copied=R.apply(plan,review(plan));assert.equal(copied.marca,to);assert.equal(copied.canal,'email');assert.match(copied.from_email,new RegExp(GEC.BRANDS[to].domain));assert.match(copied.reply_to,new RegExp(GEC.BRANDS[to].domain));
 assert.ok(copied.corpo.includes('/products/produto-conferido?utm_source='+to));assert.equal(copied.corpo.includes('utm_campaign='),false);assert.ok(copied.corpo.includes('https://cdn.example.test/image%2Flogo.png'));
 assert.equal(R.sourceRemains(JSON.stringify(copied),from),false);for(const k of ['id','servidor','test','operation_id','criado_em','atualizado_em'])assert.equal(Object.hasOwn(copied,k),false);assert.equal(JSON.stringify(s),original);
});
test('source/deep links are never domain-replaced or asserted to exist; external resources require review',()=>{
 const p=R.prepare(source(),'aristo',{journal}),r=review(p);r.links[0].target='';assert.throws(()=>R.apply(p,r),/Informe o destino/);
 r.links[0].target='https://oaristocrata.com/products/explicit';r.links[1].reviewed=false;assert.throws(()=>R.apply(p,r),/Confira todos/);
 r.links[1].reviewed=true;r.links[0].target='https://fishermans.com.br/products/old';assert.throws(()=>R.apply(p,r),/origem/);
});
test('VML, CSS, plaintext, protocol relative URLs and contact addresses are mapped and residual encoded brands block',()=>{
 const s=source('fish',{corpo:'<!doctype html><html><body style="background:#414f27;background-image:url(https://fishermans.com.br/background.png)"><!--[if mso]><v:roundrect href="https://fishermans.com.br/vml"><![endif]--><p>https://fishermans.com.br/plain contato@fishermans.com.br</p><img src="//cdn.example.test/logo.png"></body></html>'});
 const p=R.prepare(s,'aristo',{journal});assert.equal(p.links.length,5);const r=review(p);r.links.find(x=>p.links.find(l=>l.id===x.id).raw.startsWith('contato@')).target='contato@oaristocrata.com';r.links.find(x=>x.target.includes('cdn.example.test')).target='https://cdn.example.test/logo.png';
 const c=R.apply(p,r);assert.equal(R.sourceRemains(c.corpo,'fish'),false);assert.ok(c.corpo.includes('#3b1f13'));assert.ok(c.corpo.includes('v:roundrect'));
 for(const raw of ['fishermans&#46;com.br','fishermans%2Ecom.br','fishermans\\2e com.br','%66ishermans.com.br · 50%off']){const q=R.prepare(source('fish',{corpo:'<p>'+raw+'</p>'}),'aristo',{journal});assert.throws(()=>R.apply(q,{links:[]}),/origem/);}
});
test('relative and dynamic targets are explicit decisions; unsupported multi-source media fails actionable',()=>{
 const p=R.prepare(source('fish',{corpo:'<a href="/products/old">Go</a><a href="{{ .Tx.Data.order_url }}">Pedido</a>'}),'aristo',{journal});assert.deepEqual(p.links.map(l=>l.kind),['relative','dynamic']);
 const c=R.apply(p,{links:p.links.map(l=>({id:l.id,reviewed:true,target:l.kind==='relative'?'https://oaristocrata.com/products/new':l.raw}))});assert.ok(c.corpo.includes('{{ .Tx.Data.order_url }}'));
 assert.throws(()=>R.prepare(source('fish',{corpo:'<img srcset="/a 1x, /b 2x">'}),'aristo',{journal}),/srcset/);
});
test('pending, uncertain, unavailable and legacy journals block source copies without carrying receipts',()=>{
 for(const j of [null,{available:false},{...journal,blocked:true},{...journal,operations:[{local_id:'source',phase:'unknown'}]}])assert.throws(()=>R.prepare(source('fish',{id:'source'}),'aristo',{journal:j}),/pendente ou incerta/);
 assert.throws(()=>R.prepare(source('fish',{servidor:{pendente:{id:'old'}}}),'aristo',{journal}),/pendente/);
});
test('changed review fields cannot inject new unreviewed links or an invalid destination envelope',()=>{
 const p=R.prepare(source(),'aristo',{journal}),r=review(p);
 assert.throws(()=>R.apply(p,{...r,fields:{reply_to:'source@fishermans.com.br'}}),/origem/);
 assert.throws(()=>R.apply(p,{...r,fields:{assunto:'https://new.example.test'}}),/links mudaram/);
 assert.throws(()=>R.apply(p,{...r,fields:{servidor:{id:'old'}}}),/Campo/);
});
test('a source-brand image may map to a separately reviewed destination CDN resource',()=>{
 const p=R.prepare(source('fish',{corpo:'<img src="https://fishermans.com.br/logo.png"><div style="background-image:url(https://cdn.example.test/fishermans/background.png)"></div>'}),'aristo',{journal});
 const r={links:p.links.map(l=>({id:l.id,reviewed:true,target:'https://cdn.example.test/aristo/reviewed.png'}))};const c=R.apply(p,r);assert.ok(c.corpo.includes('aristo/reviewed.png'));assert.equal(R.sourceRemains(c.corpo,'fish'),false);
});

const oldUUID='12345678-1234-4567-890a-1234567890ab';
for(const from of ['fish','aristo']){
 const to=from==='fish'?'aristo':'fish',domain=GEC.BRANDS[to].domain;
 test(from+' transport identity is removed without touching product IDs; destination campaign is explicit',()=>{
  const p=R.prepare(source(from,{corpo:'<a href="https://'+GEC.BRANDS[from].domain+'/products/old?variant=42&amp;id=19&amp;product_id=17&amp;utm_source=email&amp;utm_medium=campanha&amp;utm_content=link&amp;utm_campaign=lm-123&amp;utm_term=warm--lm-123-l15-16&amp;crm_dispatch_id='+oldUUID+'">Comprar</a>'}),to,{journal});
  const clean=new URL(p.links[0].url);for(const key of ['utm_campaign','utm_term','crm_dispatch_id'])assert.equal(clean.searchParams.has(key),false);assert.equal(clean.searchParams.get('variant'),'42');assert.equal(clean.searchParams.get('id'),'19');
  const mapped='https://'+domain+'/products/reviewed?variant=42&id=19&product_id=17&utm_campaign=campanha_revisada&crm_dispatch_id='+oldUUID+'&subscriber_id=92&campaign_id=123&list_ids=15-16&claim_token=old&journey_entry_id=old&utm_term=lm-123-l15';
  const c=R.apply(p,{links:[{id:p.links[0].id,target:mapped,reviewed:true}]});const final=new URL(R.urls(c)[0]);
  for(const key of ['crm_dispatch_id','subscriber_id','campaign_id','list_ids','claim_token','journey_entry_id','utm_term'])assert.equal(final.searchParams.has(key),false);
  assert.equal(final.searchParams.get('variant'),'42');assert.equal(final.searchParams.get('id'),'19');assert.equal(final.searchParams.get('product_id'),'17');assert.deepEqual(R.campaigns(final.href),['campanha_revisada']);assert.equal(final.searchParams.get('utm_content'),'link');assert.equal(JSON.stringify(c).includes(oldUUID),false);assert.equal(JSON.stringify(c).includes('lm-123'),false);
  for(const value of ['lm-123','destino--lm-123-l15','dispatch-'+oldUUID,oldUUID]){
   const c=R.apply(p,{links:[{id:p.links[0].id,target:'https://'+domain+'/products/new?utm_campaign='+value+'&utm_content='+value,reviewed:true}]});const u=new URL(R.urls(c)[0]);assert.equal(u.searchParams.has('utm_campaign'),false);assert.notEqual(u.searchParams.get('utm_content'),value);
  }
 });
 test(from+' discount nested redirect loses old attribution and preserves the reviewed product route',()=>{
  const redirect='/products/old?variant=8&utm_term=warm--lm-77-l2&utm_campaign=old_campaign&crm_dispatch_id='+oldUUID;
  const p=R.prepare(source(from,{corpo:'<a href="https://'+GEC.BRANDS[from].domain+'/discount/CUPOM?redirect='+encodeURIComponent(redirect)+'">Cupom</a>'}),to,{journal});
  assert.equal(p.links[0].url.includes('lm-77'),false);assert.equal(p.links[0].url.includes(oldUUID),false);
  const target='https://'+domain+'/discount/DESTINO?redirect='+encodeURIComponent('/products/reviewed?variant=8&utm_campaign=destino_revisado&utm_term=lm-77-l2&subscriber_uuid='+oldUUID);
  const c=R.apply(p,{links:[{id:p.links[0].id,target,reviewed:true}]}),u=new URL(R.urls(c)[0]),nested=new URL(u.searchParams.get('redirect'),u.origin);
  assert.equal(u.pathname,'/discount/DESTINO');assert.equal(nested.pathname,'/products/reviewed');assert.equal(nested.searchParams.get('variant'),'8');assert.equal(nested.searchParams.get('utm_term'),null);assert.equal(nested.searchParams.get('subscriber_uuid'),null);assert.deepEqual(R.campaigns(u.href),['destino_revisado']);
 });
 test(from+' resolved personal Listmonk routes need a new direct destination, never a tracking wrapper',()=>{
  const paths=['/link/'+oldUUID+'/'+oldUUID+'/'+oldUUID,'/campaign/'+oldUUID+'/'+oldUUID,'/campaign/'+oldUUID+'/'+oldUUID+'/px.png','/subscription/'+oldUUID+'/'+oldUUID,...['optin','export','wipe'].map(x=>'/subscription/'+x+'/'+oldUUID)];
  for(const path of paths){
   const raw='https://mail.example.test'+path,p=R.prepare(source(from,{corpo:'<a href="'+raw+'">Link</a>'}),to,{journal});assert.equal(p.links[0].kind,'personal');
   for(const target of [raw,'https://'+domain+'/discount/X?redirect='+encodeURIComponent(raw),'https://redirect.example.test/?url='+encodeURIComponent(raw)])assert.throws(()=>R.apply(p,{links:[{id:p.links[0].id,target,reviewed:true}]}),/destino direto/);
   const c=R.apply(p,{links:[{id:p.links[0].id,target:'https://'+domain+'/pages/reviewed',reviewed:true}]});assert.equal(c.corpo.includes(oldUUID),false);
  }
  const p=R.prepare(source(from,{corpo:'<a href="https://cdn.example.test/link/product?variant=2">Recurso</a>'}),to,{journal});assert.equal(p.links[0].kind,'external');assert.ok(R.apply(p,review(p)).corpo.includes('/link/product?variant=2'));
 });
}
for(const from of ['fish','aristo'])test('native Go ranges preserve helpers and map quoted URL fallback '+from,()=>{
 const to=from==='fish'?'aristo':'fish',origin=GEC.BRANDS[from],target=GEC.BRANDS[to];
 const html='<p>{{ .Tx.Data.first_name | upper }}</p>{{ if or .Tx.Data.order_url .Tx.Data.checkout_url }}<a href="{{ default "https://'+origin.domain+'/products/old?utm_term=lm-123" .Tx.Data.order_url }}">'+origin.name+'</a>{{ end }}{{ range .Tx.Data.items }}<img src="{{ .image }}"><p>{{ .name }}</p>{{ end }}';
 const s=source(from,{corpo:html}),before=JSON.stringify(s),p=R.prepare(s,to,{journal});
 assert.equal(p.links.length,2);assert.equal(p.links[0].original_url,'https://'+origin.domain+'/products/old?utm_term=lm-123');assert.equal(p.links[0].url.includes('lm-123'),false);
 const out=R.apply(p,{links:p.links.map(l=>({id:l.id,reviewed:true,target:l.kind==='origin'?'https://'+target.domain+'/products/reviewed?variant=42':l.url}))});
 assert.match(out.corpo,/default "https:\/\//);assert.ok(out.corpo.includes('default "https://'+target.domain+'/products/reviewed?variant=42"'));assert.ok(out.corpo.includes('{{ range .Tx.Data.items }}<img src="{{ .image }}">'));assert.ok(out.corpo.includes('{{ .Tx.Data.first_name | upper }}'));assert.equal(out.corpo.includes('lm-123'),false);assert.equal(JSON.stringify(s),before);assert.equal(GEC.documentErrors(out).length,0);
 assert.throws(()=>R.apply(p,{links:p.links.map(l=>({id:l.id,reviewed:true,target:l.kind==='origin'?'javascript:alert(1)':l.url}))}),/HTTPS/);
});
test('Go string literals are encoded as whole tokens; brand text may change but fields and control flow do not',()=>{
 const p=R.prepare(source('fish',{corpo:'{{ if .Tx.Data.first_name }}<p>{{ default "Fishermans" .Tx.Data.first_name }}</p>{{ end }}'}),'aristo',{journal});
 const out=R.apply(p,{links:[]});assert.ok(out.corpo.includes('default "O Aristocrata"'));assert.ok(out.corpo.includes('{{ if .Tx.Data.first_name }}'));assert.equal(GEC.documentErrors(out).length,0);
});


for(const from of ['fish','aristo'])test('conditional URL keeps native branches and typed runtime field while mapping the literal destination '+from,()=>{
 const to=from==='fish'?'aristo':'fish',origin=GEC.BRANDS[from].domain,destination=GEC.BRANDS[to].domain;
 const raw='{{ if .Tx.Data.order_url }}{{ .Tx.Data.order_url }}{{ else }}https://'+origin+'{{ end }}?utm_source=email&utm_medium=fluxo&utm_campaign='+to+'-transacional&utm_content=pedido-confirmado';
 const input=source(from,{corpo:'<a href="'+raw+'">Pedido</a>'}),before=JSON.stringify(input),plan=R.prepare(input,to,{journal});
 assert.equal(plan.links.length,1);assert.equal(plan.links[0].kind,'origin');
 const target=plan.links[0].raw.replaceAll(origin,destination),out=R.apply(plan,{links:[{id:plan.links[0].id,reviewed:true,target}]});
 const GEE=require('../growth-email-expressions'),a=GEE.parse(plan.content.corpo,{html:true}),b=GEE.parse(out.corpo,{html:true});
 assert.deepEqual(a.actions.map(x=>plan.content.corpo.slice(x.start,x.end)),b.actions.map(x=>out.corpo.slice(x.start,x.end)));
 assert.ok(out.corpo.includes('{{ if .Tx.Data.order_url }}{{ .Tx.Data.order_url }}{{ else }}https://'+destination+'{{ end }}'));assert.ok(out.corpo.includes('utm_campaign='+to+'-transacional'));assert.equal(GEC.documentErrors(out).length,0);assert.equal(R.sourceRemains(out.corpo,from),false);assert.equal(JSON.stringify(input),before);assert.equal(out.servidor,undefined);
});
test('conditional URL review refuses changed control/fields, unsafe literals and incomplete URL construction',()=>{
 const raw='{{ if .Tx.Data.order_url }}{{ .Tx.Data.order_url }}{{ else }}https://fishermans.com.br{{ end }}?utm_source=email';
 const p=R.prepare(source('fish',{corpo:'<a href="'+raw+'">Pedido</a>'}),'aristo',{journal}),link=p.links[0];
 const good=link.raw.replaceAll('fishermans.com.br','oaristocrata.com'),apply=target=>R.apply(p,{links:[{id:link.id,reviewed:true,target}]});
 for(const target of [
  good.replaceAll('.Tx.Data.order_url','.Tx.Data.first_name'),good.replace('{{ if .Tx.Data.order_url }}','{{ if .Tx.Data.checkout_url }}'),good.replace('{{ else }}','{{ else }}{{ .Tx.Data.order_url }}'),
  good.replace('https://oaristocrata.com','http://oaristocrata.com'),good.replace('https://oaristocrata.com','javascript:alert(1)'),good.replace('https://oaristocrata.com','jav&#97;script:alert(1)'),good.replace('https://oaristocrata.com','data:text/html,hello'),good.replace('https://oaristocrata.com','//oaristocrata.com'),good.replace('https://oaristocrata.com','https://external.invalid'),good.replace('https://oaristocrata.com','https://oaristocrata.com@external.invalid'),
  good.replace('https://oaristocrata.com','https://oaristocrata.com" onmouseover="alert(1)'),good.replace('https://oaristocrata.com','https://oaristocrata.com&quot; onmouseover=&quot;alert(1)'),good.replace('{{ .Tx.Data.order_url }}','https://{{ .Tx.Data.order_url }}'),good.replace('?utm_source=email','/append-path'), 'https://oaristocrata.com/fixed'
 ])assert.throws(()=>apply(target));
 const scalar=R.prepare(source('fish',{corpo:'<a href="{{ if .Tx.Data.first_name }}{{ .Tx.Data.first_name }}{{ else }}https://fishermans.com.br{{ end }}">Pedido</a>'}),'aristo',{journal});assert.throws(()=>R.apply(scalar,{links:scalar.links.map(l=>({id:l.id,reviewed:true,target:l.raw.replaceAll('fishermans.com.br','oaristocrata.com')}))}),/variáveis de endereço/);
});
test('static tracking inside conditional URL branches and suffixes is removed without changing the native actions',()=>{
 const raw='{{ if .Tx.Data.order_url }}{{ .Tx.Data.order_url }}{{ else }}https://fishermans.com.br/products/reviewed?variant=42&utm_term=lm-11{{ end }}&utm_campaign=aristo-reviewed&subscriber_id=92&crm_dispatch_id='+oldUUID;
 const p=R.prepare(source('fish',{corpo:'<a href="'+raw+'">Pedido</a>'}),'aristo',{journal});
 const out=R.apply(p,{links:p.links.map(l=>({id:l.id,reviewed:true,target:l.raw.replaceAll('fishermans.com.br','oaristocrata.com')}))});
 assert.ok(out.corpo.includes('{{ .Tx.Data.order_url }}'));assert.ok(out.corpo.includes('variant=42'));assert.ok(out.corpo.includes('utm_campaign=aristo-reviewed'));for(const old of ['lm-11',oldUUID,'subscriber_id','crm_dispatch_id','utm_term'])assert.equal(out.corpo.includes(old),false);
 const personal=p.links[0].raw.replaceAll('fishermans.com.br','oaristocrata.com').replace('/products/reviewed','/link/'+oldUUID+'/'+oldUUID+'/'+oldUUID);assert.throws(()=>R.apply(p,{links:[{id:p.links[0].id,reviewed:true,target:personal}]}),/destino direto/);
});
test('previously accepted unchanged dynamic expressions retain full-document context',()=>{
 const raw='{{ if .name }}{{ .name }}{{ else }}https://cdn.example.test/default.png{{ end }}';
 const p=R.prepare(source('fish',{corpo:'{{ range .Tx.Data.items }}<img src="'+raw+'">{{ end }}'}),'aristo',{journal});
 const out=R.apply(p,{links:p.links.map(l=>({id:l.id,reviewed:true,target:l.raw}))});assert.ok(out.corpo.includes(raw));assert.equal(GEC.documentErrors(out).length,0);
});
test('fragmented authority is rejected and complete authority with conditional paths is byte-preserved',()=>{
 const raw='https://fishermans.com.br{{ if .Tx.Data.has_discount }}/products/a{{ else }}/products/b{{ end }}';
 const p=R.prepare(source('fish',{corpo:'<a href="'+raw+'">Pedido</a>'}),'aristo',{journal}),target=p.links[0].raw.replaceAll('fishermans.com.br','oaristocrata.com');
 const out=R.apply(p,{links:[{id:p.links[0].id,reviewed:true,target}]});assert.ok(out.corpo.includes('href="'+target+'"'));assert.equal(out.corpo.includes('oaristocrata.com/{{'),false);
 assert.throws(()=>R.apply(p,{links:[{id:p.links[0].id,reviewed:true,target:'https://oaristocrata{{ if .Tx.Data.has_discount }}.com/products/a{{ else }}.com/products/b{{ end }}'}]}),/domínio completos/);
});
test('range-scoped conditional image retains its validated scope and refuses scalar or root context',()=>{
 const raw='{{ if .image }}{{ .image }}{{ else }}https://cdn.example.test/default.png{{ end }}';
 const p=R.prepare(source('fish',{corpo:'{{ range .Tx.Data.items }}<img src="'+raw+'">{{ end }}'}),'aristo',{journal});assert.equal(p.links[0].itemScoped,true);
 const out=R.apply(p,{links:[{id:p.links[0].id,reviewed:true,target:raw}]});assert.ok(out.corpo.includes(raw));assert.equal(GEC.documentErrors(out).length,0);
 for(const target of [raw.replaceAll('.image','.name'),raw.replaceAll('.image','.Tx.Data.order_url')])assert.throws(()=>R.apply(p,{links:[{id:p.links[0].id,reviewed:true,target}]}));
 assert.throws(()=>R.prepare(source('fish',{corpo:'<img src="'+raw+'">'}),'aristo',{journal}));
});
test('removing the last tracking parameter keeps the delimiter for a following query suffix',()=>{
 const raw='{{ if .Tx.Data.order_url }}{{ .Tx.Data.order_url }}{{ else }}https://fishermans.com.br/products/reviewed?utm_term=lm-11{{ end }}&utm_campaign=aristo-reviewed';
 const p=R.prepare(source('fish',{corpo:'<a href="'+raw+'">Pedido</a>'}),'aristo',{journal});
 const out=R.apply(p,{links:p.links.map(l=>({id:l.id,reviewed:true,target:l.raw.replaceAll('fishermans.com.br','oaristocrata.com')}))});
 assert.ok(out.corpo.includes('/products/reviewed?{{ end }}&amp;utm_campaign=aristo-reviewed'));assert.equal(out.corpo.includes('utm_term'),false);
 const fallback=R.decode(out.corpo.match(/{{ else }}(.*?){{ end }}/)[1])+R.decode(out.corpo.match(/{{ end }}([^"]*)/)[1]);assert.equal(new URL(fallback).searchParams.get('utm_campaign'),'aristo-reviewed');
});
for(const from of ['fish','aristo'])test('default URL fallback and static UTM suffix adapt independently from other source URLs '+from,()=>{
 const to=from==='fish'?'aristo':'fish',origin=GEC.BRANDS[from].domain,destination=GEC.BRANDS[to].domain;
 const html='<a href="{{ default "https://'+origin+'/" .Tx.Data.order_url }}?utm_source=email&amp;utm_medium=fluxo&amp;utm_campaign='+from+'-transacional">Pedido</a><img src="https://cdn.example.test/'+origin+'/logo.png">';
 const input=source(from,{corpo:html}),before=JSON.stringify(input),plan=R.prepare(input,to,{journal});
 assert.equal(plan.links.length,2);assert.ok(plan.content.corpo.includes('utm_campaign='+to+'-transacional'));
 const out=R.apply(plan,{links:plan.links.map(l=>({id:l.id,reviewed:true,target:l.resource?'https://cdn.example.test/destination-logo.png':'https://'+destination+'/'}))});
 assert.equal(R.sourceRemains(JSON.stringify(out),from),false);assert.equal(GEC.documentErrors(out).length,0);assert.ok(out.corpo.includes('default "https://'+destination+'/" .Tx.Data.order_url'));assert.ok(out.corpo.includes('utm_campaign='+to+'-transacional'));assert.equal(JSON.stringify(input),before);
});
