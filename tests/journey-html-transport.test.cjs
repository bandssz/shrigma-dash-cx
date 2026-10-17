'use strict';
const test=require('node:test'),a=require('node:assert/strict'),crypto=require('node:crypto');
const root=process.env.DASHBOARD_ACCESS_TEST_RUNTIME||require('node:path').resolve(__dirname,'../services/dashboard-operational');
const {createBindingReader}=require(root+'/journey-internal-test-binding.cjs');
const {createHtmlBindingReader,CONTRACT,TEMPLATE_BODY,TEMPLATE_SHA}=require(root+'/journey-internal-html-binding.cjs');
const {createHtmlTransport,createTransport,TARGET}=require(root+'/journey-internal-test-transport.cjs');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
for(const format of ['text','html'])test('an aliased private object cannot replace the approved From during template GET '+format,async()=>{
 const f=fixture(),html=format==='html',binding=html?f.args.binding:f.base.getBinding('aristo'),p=html?f.reader.privateApi(binding):f.base.privateApi(binding),calls=[];
 const send=(html?createHtmlTransport:createTransport)({confirmedSenders:{aristo:['avisos@oaristocrata.com']},privateApi:()=>p,fetchImpl:async(url,options)=>{calls.push(options.method);a.equal(options.method,'GET');p.fromEmail='contato@oaristocrata.com';return new Response(JSON.stringify({data:{id:binding.templateId,type:'tx',is_default:false,body:html?TEMPLATE_BODY:'{{ .Tx.Data.test_text }}'}}));}});
 if(!html)p.templateSha256=sha('{{ .Tx.Data.test_text }}');const args=html?f.args:{binding,recipient:f.args.recipient,subject:f.args.subject,text:f.args.text,preSend:()=>true};
 a.deepEqual(await send(args),{state:'not_sent',code:'TEST_BINDING_CHANGED'});a.deepEqual(calls,['GET']);
});
function fixture({brand='aristo',template={},duringGet,status=200}={}){
 const config={purpose:'crm.journey-internal-test',username:'synthetic-user',token:'SYNTHETIC-ONLY',templateId:116,templateSha256:'a'.repeat(64),from:{aristo:'Aristo <avisos@oaristocrata.com>',fish:'Fish <avisos@fishermans.com.br>'}};
 const env={DASHBOARD_JOURNEY_TEST_BINDING:JSON.stringify(config),DASHBOARD_JOURNEY_HTML_TEMPLATE:JSON.stringify({contract:CONTRACT,templateId:117,templateSha256:TEMPLATE_SHA})};
 const base=createBindingReader({env}),reader=createHtmlBindingReader({baseBinding:base,env}),calls=[];
 const args={binding:reader.getBinding(brand),recipient:'internal@oaristocrata.com',subject:'[TESTE] HTML interno',text:'Texto alternativo da etapa.',html:'<!doctype html><html><body><h1>Modelo sintético</h1><p>Peça completa.</p></body></html>',signal:new AbortController().signal,preSend:()=>true};args.htmlSha256=sha(args.html);
 const transport=createHtmlTransport({confirmedSenders:{fish:['avisos@fishermans.com.br'],aristo:['avisos@oaristocrata.com']},privateApi:reader.privateApi,fetchImpl:async(url,options)=>{calls.push({url,options});if(options.method==='GET'){await duringGet?.({env,config,args});return new Response(JSON.stringify({data:{id:117,type:'tx',body:TEMPLATE_BODY,is_default:false,...template}}));}return new Response(JSON.stringify({data:true}),{status});}});
 return {env,config,base,reader,calls,args,transport};
}
test('optional HTML metadata preserves the exact plaintext identity and descriptor',()=>{
 const f=fixture(),prior=f.base.getBinding('aristo'),before=JSON.stringify(f.base.privateApi(prior));
 for(const brand of ['aristo','fish']){const b=f.reader.getBinding(brand);a.equal(b.templateId,117);a.equal(b.format,'html');a(!JSON.stringify(b).includes('SYNTHETIC'));a.equal(f.reader.privateApi(b).token,f.config.token);}
 a.equal(JSON.stringify(f.base.privateApi(prior)),before);a.equal(f.base.getBinding('aristo').templateId,116);
 for(const value of [undefined,'',null,'{}',JSON.stringify({contract:CONTRACT,templateId:116,templateSha256:TEMPLATE_SHA}),JSON.stringify({contract:CONTRACT,templateId:117,templateSha256:'b'.repeat(64)}),JSON.stringify({contract:CONTRACT,templateId:117,templateSha256:TEMPLATE_SHA,token:'no'})]){f.env.DASHBOARD_JOURNEY_HTML_TEMPLATE=value;a.equal(f.reader.getBinding('aristo'),null);a.equal(JSON.stringify(f.base.privateApi(prior)),before);}
});
test('each brand sends the exact frozen HTML with explicit HTML MIME and alternate text',async()=>{
  for(const brand of ['aristo','fish']){const f=fixture({brand}),r=await f.transport(f.args);a.deepEqual(r,{state:'accepted'});a.deepEqual(f.calls.map(x=>x.options.method),['GET','POST']);a.equal(f.calls[1].url,TARGET+'/api/tx');const p=JSON.parse(f.calls[1].options.body);a.equal(p.content_type,'html');a.equal(p.data.test_html,f.args.html);a.equal(p.altbody,f.args.text);a.equal(p.from_email,f.config.from[brand]);a.deepEqual(p.headers,[{'Reply-To':'contato@'+(brand==='fish'?'fishermans.com.br':'oaristocrata.com')}]);a.equal(p.template_id,117);a.deepEqual(p.subscriber_emails,[f.args.recipient]);a.equal(p.subscriber_mode,'external');a.equal(p.data.test_brand,brand);}
});
test('wrong, default or altered template never reaches POST and never falls back to text',async()=>{
 for(const template of [{id:116},{is_default:true},{is_default:undefined},{type:'campaign'},{body:'{{ .Tx.Data.test_text }}'},{body:TEMPLATE_BODY+' '}]){const f=fixture({template});a.deepEqual(await f.transport(f.args),{state:'refused',code:'TEST_TEMPLATE_CONTRACT_REFUSED'});a.equal(f.calls.length,1);}
});
test('responsive CSS closing braces are sent unchanged in both brands',async()=>{
 for(const brand of ['aristo','fish']){const f=fixture({brand});f.args.html='<style>@media(max-width:600px){h1{font-size:20px}}</style><h1>Modelo</h1>';f.args.htmlSha256=sha(f.args.html);a.deepEqual(await f.transport(f.args),{state:'accepted'});a.equal(JSON.parse(f.calls[1].options.body).data.test_html,f.args.html);}
});
test('missing, oversized, changed or unresolved content is refused before any HTTP',async()=>{
 for(const change of [{html:undefined},{html:'<p>changed</p>'},{htmlSha256:'0'.repeat(64)},{html:'a'.repeat(200001)},{text:''},{subject:'[TESTE] {{ .Subscriber.Name }}'},{text:'{{ UnsubscribeURL }}'},{html:'<p>{{ .Tx.Data.first_name }}</p>'},{recipient:'customer@external.invalid'}]){const f=fixture();const r=await f.transport({...f.args,...change});a.equal(r.state,'refused');a.equal(f.calls.length,0);}
});
test('pause, abort and credential rotation during template GET prevent the POST',async()=>{
 for(const kind of ['pause','abort','rotation','metadata']){let paused=false;const controller=new AbortController(),f=fixture({duringGet:({env,config})=>{if(kind==='pause')paused=true;if(kind==='abort')controller.abort();if(kind==='rotation')env.DASHBOARD_JOURNEY_TEST_BINDING=JSON.stringify({...config,token:'SYNTHETIC-ROTATED'});if(kind==='metadata')env.DASHBOARD_JOURNEY_HTML_TEMPLATE='{}';}});f.args.signal=controller.signal;f.args.preSend=()=>!paused;
  const r=await f.transport(f.args);a.equal(r.state,'not_sent');a.equal(f.calls.length,1);
 }
});
test('possibly accepted HTML remains uncertain with one POST; no plaintext retry',async()=>{const f=fixture({status:503});a.deepEqual(await f.transport(f.args),{state:'uncertain'});a.equal(f.calls.filter(x=>x.options.method==='POST').length,1);});
test('plaintext transport refuses accidental HTML rather than silently ignoring it',async()=>{const f=fixture(),send=createTransport({privateApi:f.reader.privateApi,fetchImpl:async()=>{throw Error('must-not-call');}});a.deepEqual(await send(f.args),{state:'refused',code:'TEST_HTML_CONTENT_REFUSED'});});
