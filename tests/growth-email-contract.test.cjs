'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),G=require('../growth-email-contract');
const draft=(marca='fish')=>({canal:'email',marca,nome:'QA',assunto:'✅ FINAL — QA',corpo:'<h1>Olá</h1>',from_email:G.BRANDS[marca].name+' <teste@'+G.BRANDS[marca].domain+'>',reply_to:'resposta@'+G.BRANDS[marca].domain,preheader:'Prévia segura',botoes:[]});
test('email envelope accepts each brand and rejects another sender domain and injected headers',()=>{
 for(const brand of ['fish','aristo']){
  const d=draft(brand);assert.deepEqual(G.envelopeErrors(d),[]);
  for(const field of ['from_email','reply_to']){
   assert.ok(G.envelopeErrors({...d,[field]:'teste@'+G.BRANDS[brand==='fish'?'aristo':'fish'].domain}).some(e=>e.campo===field));
   assert.ok(G.envelopeErrors({...d,[field]:d[field]+'\r\nBcc: other@example.invalid'}).some(e=>e.campo===field));
  }
  assert.ok(G.envelopeErrors({...d,from_email:'a@evil.invalid,'+d.from_email}).length);
 }
});
test('preheader is required, bounded, single-line plain text and escaped in the email',()=>{
 const d=draft();for(const preheader of ['',undefined,'x'.repeat(201),'a\nb','{{ .Tx.Data.secret }}'])assert.ok(G.envelopeErrors({...d,preheader}).some(e=>e.campo==='preheader'));
 const html=G.html({...d,preheader:'A & <B> "C"'});assert.match(html,/A &amp; &lt;B&gt; &quot;C&quot;/);assert.match(html,/data-crm-preheader="1"/);assert.doesNotMatch(html,/<B>/);
});
test('a complete document keeps its layout and receives preheader inside body rather than nested html',()=>{
 const d={...draft('aristo'),corpo:'<!doctype html><html><head><style>p{color:black}</style></head><body class="email"><p>{{ .Tx.Data.first_name }}</p></body></html>'};
 const html=G.html(d);assert.equal((html.match(/<html>/g)||[]).length,1);assert.match(html,/<body class="email"><div data-crm-preheader/);assert.ok(html.includes('{{ .Tx.Data.first_name }}'));
 assert.equal(G.documentErrors({...d,rodape:'must not disappear'}).length,1);assert.equal(G.documentErrors({...d,corpo:'<html>missing body</html>'}).length,1);
});
test('legacy fragments without envelope keep their existing generated body and envelope does not leak into provider fields',()=>{
 const d=draft();delete d.preheader;delete d.from_email;delete d.reply_to;
 assert.equal(G.hasEnvelope(d),false);assert.match(G.html(d),/Fishermans/);assert.doesNotMatch(G.html(d),/data-crm-preheader/);
 assert.deepEqual(Object.keys(G.payload(d)).sort(),['body','name','subject','type']);assert.deepEqual(G.envelopeErrors({...draft(),canal:'whatsapp'}),[]);
});
test('email export and import retain all envelope fields; WhatsApp export never inherits them',()=>{
 const GR=require('../growth-drafts'),r=GR.novo(draft('aristo')),restored=GR.importa(GR.exporta(r)).rascunho;
 for(const field of G.FIELDS)assert.equal(restored[field],r[field]);
 const wa=GR.conteudo({...r,canal:'whatsapp'});for(const field of G.FIELDS)assert.equal(Object.hasOwn(wa,field),false);
});
test('preview and provider use the same body including preheader and keep invalid partial HTML recoverable',()=>{
 const P=require('../growth-message-preview'),d=draft('aristo');assert.equal(P.emailHTML(d),G.payload(d).body);
 assert.match(P.emailHTML({...d,corpo:'<html>typing'}),/Complete o conteúdo/);
 const GR=require('../growth-drafts');assert.ok(GR.valida({...d,reply_to:'bad@wrong.invalid'}).erros.some(e=>e.includes('resposta')));
});
