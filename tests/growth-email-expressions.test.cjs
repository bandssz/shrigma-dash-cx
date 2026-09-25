'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const E=require('../growth-email-expressions.js');
const context=extra=>({Tx:{Data:{first_name:'Érica',has_discount:false,items_count:0,items:[],...extra}},Subscriber:{Name:'Pessoa sintética',UUID:'00000000-0000-4000-8000-000000000000'}});
const pass=(s,html=true)=>{const p=E.parse(s,{html});assert.equal(p.ok,true,JSON.stringify(p.errors));return p;};
const reject=(s,code,html=true)=>{const p=E.parse(s,{html});assert.equal(p.ok,false,s);if(code)assert.equal(p.errors[0].code,code);assert.equal(p.actions.length,0);return p;};

test('AST covers observed if/or/default/upper/range/else with exact dependencies',()=>{
 const s='<p>{{ if or .Tx.Data.delivered_at .Tx.Data.delivered_by }}Entregue{{ else }}Olá {{ .Tx.Data.first_name | upper }}{{ end }}</p>{{ range .Tx.Data.items }}<p>{{ if .name }}{{ .name }}{{ else }}{{ .title }}{{ end }} · {{ default 1 .quantity }} · {{ default "R$ 0,00" .price }}</p>{{ else }}<p>Sem itens</p>{{ end }}';
 const p=pass(s);assert.deepEqual(p.keys,['delivered_at','delivered_by','first_name','items']);assert.deepEqual(p.fields,['.Tx.Data.delivered_at','.Tx.Data.delivered_by','.Tx.Data.first_name','.Tx.Data.items','.name','.title','.quantity','.price']);
 assert.equal(p.ast.filter(n=>n.type==='range').length,1);assert.equal(p.actions.filter(a=>a.kind==='if').length,2);assert.ok(p.actions.some(a=>a.expression?.type==='upper'));
 assert.equal(p.safetySource.length,s.length);for(const a of p.actions)assert.equal(s.slice(a.start,a.start+2),'{{');
});
test('synthetic fixture covers every field and helper form in the 33-template aggregate',()=>{
 const names=('address cancel_reason carrier checkout_url coupon_code coupon_heading coupon_text coupon_value cta_text delivered_at delivered_by delivery_estimate e first_name has_discount headline items_count last_update nps_url order_number order_url p paragraph_1 paragraph_2 paragraph_3 paragraph_4 payment_deadline payment_method preheader refund_method refund_status review_url s shipping_label shipping_name shipping_value status subtotal total tracking_company tracking_number tracking_status tracking_updated_at tracking_url urgency_text urgency_title').split(' ');
 const source=names.map(k=>'{{ if .Tx.Data.'+k+' }}{{ .Tx.Data.'+k+' }}{{ else }}{{ default "Exemplo sintético" .Tx.Data.'+k+' }}{{ end }}').join('')+'{{ if .Tx.Data.items }}{{ range .Tx.Data.items }}'+['image','name','price','qty','quantity','title','variant'].map(k=>'{{ if .'+k+' }}{{ .'+k+' }}{{ else }}{{ default '+(['qty','quantity'].includes(k)?'1':'"Exemplo sintético"')+' .'+k+' }}{{ end }}').join('')+'{{ end }}{{ end }}';
 const p=pass(source);assert.equal(p.keys.length,names.length+1);assert.equal(p.fields.length,names.length+8);assert.equal(p.actions.filter(a=>a.expression?.type==='default').length,names.length+7);
});
test('simple prior custom Data fields remain parseable but not invented in preview context',()=>{
 assert.deepEqual(pass('{{ .Tx.Data.custom_existing }}',false).keys,['custom_existing']);
 assert.throws(()=>E.buildPreviewEnvelope('<p>{{ .Tx.Data.custom_existing }}</p>',context()),/EMAIL_CONTEXT_FIELD/);
});
test('Subscriber roots and item scope are explicit; range else restores outer scope',()=>{
 assert.deepEqual(pass('{{ .Subscriber.Name }} {{ .Subscriber.UUID }}',false).fields,['.Subscriber.Name','.Subscriber.UUID']);
 pass('{{ range .Tx.Data.items }}{{ .image }}{{ .variant }}{{ .qty }}{{ else }}{{ .Tx.Data.first_name }}{{ end }}');
 for(const s of ['{{ .name }}','{{ .Subscriber.Email }}','{{ .Tx.Data.items }}'])reject(s);
 reject('{{ range .Tx.Data.items }}{{ .Tx.Data.first_name }}{{ end }}','EMAIL_EXPRESSION_SCOPE');
 reject('{{ range .Tx.Data.items }}{{ range .Tx.Data.items }}{{ end }}{{ end }}','EMAIL_EXPRESSION_RANGE');
 reject('{{ range .Tx.Data.items }}{{ else }}{{ .name }}{{ end }}','EMAIL_EXPRESSION_FIELD');
});
test('Go lexer preserves strings, escaped quotes, braces, Unicode and exact literal offsets',()=>{
 const s='<a href="{{ default "https://example.invalid/a?x=}}&name=\\\"q\\\"" .Tx.Data.checkout_url }}">{{ default "Ol\\u00e1 \\U0001F600 \\x41 \\101" .Tx.Data.first_name }}</a>';
 const p=pass(s);assert.equal(p.attributes[0].name,'href');assert.equal(s.slice(p.attributes[0].valueStart,p.attributes[0].valueEnd),'{{ default "https://example.invalid/a?x=}}&name=\\\"q\\\"" .Tx.Data.checkout_url }}');
 assert.equal(p.literals[1].value,'Olá 😀 A A');assert.equal(s.slice(p.literals[1].start,p.literals[1].end),p.actions[1].tokens[1].type==='string'?'"Ol\\u00e1 \\U0001F600 \\x41 \\101"':'');
 assert.equal(p.actions[0].context.type,'attribute');assert.equal(p.actions[1].context.type,'text');
 for(const lit of ['"\\q"','"\\uD800"','"\\U00110000"','"\\xff"','"\\777"','"line\nbreak"'])reject('{{ default '+lit+' .Tx.Data.first_name }}');
});
test('whitespace trimming is recorded; no unsupported controls, helpers, variables or method access',()=>{
 const p=pass('a {{- if .Tx.Data.first_name -}}Hi{{- else -}}No{{- end -}}');assert.ok(p.actions.every(a=>a.trimLeft&&a.trimRight));
 const cases=['{{ Safe .Tx.Data.first_name }}','{{ env "KEY" }}','{{ .Tx.Data.first_name | lower }}','{{ .Tx.Data.order_number | upper }}','{{ default (env "X") .Tx.Data.first_name }}','{{ with .Tx.Data }}x{{ end }}','{{ define "x" }}x{{ end }}','{{ template "x" }}','{{ block "x" . }}{{ end }}','{{ $x := .Tx.Data.first_name }}','{{ .Tx.Data.constructor }}','{{ .Tx.Data.first_name.method }}','{{ index .Tx.Data "secret" }}','{{ default true .Tx.Data.has_discount }}','{{ if or .Tx.Data.first_name }}x{{ end }}','{{ range .Tx.Data.orders }}{{ end }}'];
 for(const s of cases)reject(s);
});
test('controls must balance and malformed closers fail except literal CSS braces',()=>{
 for(const s of ['{{','{{ }}','{{ .Tx.Data.first_name }','{{ else }}','{{ end }}','{{ if .Tx.Data.first_name }}x','{{ if .Tx.Data.first_name }}x{{ else }}y{{ else }}z{{ end }}','x}}'])reject(s);
 pass('<style>@media(min-width:1px){p{color:red}}</style><p>{{ .Tx.Data.first_name }}</p>');
});
test('actions cannot synthesize tags/attribute names, unquoted values, CSS, script, comments or metadata',()=>{
 const cases=['<{{ .Tx.Data.first_name }}>','<a {{ .Tx.Data.first_name }}="x">x</a>','<a hr{{ .Tx.Data.first_name }}ef="x">x</a>','<a href={{ .Tx.Data.order_url }}>x</a>','<a {{ if .Tx.Data.first_name }}href="x"{{ end }}>x</a>','<p style="color:{{ .Tx.Data.first_name }}">x</p>','<style>p{color:{{ .Tx.Data.first_name }}}</style>','<script>{{ .Tx.Data.first_name }}</script>','<!-- {{ .Tx.Data.first_name }} -->','<!doctype {{ .Tx.Data.first_name }}>','<meta content="{{ .Tx.Data.first_name }}">','<link href="{{ .Tx.Data.order_url }}">','<p onclick="{{ .Tx.Data.first_name }}">x</p>'];
 for(const s of cases)reject(s);
});
test('quoted URL and text attributes keep original ranges despite Go literals and branches',()=>{
 const s='<a href="{{ if .Tx.Data.order_url }}{{ .Tx.Data.order_url }}{{ else }}https://example.invalid/{{ end }}?u={{ .Subscriber.UUID }}" title="{{ default "Olá" .Tx.Data.first_name }}">X</a><img src="{{ .Tx.Data.checkout_url }}" alt="Foto">';
 const p=pass(s);assert.deepEqual(p.attributes.map(a=>a.name),['href','title','src','alt']);assert.ok(p.actions.slice(0,5).every(a=>a.context.name==='href'));
 const masked=p.safetySource;for(const a of p.attributes)assert.equal(masked[a.valueStart-1],a.quote);
});
test('all control paths must join in the same HTML context',()=>{
 pass('{{ if .Tx.Data.first_name }}<p>A</p>{{ else }}<div>B</div>{{ end }}');
 reject('{{ if .Tx.Data.first_name }}<a href="{{ else }}plain{{ end }}','EMAIL_EXPRESSION_BRANCH_CONTEXT');
 reject('{{ if .Tx.Data.first_name }}<a href="{{ end }}','EMAIL_EXPRESSION_BRANCH_CONTEXT');
 reject('<a href="{{ range .Tx.Data.items }}{{ .name }}{{ end }}">x</a>','EMAIL_EXPRESSION_RANGE_CONTEXT');
});
test('bounded source, strings, actions and nesting fail closed with source-free errors',()=>{
 reject('x'.repeat(E.LIMITS.source+1),'EMAIL_EXPRESSION_SOURCE');
 reject('{{ .Tx.Data.first_name }}'.repeat(E.LIMITS.actions+1),'EMAIL_EXPRESSION_LIMIT');
 reject('{{ if .Tx.Data.first_name }}'.repeat(E.LIMITS.depth+1)+'{{ end }}'.repeat(E.LIMITS.depth+1),'EMAIL_EXPRESSION_DEPTH');
 reject('{{ default "'+'a'.repeat(E.LIMITS.string+1)+'" .Tx.Data.first_name }}');
 const r=reject('{{ env "SECRET_SENTINEL" }}');assert.ok(!JSON.stringify(r.errors).includes('SECRET_SENTINEL'));
 for(const s of ['\0','\ud800','\udc00'])reject(s,'EMAIL_EXPRESSION_SOURCE');
});
test('typed context permits empty, missing, zero and false without JS default semantics',()=>{
 const c=context({first_name:'',items_count:0,has_discount:false,total:null,items:[{qty:0,quantity:0,name:'',price:'0',image:''}]});const r=E.validateContext(c);assert.equal(r.ok,true);assert.deepEqual(r.value,c);
 const w=E.buildPreviewEnvelope('<p>{{ default "Oi" .Tx.Data.first_name }}{{ if .Tx.Data.has_discount }}Sim{{ end }}{{ range .Tx.Data.items }}{{ default 1 .qty }}{{ end }}</p>',c);
 assert.ok(w.includes('"has_discount" false'));assert.ok(w.includes('"items_count" 0'));assert.ok(w.includes('"total" nil'));assert.ok(w.includes('{{ default 1 .qty }}'));assert.ok(w.startsWith('{{ with (dict '));assert.ok(w.endsWith('{{ end }}'));
 for(const items of [[],[{qty:0}],[{qty:0},{qty:1}]])assert.ok(E.buildPreviewEnvelope('{{ default "Sem desconto" .Tx.Data.has_discount }}{{ range .Tx.Data.items }}{{ default 1 .qty }}{{ else }}Vazio{{ end }}',context({items})));
});
test('preview context rejects unknown keys, objects, invalid URLs, oversized items and prototype tricks',()=>{
 for(const data of [{custom:'x'},{items:'x'},{items:Array(21).fill({})},{items:[{secret:'x'}]},{items:[{qty:'1'}]},{has_discount:'false'},{items_count:-1},{first_name:{}},{first_name:()=>1},{order_url:'javascript:alert(1)'},{order_url:'http://example.invalid/'},{order_url:'https://u:p@example.invalid/'},{order_url:'https://example.invalid/\\path'},{order_url:'https://example.invalid/{{env}}'}])assert.equal(E.validateContext(context(data)).ok,false,JSON.stringify(data));
 assert.equal(E.validateContext({...context(),unknown:1}).ok,false);assert.equal(E.validateContext({Tx:{Data:Object.create({first_name:'x'})},Subscriber:{}}).ok,false);
 assert.equal(E.validateContext(JSON.parse('{"Tx":{"Data":{"__proto__":"x"}},"Subscriber":{}}')).ok,false);
 assert.equal(E.validateContext(context({order_url:'https://example.invalid/path?a=1&b=2'})).ok,true);
});
test('Subscriber is explicit and does not imply real-recipient authorization',()=>{
 const external={Tx:{Data:{}},Subscriber:{Name:'',UUID:''}};assert.equal(E.validateContext(external).ok,true);assert.ok(E.buildPreviewEnvelope('<p>{{ .Subscriber.UUID }}</p>',external));
 assert.throws(()=>E.buildPreviewEnvelope('{{ .Subscriber.UUID }}',{Tx:{Data:{}},Subscriber:{}}),/EMAIL_CONTEXT_SUBSCRIBER_REQUIRED/);
 assert.equal(E.validateContext({Tx:{Data:{}},Subscriber:{UUID:'not-a-uuid'}}).ok,false);
});
test('context strings remain quoted data and source is embedded byte for byte',()=>{
 const value='" }}{{ env "DO_NOT_RUN" }} <script>& \\ fim',source='<p>{{ .Tx.Data.first_name }}</p>';
 const wrapper=E.buildPreviewEnvelope(source,context({first_name:value}));assert.ok(wrapper.includes(JSON.stringify(value)));assert.ok(wrapper.endsWith(' }}'+source+'{{ end }}'));
 const injection=E.parse(wrapper);assert.equal(injection.ok,false);assert.ok(!('render' in E));assert.ok(!('eval' in E));
});
test('preview bounds repeated output before the native request without evaluating Go',()=>{
 const s='{{ range .Tx.Data.items }}'+'{{ .name }}'.repeat(100)+'{{ end }}';
 assert.throws(()=>E.buildPreviewEnvelope(s,context({items:Array(8).fill({name:'x'.repeat(4000)})})),/EMAIL_CONTEXT_OUTPUT_LIMIT/);
 assert.ok(E.buildPreviewEnvelope(s,context({items:[{name:'Item A'},{name:'Item B'}]})).includes(s));
});
test('browser module exposes the same parser without Node globals or dynamic code execution',()=>{
 const sandbox={URL};vm.createContext(sandbox,{codeGeneration:{strings:false,wasm:false}});vm.runInContext(fs.readFileSync(require.resolve('../growth-email-expressions.js'),'utf8')+';globalThis.api=GEE;',sandbox);
 assert.equal(sandbox.api.parse('<p>{{ .Tx.Data.first_name }}</p>',{html:true}).ok,true);
 assert.equal(sandbox.api.parse('<a href="{{ env "x" }}">X</a>',{html:true}).ok,false);
});
