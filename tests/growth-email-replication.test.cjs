const test=require('node:test'),assert=require('node:assert/strict');
const R=require('../growth-email-replication.js'),GR=require('../growth-drafts.js'),GEC=require('../growth-email-contract.js');
const journal={available:true,blocked:false,operations:[]};
const source=(brand='fish',more={})=>GR.novo({canal:'email',marca:brand,nome:brand+'_carta',assunto:'Olá '+GEC.BRANDS[brand].name,preheader:'Novidades '+GEC.BRANDS[brand].name,from_email:'Contato <contato@'+GEC.BRANDS[brand].domain+'>',reply_to:'contato@'+GEC.BRANDS[brand].domain,corpo:'<p>'+GEC.BRANDS[brand].name+'</p><a href="https://'+GEC.BRANDS[brand].domain+'/products/origem?utm_source='+brand+'&amp;utm_campaign='+brand+'_novidade">Comprar</a><img src="https://cdn.example.test/image%2Flogo.png">',servidor:{draft_id:'d_old',version:4,receipt:'old'},test:{id:'old'},operation_id:'old',...more});
function review(plan){return {links:plan.links.map(l=>({id:l.id,reviewed:true,target:l.kind==='origin'?'https://'+GEC.BRANDS[plan.to].domain+'/products/produto-conferido':l.url}))};}
for(const from of ['fish','aristo'])test('complete local content copy '+from+' to the other brand requires explicit mapped paths',()=>{
 const to=from==='fish'?'aristo':'fish',s=source(from),original=JSON.stringify(s),plan=R.prepare(s,to,{journal});
 assert.throws(()=>R.apply(plan),/Confira todos/);assert.equal(plan.links.length,2);
 const copied=R.apply(plan,review(plan));assert.equal(copied.marca,to);assert.equal(copied.canal,'email');assert.match(copied.from_email,new RegExp(GEC.BRANDS[to].domain));assert.match(copied.reply_to,new RegExp(GEC.BRANDS[to].domain));
 assert.ok(copied.corpo.includes('/products/produto-conferido?utm_source='+to+'&amp;utm_campaign='+to+'_novidade'));assert.ok(copied.corpo.includes('https://cdn.example.test/image%2Flogo.png'));
 assert.equal(R.sourceRemains(JSON.stringify(copied),from),false);for(const k of ['id','servidor','test','operation_id','criado_em','atualizado_em'])assert.equal(Object.hasOwn(copied,k),false);assert.equal(JSON.stringify(s),original);
});
test('source/deep links are never domain-replaced or asserted to exist; external resources require review',()=>{
 const p=R.prepare(source(),'aristo',{journal}),r=review(p);r.links[0].target='';assert.throws(()=>R.apply(p,r),/Informe o destino/);
 r.links[0].target='https://oaristocrata.com/products/explicit';r.links[1].reviewed=false;assert.throws(()=>R.apply(p,r),/Confira todos/);
 r.links[1].reviewed=true;r.links[0].target='https://fishermans.com.br/products/old';assert.throws(()=>R.apply(p,r),/origem/);
});
test('VML, CSS, plaintext, protocol relative URLs and contact addresses are mapped and residual encoded brands block',()=>{
 const s=source('fish',{corpo:'<!doctype html><html><body style="background:#414f27;background-image:url(https://fishermans.com.br/background.png)"><!--[if mso]><v:roundrect href="https://fishermans.com.br/vml"><![endif]--><p>https://fishermans.com.br/plain contato@fishermans.com.br</p><img src="//cdn.example.test/logo.png"></body></html>'});
 const p=R.prepare(s,'aristo',{journal});assert.equal(p.links.length,5);const r=review(p);r.links.find(x=>p.links.find(l=>l.id===x.id).raw.startsWith('contato@')).target='contato@oaristocrata.com';r.links.find(x=>x.target.startsWith('//')).target='https://cdn.example.test/logo.png';
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
