'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const G=require('../growth-email-contract'),GR=require('../growth-drafts'),P=require('../n8n/growth/email-test-protocol.cjs');
const variable='{{ .Tx.Data.first_name }}';
const make=(brand,body,subject='Olá '+variable)=>GR.novo(G.draft({canal:'email',marca:brand,nome:'compat-fixture',assunto:subject,preheader:'Resumo da carta',corpo:body,botoes:[]}));
const snapshot=r=>{const n=G.payload(r);return {eligible:true,draft_id:'d_fixture',version:1,rascunho:r,components:{subject:n.subject,body_html:n.body},native:{id:1,type:'tx',subject:n.subject,body:n.body}};};
const doc=body=>'<!doctype html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"><style>p{color:#333} @media(max-width:600px){.card{width:100%!important}}</style></head><body class="letter" title="Width > 600">'+body+'</body></html>';
for(const brand of ['fish','aristo']){
 test(brand+' passive email metadata, complete static CSS and text/subject variables remain compatible',()=>{
  for(const [body,subject] of [[doc('<p style="color:red">Olá '+variable+'</p>'),'Assunto'],[doc('<p>Texto estático</p>'),'Olá '+variable],['<p style="color:red" title="a > b">'+variable+'</p>','Olá '+variable]]){
   const r=make(brand,body,subject);assert.deepEqual(GR.valida(r).erros,[]);const p=P.plan(snapshot(r),G);assert.equal(p.eligible,true);assert.equal(p.recipient,'felipebandeira@oaristocrata.com');assert.ok(p.subject.startsWith('✅ FINAL — '));assert.equal(p.variables.includes('first_name'),true);assert.equal(p.body_html.includes('{{'),false);
   if(body.startsWith('<!doctype'))assert.equal(G.payload(r).body,body.replace('<body class="letter" title="Width > 600">','<body class="letter" title="Width > 600">'+G.preheaderHTML(r)));
  }
 });
 test(brand+' metadata allowlist accepts only UTF-8 and the standard viewport attributes',()=>{
  for(const meta of ['<META CHARSET=UTF-8>','<meta charset="utf-8" />','<meta content="initial-scale=1.0, width=device-width" name="viewport">','<META HTTP-EQUIV="CONTENT-TYPE" CONTENT="text/html; charset=UTF-8">'])assert.deepEqual(GR.valida(make(brand,doc(meta+'<p>Corpo</p>'))).erros,[],meta);
  for(const meta of ['<meta http-equiv="refresh" content="0;url=https://example.invalid">','<meta http-equiv="Content-Security-Policy" content="default-src *">','<meta charset="UTF-7">','<meta name="viewport" content="width=device-width, initial-scale=1" onload="alert(1)">','<meta charset="UTF-8" http-equiv="refresh" content="0">','<meta name="viewport" content="width=device-width, width=device-width">','<meta name="viewport" content="width=device-width, initial-scale=1, refresh=0">','<meta name="description" content="Unapproved">','<meta charset="UTF-8" charset="UTF-7">','<meta http-equiv="Content-Type" content="text/html; charset=UTF-8; other=1">','<!-- <meta http-equiv="refresh" content="0"> -->'])assert.ok(GR.valida(make(brand,doc(meta))).erros.length,meta);
 });
 test(brand+' observed passive color metadata is allowed without broadening other directives',()=>{
  for(const [name,content] of [['color-scheme','light dark'],['color-scheme','light only'],['supported-color-schemes','light dark'],['supported-color-schemes','light']]){
   const body=doc('<meta name="'+name+'" content="'+content+'"><p>'+variable+'</p>'),r=make(brand,body);
   assert.deepEqual(GR.valida(r).erros,[]);assert.equal(P.plan(snapshot(r),G).eligible,true);assert.ok(G.html(r).includes('<meta name="'+name+'" content="'+content+'">'));
  }
  for(const meta of ['<meta name="color-scheme" content="dark">','<meta name="color-scheme" content="only light">','<meta name="color-scheme" content="light only dark">','<meta name="supported-color-schemes" content="light only">','<meta name="color-scheme" content="light dark" http-equiv="refresh">','<meta name="color-scheme" content="{{ .Tx.Data.first_name }}">','<meta name="color-scheme" content="light dark;url=https://example.invalid">'])assert.ok(GR.valida(make(brand,doc(meta))).erros.length,meta);
 });
 test(brand+' only the observed Google Fonts stylesheet shape is allowed, unchanged',()=>{
  const prefix='https://fonts.googleapis.com/css2?',font='family=Example+Serif:wght@400;700',link=href=>'<link rel="stylesheet" href="'+href+'">';
  for(const href of [prefix+font+'&display=swap',prefix+font+'&amp;family=Other%20Serif:ital,wght@0,400;1,700&amp;display=swap']){
   const tag=link(href),body=doc(tag+'<p>'+variable+'</p>'),r=make(brand,body);
   assert.deepEqual(GR.valida(r).erros,[]);assert.equal(P.plan(snapshot(r),G).eligible,true);assert.ok(G.html(r).includes(tag));
  }
  const badURLs=['http://fonts.googleapis.com/css2?'+font,'//fonts.googleapis.com/css2?'+font,'https://fonts.googleapis.com.evil.invalid/css2?'+font,'https://fonts.googleapis.com@evil.invalid/css2?'+font,'https://fonts.googleapis.com:443/css2?'+font,'https://fonts.googleapis.com/css?'+font,'https://fonts.googleapis.com/css2/../css2?'+font,prefix+font+'&redirect=https://evil.invalid',prefix+font+'&text=private',prefix+font+'&display=swap&display=block',prefix+font+'&display={{ .Tx.Data.first_name }}',prefix+'family=%7B%7B%20.Tx.Data.first_name%20%7D%7D',prefix+'family=Example%0AOther',prefix+'family=Example%ZZ',prefix+font+'#fragment',prefix+'display=swap',prefix+'family=Example%26redirect%3Dhttps%3A%2F%2Fevil.invalid'];
  for(const href of badURLs)assert.ok(GR.valida(make(brand,doc(link(href)))).erros.length,href);
  for(const tag of ['<link rel="preload" href="'+prefix+font+'">','<link rel="stylesheet" href="'+prefix+font+'" media="print">','<link rel="stylesheet" href="'+prefix+font+'" onload="alert(1)">','<link rel="stylesheet" href="'+prefix+font+'" href="https://evil.invalid">','<!--[if mso]>'+link(prefix+font)+'<![endif]-->','<link rel="stylesheet" href="javascript:alert(1)">','<link rel="stylesheet" href="data:text/css,p{}">','</link>'])assert.ok(GR.valida(make(brand,doc(tag))).erros.length,tag);
 });
 test(brand+' test plan forbids variables in attributes, comments, raw styles, scripts and declarations',()=>{
  const bad=['<p title="> '+variable+'">Text</p>',"<p title='> "+variable+"'>Text</p>",'<p title='+variable+'>Text</p>','<!-- '+variable+' -->','<!--[if mso]><p>'+variable+'</p><![endif]-->','<style>p{content:"'+variable+'"}</style>','<script>'+variable+'</script>','<img src="https://example.invalid/'+variable+'">','<p style="color:'+variable+'">Text</p>','<!doctype html PUBLIC "'+variable+'">','<p '+variable+'>Text</p>'];
  for(const part of bad){const r=make(brand,doc(part));let snap;try{snap=snapshot(r);}catch(_){continue;}assert.equal(P.plan(snap,G).eligible,false,part);}
  const dynamic=make(brand,'<a href="{{ .Tx.Data.order_url }}">Pedido</a>');assert.deepEqual(GR.valida(dynamic).erros,[]);assert.equal(P.plan(snapshot(dynamic),G).eligible,false);
  // An unrelated quoted greater-than does not hide subsequent legitimate text nodes.
  assert.equal(P.plan(snapshot(make(brand,doc('<p title=">">'+variable+'</p>'))),G).eligible,true);
 });
 test(brand+' active content, obfuscated protocols and malformed HTML stay blocked',()=>{
  for(const part of ['<base href="https://example.invalid">','<script>alert(1)</script>','<iframe src="https://example.invalid"></iframe>','<form><button>Go</button></form>','<img onerror="alert(1)">','<a href="javascript:alert(1)">Go</a>','<a href="java&#x73;cript:alert(1)">Go</a>','<a href="java&#10;script:alert(1)">Go</a>','<img src="data:image/png;base64,AA==">','<style>p{background:url(\\64 ata:image/png;base64,AA==)}</style>','<p style="width:expression(alert(1))">Text</p>','<a href="https://example.invalid"title="missing whitespace">Go</a>','<p title="unclosed > text</p>','<!-- unclosed','<style>p{color:red}','<svg><a href="https://example.invalid">Go</a></svg>'])assert.ok(GR.valida(make(brand,doc(part))).erros.length,part);
 });
}
test('lexical scan covers the 200k editor boundary and never interprets quoted tag text as a body or variable text',()=>{
 const body='<html><head><style>p:before{content:"<body>"}</style></head><body title="fake > <body>"><p>'+variable+'</p>'+' '.repeat(190000)+'</body></html>';
 const r=make('fish',body);assert.deepEqual(GR.valida(r).erros,[]);assert.equal(G.html(r),body.replace('<body title="fake > <body>">','<body title="fake > <body>">'+G.preheaderHTML(r)));assert.equal(P.plan(snapshot(r),G).eligible,true);
 assert.equal(G.htmlTokens('<p hidden title="a > b">x</p>').ok,true);
 // A quoted literal resembling tags is data, and is scanned once with its attribute.
 const quoted=make('fish','<p title="'+('<meta charset=bad '.repeat(10000))+'">Text</p>');assert.deepEqual(GR.valida(quoted).erros,[]);
});
