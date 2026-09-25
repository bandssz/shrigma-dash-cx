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
