'use strict';
const {test}=require('node:test'),a=require('node:assert/strict'),p=require('node:path'),root=process.env.CRM_EDITORIAL_TEST_ROOT||p.resolve(__dirname,'..'),runtime=process.env.DASHBOARD_ACCESS_TEST_RUNTIME||p.join(root,'services/dashboard-operational'),P=require(runtime+'/campaign-editorial-policy.cjs'),footer='<a href="{{ UnsubscribeURL }}">Sair</a>';
const check=(html,extra={})=>P.review({html:html+'\n'+footer,brand:'aristo',...extra});
for(const [name,html]of [
 ['script','<script>alert(1)</script>'],
 ['event on its actual line','<div\n class="a"\n onclick="go()">Oi</div>'],
 ['entity protocol','<a href="java&#115;cript:alert(1)">Abrir</a>'],
 ['CSS escapes',String.raw`<style>p{width:e\78 pression(alert(1))}</style>`],
 ['CSS URL escapes',String.raw`<p style="background:url(\6a avascript:alert(1))">Oi</p>`],
 ['iframe encoded srcdoc','<iframe srcdoc="&lt;script&gt;bad()&lt;/script&gt;"></iframe>'],
 ['SVG executable destination','<svg><a xlink:href="javascript:bad()">x</a></svg>'],
 ['conditional Outlook content','<!--[if mso]><script>bad()</script><![endif]-->']
])test('blocks script: '+name,()=>{const r=check(html);a.equal(r.ok,false);a(r.diagnostics.some(d=>d.code==='SCRIPT'&&d.severity==='block'));if(name==='event on its actual line')a.equal(r.diagnostics.find(d=>d.code==='SCRIPT').line,3);});
for(const [name,html,code]of [
 ['automatic meta','<meta http-equiv="REFRESH" content="0;url=/collections/black">','REDIRECT'],
 ['encoded automatic meta','<meta http-equiv="ref&#114;esh" content="0">','REDIRECT'],
 ['other-brand link','<a href="https://fishermans.com.br/products/x">x</a>','OUTSIDE_STORE'],
 ['outside form','<form action="https://evil.example/"></form>','OUTSIDE_STORE'],
 ['outside object','<object data="https://evil.example/"></object>','OUTSIDE_STORE'],
 ['insecure literal placeholder hostname','<a href="http://shrigmadynamicdestination.evil.example/">x</a>','OUTSIDE_STORE'],
 ['nondefault port','<a href="https://oaristocrata.com:80/products/x">x</a>','OUTSIDE_STORE'],
 ['outside coupon redirect','<a href="https://oaristocrata.com/discount/A?redirect=https%3A%2F%2Fevil.example%2Fx">x</a>','REDIRECT'],
 ['encoded nested redirect','<a href="https://oaristocrata.com/discount/A?redirect=%252F%252Fevil.example%252Fx">x</a>','REDIRECT'],
 ['redirect port','<a href="https://oaristocrata.com/discount/A?redirect=https%3A%2F%2Foaristocrata.com%3A444%2Fproducts%2Fx">x</a>','REDIRECT'],
 ['malformed prefix cannot hide later redirect','<broken = x>\n<meta http-equiv=refresh content=0>','REDIRECT'],
 ['malformed prefix cannot hide later other-brand link','<broken = x>\n<a href=https://fishermans.com.br/>x</a>','OUTSIDE_STORE']
])test('blocks only navigation classes: '+name,()=>{const r=check(html);a.equal(r.ok,false);a(r.diagnostics.some(d=>d.code===code&&d.severity==='block'));});
for(const [name,html]of [
 ['forms and inputs to the own store','<form action="/products/x"><input name="email"></form>'],
 ['external fonts','<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">'],
 ['native expressions','{{ if .Subscriber.Attribs.vip }}<p>Olá</p>{{ end }}'],
 ['coupon without destination','<a href="https://oaristocrata.com/discount/BLACK">Aplicar</a>'],
 ['tracking conflict','<a href="https://oaristocrata.com/products/x?utm_campaign=older&only=true">x</a>'],
 ['ordinary comments are inert','<!-- <script>example()</script><a href="https://evil.example/">example</a> -->'],
 ['prose is not an event','<p>Use onload= apenas como texto e javascript: como exemplo.</p>'],
 ['inert srcdoc attribute','<p srcdoc="&lt;script&gt;example()&lt;/script&gt;">Oi</p>'],
 ['own store base and relative links','<base href="https://oaristocrata.com/collections/"><a href="black">Black</a>'],
 ['same-store coupon routing','<a href="https://oaristocrata.com/discount/A?redirect=%2Fcollections%2Fblack">Black</a>'],
 ['HTML outside an old document regex','<html><body><header>Oi</header></body></html>']
])test('remaining editorial findings never block: '+name,()=>{const r=check(html,{campaign:'lm-270'});a.equal(r.ok,true);a(r.diagnostics.every(d=>d.severity==='warning'));});
test('plain-text external warnings retain independent real lines and never collapse to HTML line1',()=>{const r=check('<p>Oi</p>',{text:'Olá\nhttps://external.example/a\nTexto\nhttps://external.example/b'}),issues=r.diagnostics.filter(d=>d.field==='text');a.equal(r.ok,true);a.deepEqual(issues.map(d=>d.line),[2,4]);a(issues.every(d=>d.code==='EXTERNAL_CTA'&&d.severity==='warning'));});
test('brand isolation uses the actual destination, not a hostname substring',()=>{a.equal(P.review({brand:'fish',html:'<a href="https://oaristocrata.com/products/x">x</a>'+footer}).ok,false);a.equal(P.review({brand:'fish',html:'<a href="https://fishermans.com.br/products/x">x</a>'+footer}).ok,true);});
test('diagnostic cap cannot conceal a later blocking class',()=>{const html=Array.from({length:210},()=>'<iframe></iframe>').join('\n')+'\n<script>bad()</script>',r=check(html);a.equal(r.ok,false);a.equal(r.truncated,true);a(r.diagnostics.some(d=>d.code==='SCRIPT'));a(r.diagnostics.length<=200);});
for(const prefix of ['<!-- texto --!>','<!-->','<!--->'])for(const [suffix,code]of [['<script>bad()</script>','SCRIPT'],['<meta http-equiv=refresh content=0>','REDIRECT'],['<a href="https://fishermans.com.br/">x</a>','OUTSIDE_STORE']])test('HTML abrupt comment cannot hide '+code+' after '+prefix,()=>{const r=check(prefix+suffix);a.equal(r.ok,false);a(r.diagnostics.some(d=>d.code===code&&d.severity==='block'));});
for(const tag of ['textarea','title','iframe','xmp','noembed','noframes','plaintext'])test('raw/RCDATA '+tag+' keeps literal scripts inert',()=>a.equal(check('<'+tag+'><script>example()</script></'+tag+'>').ok,true));
test('CSS continuation keeps executable URL visible while literal content stays inert',()=>{a.equal(check('<style>p{background:url("java\\\nscript:bad()");}</style>').ok,false);a.equal(check('<style>p:after{content:"javascript: expression() /*";} p{color:red}</style>').ok,true);a.equal(check('<style>p{content:"broken\n; width:expression(bad());}</style>').ok,false);});
for(const brand of ['aristo','fish'])test('dynamic values cannot hide a static external destination or redirect '+brand,()=>{
 const store=P.STORES[brand],variable='{{ .Subscriber.Name }}';
 for(const [html,code]of [['<a href="https://foreign.example/offers?name='+variable+'">x</a>','OUTSIDE_STORE'],['<a href="https://'+store+'/discount/A?redirect=https%3A%2F%2Fforeign.example%2F'+variable+'">x</a>','REDIRECT'],['<a href="https://foreign.example/'+variable+'">x</a>','OUTSIDE_STORE'],['<a href="{{ .Subscriber.Attribs.scheme }}://foreign.example/offers">x</a>','OUTSIDE_STORE']]){const r=P.review({brand,html});a.equal(r.ok,false);a(r.diagnostics.some(d=>d.code===code&&d.severity==='block'));}
 for(const html of ['<a href="https://'+store+'/products/'+variable+'">x</a>','<a href="https://'+store+'/discount/A?redirect=%2Fcollections%2F'+variable+'">x</a>','<a href="https://{{ .Subscriber.Attribs.host }}/offers">x</a>','<a href="{{ .Subscriber.Attribs.scheme }}://'+store+'/offers">x</a>']){const r=P.review({brand,html});a.equal(r.ok,true);a(r.diagnostics.some(d=>d.code==='DYNAMIC_DESTINATION'));}
});
for(const [name,html,blocked]of [
 ['SVG title integration','<svg><title><script>bad()</script></title></svg>',true],
 ['SVG desc integration','<svg><desc><script>bad()</script></desc></svg>',true],
 ['SVG foreign style','<svg><style><script>bad()</script></style></svg>',true],
 ['self-closing foreign title','<svg><title/><script>bad()</script></svg>',true],
 ['MathML title remains foreign','<math><title><script>bad()</script></title></math>',true],
 ['MathML text integration','<math><mtext><script>bad()</script></mtext></math>',true],
 ['MathML HTML annotation','<math><annotation-xml encoding="text/html"><script>bad()</script></annotation-xml></math>',true],
 ['HTML title after foreign breakout','<svg><p><title><script>literal()</script></title>',false],
 ['HTML title after foreign end p breakout','<svg></p><title><script>literal()</script></title>',false],
 ['HTML title after foreign end br breakout','<svg></br><title><script>literal()</script></title>',false],
 ['HTML title inside foreignObject','<svg><foreignObject><title><script>literal()</script></title></foreignObject></svg>',false],
 ['closed foreign style cannot consume later text','<svg><style/><text>expression(1)</text></svg>',false],
 ['self-closing HTML textarea remains raw','<textarea/><script>literal()</script>',false],
 ['HTML title inside MathML text','<math><mtext><title><script>literal()</script></title></mtext></math>',false]
])test('namespace preserves executable versus literal tags: '+name,()=>{const r=check(html);a.equal(r.ok,!blocked);a.equal(r.diagnostics.some(d=>d.code==='SCRIPT'&&d.severity==='block'),blocked);});
for(const editorialMode of ['legacy','gateway'])test('gateway keeps sticky internal TEST classification and schedule denial in '+editorialMode,()=>{
 const C=require(runtime+'/campaign-write-contract.js'),d={schema_version:C.VERSION,brand:'aristo',channel:'email',initiative:{key:'internal-proof',name:'Internal proof'},utm_campaign:'internal-proof',name:'Internal proof',subject:'[TESTE] Internal proof',from_email:'synthetic@oaristocrata.com',reply_to:'synthetic@oaristocrata.com',list_ids:[16],template_id:1,html:'<a href="https://oaristocrata.com/products/x">Produto</a><a href="{{ UnsubscribeURL }}">Sair</a>',text:'https://oaristocrata.com/products/x {{ UnsubscribeURL }}',tags:[],send_at:null};
 const normalized=C.normalize(d,{editorialMode});a(normalized.tags.includes('crm-internal-test'));const current={id:270,definition:{...normalized,subject:'Subject changed'},status:'draft',sent:0,started_at:null};a.equal(C.isInternalTest(current),true);a.throws(()=>C.schedule({confirm:'agendar'},current,{canPublish:true}),{code:'TEST_CAMPAIGN_INTERNAL_ONLY'});a.equal(C.isInternalTest({id:185,definition:{brand:'aristo'}}),true);a.equal(C.isInternalTest({id:185,definition:{brand:'fish'}}),false);
});
for(const brand of ['aristo','fish'])test('admitted tracking and explicit restricted adjustment preserve whole template expressions '+brand,()=>{
 const T=require(runtime+'/campaign-write-tracking.js'),store=P.STORES[brand],list=brand==='aristo'?16:17;
 for(const body of ['<a href="https://'+store+'/products/{{ .Subscriber.Attribs.handle }}?utm_campaign=old">Oferta</a>','{{ printf "https://'+store+'/pages/%s?utm_campaign=old" .Subscriber.Attribs.page }}','<a href="https://'+store+'/discount/BLACK?redirect={{ .Subscriber.Attribs.destination }}">Cupom</a>','{{ printf "}} https://'+store+'/pages/%s?utm_campaign=old" .Subscriber.Attribs.page }}','{{ printf `}} https://'+store+'/pages/%s?utm_campaign=old` .Subscriber.Attribs.page }}','{{/* }} https://'+store+'/pages/example?utm_campaign=old */}}']){
  const input={id:701,status:'draft',sent:0,started_at:null,send_at:null,content_type:'html',body_source:null,lists:[{id:list}],body,altbody:body},opts={brand,campaign:'lm-701'},prepared=T.prepareAdmitted(input,opts);a.equal(prepared.body,body);a.equal(prepared.altbody,body);a.deepEqual(prepared.changes,[]);
  const adjusted=T.adjust({body,altbody:body},{...opts,preserveTemplates:true});a.equal(adjusted.body,body);a.equal(adjusted.altbody,body);a.equal(adjusted.changes,0);a.deepEqual(T.review({body,altbody:body},{...opts,preserveTemplates:true}).issues,[]);
 }
});
for(const brand of ['aristo','fish'])test('native static TrackLink is inspected as its literal destination with original lines '+brand,()=>{
 const store=P.STORES[brand];
 for(const wrapper of [url=>'{{ TrackLink "'+url+'" }}',url=>'{{- TrackLink `'+url+'` -}}']){
  for(const quote of ['"',"'",'']){
   const html=url=>'<p>Primeira linha</p>\n<a href='+quote+wrapper(url)+quote+'>Oferta</a>\n'+footer;
   a.equal(P.review({brand,html:html('https://'+store+'/pages/black')}).ok,true);
   for(const [url,code]of [['https://'+P.STORES[brand==='aristo'?'fish':'aristo']+'/pages/black','OUTSIDE_STORE'],['javascript:bad()','SCRIPT'],['https://'+store+'/discount/A?redirect=https%3A%2F%2Fforeign.example%2Fpages%2Fx','REDIRECT']]){const r=P.review({brand,html:html(url)});a.equal(r.ok,false);a(r.diagnostics.some(d=>d.code===code&&d.line===2&&d.severity==='block'));}
  }
 }
 const r=P.review({brand,html:'<a href="{{ TrackLink .Subscriber.Attribs.url }}">Oferta</a>'+footer});a.equal(r.ok,true);a(r.diagnostics.some(d=>d.code==='DYNAMIC_DESTINATION'));
 for(const [url,ok]of [['https://'+store+'/pages/black',true],['https://foreign.example/pages/black',true],['javascript:bad()',false]]){const r=P.review({brand,html:footer,text:'Olá\n{{ TrackLink "'+url+'" }}'});a.equal(r.ok,ok);if(!ok)a(r.diagnostics.some(d=>d.field==='text'&&d.line===2&&d.severity==='block'));}
 const unknown=P.review({brand,html:footer,text:'{{ printf "https://foreign.example/%s" .Subscriber.Attribs.page }}'});a.equal(unknown.ok,true);a(unknown.diagnostics.some(d=>d.code==='TEMPLATE_EXPRESSION'&&d.field==='text'));
 const nested=P.review({brand,html:footer,text:'https://'+store+'/products/{{ printf "https://foreign.example" }}'});a.equal(nested.ok,true);a(nested.diagnostics.some(d=>d.code==='DYNAMIC_DESTINATION'&&d.field==='text'));a(!nested.diagnostics.some(d=>d.severity==='block'));
 for(const [url,code]of [['https://'+P.STORES[brand==='aristo'?'fish':'aristo']+'/pages/x?q=&quot;','OUTSIDE_STORE'],['javascript:bad(&quot;x&quot;)','SCRIPT']]){const r=P.review({brand,html:"<a href='{{ TrackLink \""+url+"\" }}'>x</a>"+footer});a.equal(r.ok,false);a(r.diagnostics.some(d=>d.code===code&&d.severity==='block'));}
});
for(const brand of ['aristo','fish'])test('admitted tracking preserves a native static TrackLink wrapper while setting tracking '+brand,()=>{
 const T=require(runtime+'/campaign-write-tracking.js'),store=P.STORES[brand],list=brand==='aristo'?16:17;
 for(const [prefix,suffix]of [['{{ TrackLink "','" }}'],['{{- TrackLink `','` -}}']]){const url='https://'+store+'/pages/black?utm_term=experiment',body=prefix+url+suffix,input={id:701,status:'draft',sent:0,started_at:null,content_type:'html',body_source:null,lists:[{id:list}],body,altbody:body},r=T.prepareAdmitted(input,{brand,campaign:'lm-701'});a(r.body.startsWith(prefix));a(r.body.endsWith(suffix));for(const [field,content]of [['body','link'],['altbody','alt-link']]){a(r[field].startsWith(prefix));a(r[field].endsWith(suffix));const u=new URL(r[field].slice(prefix.length,-suffix.length));a.equal(u.searchParams.get('utm_campaign'),'lm-701');a.equal(u.searchParams.get('utm_content'),content);}a.equal(r.changes.length,2);}
});
