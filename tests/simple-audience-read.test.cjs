'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const runtime=process.env.DASHBOARD_ACCESS_TEST_RUNTIME||path.resolve(__dirname,'../services/dashboard-operational');
const {createReader}=require(runtime+'/simple-dashboard-read.cjs'),P=require(runtime+'/proxy.cjs');
const KEY='synthetic-service-read-key',STAMP='2026-10-13T09:00:00.000Z',ID='00000000-0000-4000-8000-000000000001';
function fixture({brand='fish',front='growth',mixed=false,refused=false,revoke=false,missing=false,dnsFailures=0,dnsRevoke=false}={}){
 let calls=0,active=true;
 const user={id:'synthetic-reader',role:'manager',areas:[front],permissions:{growth:{read:true,edit:false}},productFronts:[front],brands:[brand],jobTitle:'gestor de CRM'};
 const auth={authorize(){return user},authorizeBrand(_ctx,b){if(!active||front!=='growth'||b!==brand)throw Object.assign(Error('ACCESS_DENIED'),{code:'ACCESS_DENIED',status:403});return user}};
 const row={id:ID,brand,name:'Público sintético',definition:{schema_version:'crm-audience-v2',brand,name:'Público sintético',rule:{op:'in_list',list_id:17}},version:1,archived:false,created_at:STAMP,updated_at:STAMP,updated_by:'panel:'+KEY,semantic_context:{currency:'BRL',timezone:'America/Sao_Paulo',current:true}};
 const catalog={brand,current:true,currency:'BRL',timezone:'America/Sao_Paulo',shop_id:null,fields:[],products:[],origins:[],lists:[{id:17,brand,name:'Lista sintética',available:true}],coverage:'unconfirmed',checked_at:STAMP,catalog_hash:'a'.repeat(64)};
 const upstreams={segments:new URL(P.REVIEWED_DYNAMIC.routes.segments),'crm-read':new URL(P.FIXED_DESTINATIONS['crm-read'])};
 const reader=createReader({auth,upstreams,keys:{growth:'synthetic-cache-only-key',...(!missing?{audiences:KEY}:{})},projectGrowth:()=>({brand}),fetchImpl:async(url,options)=>{
  calls++;if(calls<=dnsFailures){if(dnsRevoke)active=false;throw Object.assign(new TypeError('private synthetic diagnostics'),{cause:{code:'EAI_AGAIN'}});}assert.equal(options.method,'GET');const q=new URL(url).searchParams;assert.equal(options.headers.Authorization,'Bearer '+(q.get('action')==='cache_growth'?'synthetic-cache-only-key':KEY));
  if(q.get('action')==='cache_growth')return new Response('{}',{headers:{'content-type':'application/json'}});
  if(refused)return new Response(JSON.stringify({error:'SEGMENT_ACCESS_DENIED'}),{status:403,headers:{'content-type':'application/json'}});
  const body=q.get('acao')==='segmento_obter'?{segment:{...row}}:{segments:[{...row}],limit:Number(q.get('limit')),offset:Number(q.get('offset')),catalog,capabilities:{draft:true,count:true,send:false}};
  if(mixed)(body.segment||body.segments[0]).brand=brand==='fish'?'aristo':'fish';if(revoke)active=false;
  return new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
 }});
 return {reader,calls:()=>calls,brand};
}
const request=(f,action='segmentos_listar',extra={})=>f.reader.read({context:{},route:'segments',method:'GET',query:new URLSearchParams({acao:action,brand:f.brand,...(action==='segmentos_listar'?{limit:'50',offset:'0'}:{id:ID}),...extra}),origin:'https://crm.synthetic.invalid'});
test('both brands load definitions and retain original COUNT without promoting writes',async()=>{for(const brand of ['fish','aristo']){const f=fixture({brand}),list=await request(f),get=await request(f,'segmento_obter');assert.equal(list.status,200);assert.equal(get.body.segment.id,list.body.segments[0].id);assert.deepEqual(list.body.capabilities,{draft:false,count:true,send:false});assert.equal(list.body.segments[0].updated_by,'Equipe CRM');assert(!JSON.stringify(list.body).includes(KEY));assert.equal(f.calls(),2);}});
test('wrong front, crossed brand and all mutations are refused before source contact',async()=>{const f=fixture({front:'afiliados'});await assert.rejects(request(f),e=>e.status===403);assert.equal(f.calls(),0);const g=fixture();await assert.rejects(request(g,'segmento_contar'),e=>e.code==='READ_ONLY');await assert.rejects(g.reader.read({context:{},route:'segments',method:'POST',query:new URLSearchParams(),body:{acao:'segmento_salvar'},origin:'https://crm.synthetic.invalid'}),e=>e.code==='READ_ONLY');assert.equal(g.calls(),0);await assert.rejects(request(g,'segmentos_listar',{brand:'aristo'}));assert.equal(g.calls(),0);});
test('mixed source rows and source refusals remain failures, never empty public lists',async()=>{const mixed=await request(fixture({mixed:true}));assert.equal(mixed.status,502);assert(!Object.hasOwn(mixed.body,'segments'));const refused=await request(fixture({refused:true}));assert.equal(refused.status,403);assert.equal(refused.body.error,'SEGMENT_ACCESS_DENIED');});
test('revocation during the read discards the response',async()=>{await assert.rejects(request(fixture({revoke:true})),e=>e.status===403);});
test('cache key alone cannot authenticate public READ or be promoted to an operator',async()=>{const f=fixture({missing:true});await assert.rejects(request(f),e=>e.code==='AUDIENCE_READ_SOURCE_NOT_LINKED');assert.equal(f.calls(),0);const r=await f.reader.read({context:{},route:'crm-read',method:'GET',query:new URLSearchParams({action:'cache_growth',painel:'growth'}),viewBrand:'fish',origin:'https://crm.synthetic.invalid'});assert.equal(r.body.capabilities.segments.read,false);});
test('dashboard advertises only per-brand public READ with the same-origin endpoint',async()=>{const f=fixture(),r=await f.reader.read({context:{},route:'crm-read',method:'GET',query:new URLSearchParams({action:'cache_growth',painel:'growth'}),viewBrand:'fish',origin:'https://crm.synthetic.invalid'});assert.equal(r.status,200);assert.deepEqual(r.body.capabilities.segments.brands,['fish']);assert.equal(r.body.capabilities.segments.read,true);for(const x of ['save','count','operation','send'])assert.equal(r.body.capabilities.segments[x],false);assert.equal(r.body.capabilities.endpoints.segments,'https://crm.synthetic.invalid/api/segments');});
test('existing browser client lists and reopens service READ DTOs in both brands',async()=>{
 const Client=require('../growth-segment-client.js');
 for(const brand of ['fish','aristo']){const f=fixture({brand}),api={capabilities:{segments:{contract_version:'crm-audience-v2',brands:[brand],read:true,save:false,count:false,operation:false},endpoints:{segments:'https://crm.synthetic.invalid/api/segments'}}},values=new Map();
  const client=Client.create({api,brand,key:'synthetic-browser-actor',storage:{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)},locks:{request:async(_k,_opts,fn)=>fn({})},fetch:async(url,options)=>{assert.equal(options.method,'GET');const result=await f.reader.read({context:{},route:'segments',method:'GET',query:new URL(url).searchParams,origin:'https://crm.synthetic.invalid'});return {status:result.status,json:async()=>result.body};}});
  const listed=await client.list();const opened=await client.open(listed.segments[0].id);assert.equal(opened.segment.id,ID);assert.equal(opened.segment.brand,brand);assert.equal(client.capabilities().save,false);assert.equal(f.calls(),2);
 }
});

function diagnosticFixture(fetchImpl,projectionError){
 const events=[],user={id:'synthetic-admin',role:'superadmin',areas:['growth'],productFronts:['growth'],brands:['aristo']};
 const auth={authorize:()=>user,authorizeBrand:()=>user};
 const reader=createReader({auth,upstreams:{'crm-read':new URL(P.FIXED_DESTINATIONS['crm-read'])},keys:{growth:KEY},fetchImpl,projectGrowth:()=>{if(projectionError)throw projectionError;return {brand:'aristo'};},onReadFailure:e=>events.push(e)});
 const request=()=>reader.read({context:{},route:'crm-read',method:'GET',query:new URLSearchParams({action:'cache_growth',painel:'growth'}),viewBrand:'aristo',origin:'https://crm.synthetic.invalid'});
 return {request,events,reader};
}
test('CRM refusal records actual HTTP, original code and SQLSTATE without raw messages',async()=>{
 const f=diagnosticFixture(async()=>new Response(JSON.stringify({error:'CACHE_READ_REFUSED',sqlstate:'55P03',message:'private@synthetic.invalid password=secret',detail:KEY}),{status:503,headers:{'content-type':'application/json'}}));
 await assert.rejects(f.request(),e=>e.code==='SERVICE_READ_SOURCE_REFUSED');assert.equal(f.events.length,1);
 const e=f.events[0];assert.equal(e.brand,'aristo');assert.equal(e.sourceStatus,503);assert.equal(e.sourceCode,'CACHE_READ_REFUSED');assert.equal(e.sqlState,'55P03');assert.equal(e.stage,'source-response');assert(!JSON.stringify(e).includes(KEY));assert(!JSON.stringify(e).includes('private@'));assert(!JSON.stringify(e).includes('secret'));
});
test('CRM transport refusal retains cause code and drops connection strings and stack',async()=>{
 const f=diagnosticFixture(async()=>{throw Object.assign(new TypeError('postgresql://private:secret@host/db'),{cause:{code:'ECONNRESET'},stack:'private-stack'});});
 await assert.rejects(f.request(),e=>e.code==='UPSTREAM_UNAVAILABLE');assert.equal(f.events[0].transportCode,'ECONNRESET');assert.equal(f.events[0].errorType,'TypeError');assert.equal(f.events[0].stage,'transport');assert(!JSON.stringify(f.events).includes('private'));assert(!JSON.stringify(f.events).includes('postgresql'));
});
test('CRM malformed response records stage and source HTTP without response contents',async()=>{
 const f=diagnosticFixture(async()=>new Response('private@synthetic.invalid not-json',{status:200,headers:{'content-type':'application/json'}}));await assert.rejects(f.request(),e=>e.code==='UPSTREAM_INVALID_JSON');assert.equal(f.events[0].stage,'json');assert.equal(f.events[0].sourceStatus,200);assert(!JSON.stringify(f.events).includes('private@'));
});
test('CRM projection failure records exact closed section and field',async()=>{
 const e=Object.assign(Error('BRAND_RESPONSE_UNSCOPED'),{status:502,code:'BRAND_RESPONSE_UNSCOPED',projectionIssue:{section:'crm_carrinho',reason:'field_type_invalid',field:'receita'}});
 const f=diagnosticFixture(async()=>new Response('{}',{headers:{'content-type':'application/json'}}),e);await assert.rejects(f.request());assert.deepEqual(f.events[0].projection,{section:'crm_carrinho',reason:'field_type_invalid',field:'receita'});assert.equal(f.events[0].stage,'projection');
});

test('native source summary returns only refusal metadata for the delegated brands',async()=>{const f=diagnosticFixture(async()=>new Response(JSON.stringify({error:'CACHE_READ_REFUSED'}),{status:503,headers:{'content-type':'application/json'}}));await assert.rejects(f.request());const r=await f.reader.summary({},['fish'],'https://crm.synthetic.invalid');assert(r.readFailures.length>0);assert(r.readFailures.every(x=>x.brand==='fish'));assert(f.events.some(x=>x.brand==='aristo'));});

function keyInstallFixture(t,{commitUncertain=false,lockRefused=false,changed=false,scopeRefused=false,endRefused=false,linkRefused=false,raceJournal=false}={}){
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),api=require(runtime+'/simple-dashboard-read.cjs');
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'public-key-test-'))),queries=[],linked=[];let connected=0,ended=0,profileRevision=1,wrote=false;
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const auth={authorize:()=>({id:'synthetic-owner',role:'superadmin'}),nativeConnections:{authenticate(){if(scopeRefused)throw Object.assign(Error('scope'),{code:'NATIVE_SCOPE_DENIED'});return {id:'synthetic-connection',userId:'synthetic-owner',brands:['fish','aristo']};}},nativeDatabaseVault:{getPrivateCredential:()=>({ownerId:'synthetic-owner',revision:profileRevision,username:'synthetic-db-operator',password:'SYNTHETIC-PRIVATE-PASSWORD',resource:{project:'comunicacao',service:'postgres',host:'comunicacao_postgres',port:5432,database:'listmonk',network:'easypanel'},transport:{mode:'admitted-private-network'}}),admitInspection(){throw Error('Inspection consent must not authorize IAM');}}};
 const io={...fs,openSync(file,flags,mode){if(raceJournal&&file.endsWith('publics-read-key-operation.json')&&!fs.existsSync(file))fs.writeFileSync(file,'OTHER ORIGINAL JOURNAL',{mode:0o600});return fs.openSync(file,flags,mode);}};
 const installer=api.createPublicReadKeyInstaller({auth,root,io,onLinked:key=>{if(linkRefused)throw Error('SYNTHETIC-PRIVATE-PASSWORD');linked.push(key)},createClient:config=>{assert.equal(config.application_name,'shrigma-publics-read-key');return {async connect(){connected++;},async query(sql,params){queries.push({sql,params});if(sql.startsWith('LOCK')&&lockRefused)throw Object.assign(Error('SYNTHETIC-PRIVATE-PASSWORD'),{code:'55P03'});if(sql.startsWith('SELECT current_database'))return {rows:[{db:true,role_match:true,cluster:true,audience_pin:true,operator_pin:true}]};if(sql.startsWith('SELECT count(*)=0'))return {rows:[{absent:true}]};if(sql.startsWith('INSERT INTO public.crm_dash_chave')){assert.equal(params.length,3);assert(!params.some(v=>v==='SYNTHETIC-PRIVATE-PASSWORD'));wrote=true;if(changed)profileRevision++;}if(sql.startsWith('SELECT crm_audience_v2.authenticate'))return {rows:[{audience:true,read_only:true}]};if(sql==='COMMIT'&&commitUncertain)throw Object.assign(Error('SYNTHETIC-PRIVATE-PASSWORD'),{code:'ECONNRESET'});if(sql.startsWith('SELECT count(*)=1'))return {rows:[{present:wrote}]};return {rows:[],command:sql==='COMMIT'?'COMMIT':sql==='ROLLBACK'?'ROLLBACK':null};},async end(){ended++;if(endRefused)throw Error('SYNTHETIC-PRIVATE-PASSWORD');}};}});
 const args={operationId:'33333333-3333-4333-8333-333333333333',purpose:'crm.publics-read-key',approved:true},context={nativeBearer:'synthetic-native-only'};
 return {installer,args,context,root,queries,linked,connected:()=>connected,ended:()=>ended,api};
}
test('fixed public READ issuance requires its own approval and native Master, never db.inspect',async t=>{const f=keyInstallFixture(t);await assert.rejects(f.installer.install(f.context,{...f.args,approved:false}),e=>e.code==='PUBLIC_READ_EXPLICIT_APPROVAL_REQUIRED');await assert.rejects(f.installer.install({},f.args),e=>e.code==='PUBLIC_READ_NATIVE_MASTER_REQUIRED');await assert.rejects(f.installer.install(f.context,{...f.args,purpose:'db.inspect'}));assert.equal(f.connected(),0);assert.equal(require('node:fs').readdirSync(f.root).length,0);});
test('fixed issuer creates only one permanent hashed READ principal and keeps both credentials private',async t=>{const f=keyInstallFixture(t),r=await f.installer.install(f.context,f.args);assert.equal(r.status,200);assert.equal(r.body.state,'confirmed');assert.equal(r.body.expires,'none');assert.equal(f.connected(),1);assert.equal(f.ended(),1);assert.equal(f.queries.filter(q=>q.sql.startsWith('INSERT')).length,2);const permission=f.queries.find(q=>q.sql.startsWith('INSERT INTO public.shrigma_panel_permission'));assert.match(permission.sql,/read_content/);assert.doesNotMatch(permission.sql,/creators_edit|campaigns_edit/);const secret=f.api.readPublicReadKey({root:f.root});assert.equal(secret.length,64);assert.equal(f.linked[0],secret);assert(!JSON.stringify(r).includes(secret));assert(!JSON.stringify(r).includes('SYNTHETIC-PRIVATE-PASSWORD'));assert.equal(require('node:fs').statSync(f.root+'/source-audience-read.env').mode&0o777,0o600);assert(f.queries.some(q=>q.sql.includes("log_parameter_max_length_on_error=0")));assert(f.queries.some(q=>q.sql.includes("lock_timeout='500ms'")));});
test('repeated installation returns the same receipt without reconnecting or writing SQL',async t=>{const f=keyInstallFixture(t);await f.installer.install(f.context,f.args);const n=f.queries.length,r=await f.installer.install(f.context,f.args);assert.equal(r.body.state,'confirmed');assert.equal(f.queries.length,n);assert.equal(f.connected(),1);await assert.rejects(f.installer.install(f.context,{...f.args,operationId:'44444444-4444-4444-8444-444444444444'}),e=>e.code==='PUBLIC_READ_OPERATION_CHANGED');});
test('uncertain COMMIT preserves the same key; only a READ reconciles its exact grant',async t=>{const f=keyInstallFixture(t,{commitUncertain:true}),r=await f.installer.install(f.context,f.args);assert.equal(r.status,202);assert.equal(r.body.state,'uncertain');assert.equal(f.api.readPublicReadKey({root:f.root}),undefined);const secret=f.api.readPublicReadKey({root:f.root,confirmedOnly:false}),writes=f.queries.filter(q=>q.sql.startsWith('INSERT')).length;await f.installer.install(f.context,f.args);assert.equal(f.connected(),1);const read=await f.installer.status(f.context,{operationId:f.args.operationId});assert.equal(read.body.state,'confirmed');assert.equal(f.api.readPublicReadKey({root:f.root}),secret);assert.equal(f.queries.filter(q=>q.sql.startsWith('INSERT')).length,writes);assert(f.queries.some(q=>q.sql.startsWith('BEGIN TRANSACTION READ ONLY')));assert.equal(f.ended(),2);});
test('lock refusal rolls back before generating a key and exposes only SQLSTATE',async t=>{const f=keyInstallFixture(t,{lockRefused:true}),r=await f.installer.install(f.context,f.args);assert.equal(r.status,503);assert.equal(r.body.sqlState,'55P03');assert(!JSON.stringify(r).includes('SYNTHETIC-PRIVATE-PASSWORD'));assert(!require('node:fs').existsSync(f.root+'/source-audience-read.env'));assert.equal(f.queries.filter(q=>q.sql.startsWith('INSERT')).length,0);assert(f.queries.some(q=>q.sql==='ROLLBACK'));assert.equal(f.ended(),1);});
test('profile revision changes refuse COMMIT and do not link the key',async t=>{const f=keyInstallFixture(t,{changed:true}),r=await f.installer.install(f.context,f.args);assert.equal(r.status,503);assert.equal(r.body.error,'PUBLIC_READ_ADMISSION_CHANGED');assert.equal(f.linked.length,0);assert(!f.queries.some(q=>q.sql==='COMMIT'));assert(f.queries.some(q=>q.sql==='ROLLBACK'));});
test('a connection without IAM scope cannot create a journal, key or database session',async t=>{const f=keyInstallFixture(t,{scopeRefused:true});await assert.rejects(f.installer.install(f.context,f.args),e=>e.code==='NATIVE_SCOPE_DENIED');assert.equal(f.connected(),0);assert.equal(require('node:fs').readdirSync(f.root).length,0);});
test('failure after a known COMMIT preserves the grant and does not retry INSERT',async t=>{const f=keyInstallFixture(t,{linkRefused:true}),r=await f.installer.install(f.context,f.args);assert.equal(r.status,503);assert.equal(r.body.state,'committed');assert.equal(r.body.catalogueCommitted,true);assert.equal(r.body.connectionClosed,true);assert.equal(r.body.linked,false);assert.equal(f.queries.filter(q=>q.sql==='COMMIT').length,1);const writes=f.queries.filter(q=>q.sql.startsWith('INSERT')).length;await f.installer.install(f.context,f.args);assert.equal(f.queries.filter(q=>q.sql.startsWith('INSERT')).length,writes);});
test('failed connection close is reported independently of a known committed grant',async t=>{const f=keyInstallFixture(t,{endRefused:true}),r=await f.installer.install(f.context,f.args);assert.equal(r.body.state,'committed');assert.equal(r.body.catalogueCommitted,true);assert.equal(r.body.connectionClosed,false);assert.equal(r.body.error,'PUBLIC_READ_CLOSE_UNCONFIRMED');assert.equal(f.linked.length,0);assert.equal(f.ended(),1);});
test('status protects parameter logging before sending the private key hash',async t=>{const f=keyInstallFixture(t,{commitUncertain:true});await f.installer.install(f.context,f.args);const start=f.queries.length;await f.installer.status(f.context,{operationId:f.args.operationId});const read=f.queries.slice(start);assert(read[0].sql.includes('READ ONLY'));assert(read[0].sql.includes('log_parameter_max_length=0'));assert(read[0].sql.includes('log_parameter_max_length_on_error=0'));assert(read.some(q=>q.sql.startsWith('SELECT count(*)=1')));assert(!read.some(q=>q.sql.startsWith('INSERT')));});
test('exclusive journal collision never overwrites the predecessor or starts SQL',async t=>{const f=keyInstallFixture(t,{raceJournal:true});await assert.rejects(f.installer.install(f.context,f.args),e=>e.code==='EEXIST');assert.equal(require('node:fs').readFileSync(f.root+'/publics-read-key-operation.json','utf8'),'OTHER ORIGINAL JOURNAL');assert.equal(f.connected(),0);assert.equal(f.linked.length,0);assert.equal(f.queries.length,0);});

function countFixture({brand='fish',unknown=false,refuse=false,change=false,revoke=false,draft=false,available=true,badHash=false}={}){
 const calls=[],stamp=()=>new Date().toISOString();let active=true,catalogCalls=0;
 const list=brand==='fish'?17:7,definition={schema_version:'crm-audience-v2',brand,name:'Público sintético',rule:{op:'in_list',list_id:list}},user={id:'synthetic-reader',role:'manager',areas:['growth'],productFronts:['growth'],brands:[brand],permissions:{growth:{read:true,edit:false}}};
 const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
 const hash=require('node:crypto').createHash('sha256').update(canonical(definition)).digest('hex');
 const catalog={brand,current:true,currency:'BRL',timezone:'America/Sao_Paulo',shop_id:null,fields:[],products:[],origins:[],lists:[{id:list,brand,name:'Lista sintética',available}],coverage:'unconfirmed',checked_at:stamp(),catalog_hash:'a'.repeat(64)};
 const row={id:ID,brand,name:definition.name,definition,version:1,archived:false,created_at:stamp(),updated_at:stamp(),updated_by:'panel:synthetic-reader',semantic_context:{currency:'BRL',timezone:'America/Sao_Paulo',current:true}};
 const reader=createReader({auth:{authorize:()=>user,authorizeBrand(_c,b){if(!active||b!==brand)throw Object.assign(Error('ACCESS_DENIED'),{status:403,code:'ACCESS_DENIED'});return user;}},upstreams:{segments:new URL(P.REVIEWED_DYNAMIC.routes.segments)},keys:{audiences:KEY},projectGrowth:()=>({brand}),fetchImpl:async(url,options)=>{
  assert.equal(options.headers.Authorization,'Bearer '+KEY);
  calls.push({url,method:options.method});const q=new URL(url).searchParams;
  let body;if(options.method==='POST'){assert.deepEqual(JSON.parse(options.body),{acao:'segmento_contar',brand,...(draft?{definition}:{id:ID,expected_version:1}),expected_catalog_hash:'a'.repeat(64)});if(revoke)active=false;if(refuse)return new Response(JSON.stringify({error:'SEGMENT_UNAVAILABLE'}),{status:503,headers:{'content-type':'application/json'}});
   body={source_confirmed:!unknown,eligible_count:unknown?null:42,checked_at:stamp(),definition,definition_hash:badHash?'b'.repeat(64):hash,base_list_id:list,transport_supported:false,unknown_reason:unknown?'external_source_unavailable':null,segment_id:draft?null:ID,version:draft?null:1};
  }else if(q.get('acao')==='segmento_obter')body={segment:row};
  else{catalogCalls++;body={segments:[row],limit:Number(q.get('limit')),offset:Number(q.get('offset')),catalog:{...catalog,catalog_hash:change&&catalogCalls>1?'b'.repeat(64):catalog.catalog_hash},capabilities:{draft:false,count:true,send:false}};}
  return new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
 }});
 const request=(extra={})=>reader.read({context:{},route:'segments',method:'POST',query:new URLSearchParams(),body:{acao:'segmento_contar',brand,...(draft?{definition}:{id:ID,expected_version:1}),expected_catalog_hash:'a'.repeat(64),...extra},origin:'https://crm.synthetic.invalid'});
 return {request,calls};
}
test('saved COUNT uses the original READ grant in both brands and rechecks catalog and version',async()=>{
 for(const brand of ['fish','aristo']){const f=countFixture({brand}),r=await f.request();assert.equal(r.status,200,JSON.stringify({r,calls:f.calls}));assert.equal(r.body.eligible_count,42);assert.equal(r.body.transport_supported,false);assert.deepEqual(f.calls.map(c=>c.method),['GET','GET','POST','GET','GET']);assert(!JSON.stringify(r).includes(KEY));}
});
test('external COUNT unavailable is null rather than zero, and a source refusal stays refused',async()=>{
 const f=countFixture({unknown:true}),r=await f.request();assert.equal(r.status,200);assert.equal(r.body.source_confirmed,false);assert.equal(r.body.eligible_count,null);assert.equal(r.body.unknown_reason,'external_source_unavailable');
 const g=countFixture({refuse:true}),e=await g.request();assert.equal(e.status,503);assert.equal(e.body.error,'SEGMENT_UNAVAILABLE');assert.equal(g.calls.length,3);
});
test('COUNT discards changes in catalog or login during the original query',async()=>{
 await assert.rejects(countFixture({change:true}).request(),e=>e.code==='SEGMENT_CATALOG_CHANGED');await assert.rejects(countFixture({revoke:true}).request(),e=>e.code==='ACCESS_DENIED');
});
test('draft COUNT uses current catalog and original READ in both brands without creating a public',async()=>{
 for(const brand of ['fish','aristo']){const f=countFixture({brand,draft:true}),r=await f.request();assert.equal(r.status,200);assert.equal(r.body.eligible_count,42);assert.equal(r.body.segment_id,null);assert.equal(r.body.version,null);assert.deepEqual(f.calls.map(c=>c.method),['GET','POST','GET']);assert(!JSON.stringify(r).includes(KEY));}
});
test('draft COUNT keeps unknown null and rejects changed catalog, revoked access or mismatched source definition',async()=>{
 const f=countFixture({draft:true,unknown:true}),r=await f.request();assert.equal(r.body.eligible_count,null);assert.equal(r.body.source_confirmed,false);
 await assert.rejects(countFixture({draft:true,change:true}).request(),e=>e.code==='SEGMENT_CATALOG_CHANGED');await assert.rejects(countFixture({draft:true,revoke:true}).request(),e=>e.code==='ACCESS_DENIED');assert.equal((await countFixture({draft:true,badHash:true}).request()).status,502);
});
test('draft COUNT rejects unavailable rules and crossed brands before any original POST',async()=>{
 const f=countFixture({draft:true,available:false});await assert.rejects(f.request(),e=>e.code==='SEGMENT_UNAVAILABLE');assert.deepEqual(f.calls.map(c=>c.method),['GET']);
 const g=countFixture({draft:true});await assert.rejects(g.request({definition:{schema_version:'crm-audience-v2',brand:'aristo',name:'Outra marca',rule:{op:'in_list',list_id:7}}}),e=>e.code==='AUDIENCE_COUNT_REQUEST_INVALID');assert.equal(g.calls.length,0);
});
test('READ count cannot accept a draft mutation, alternate destination or extra fields',async()=>{
 const f=countFixture();await assert.rejects(f.request({definition:{}}),e=>e.code==='AUDIENCE_COUNT_REQUEST_INVALID');await assert.rejects(f.request({acao:'segmento_salvar'}),e=>e.code==='READ_ONLY');assert.equal(f.calls.length,0);
 const user={role:'manager',permissions:{growth:{read:true,edit:false}}};let calls=0;
 await assert.rejects(P.forward({route:'segments',method:'POST',query:new URLSearchParams(),body:{acao:'segmento_contar',brand:'fish',id:ID,expected_version:1,expected_catalog_hash:'a'.repeat(64)},user,credential:KEY,upstreams:{segments:new URL('https://synthetic.invalid/')},simpleAudienceCount:true,fetchImpl:async()=>{calls++;}}),e=>e.code==='AUDIENCE_READ_SCOPE_DENIED');assert.equal(calls,0);
});

test('public READ retries one DNS failure before HTTP, never an HTTP refusal or another mutation',async()=>{
 const f=fixture({dnsFailures:1}),r=await request(f);assert.equal(r.status,200);assert.equal(f.calls(),2);
 const g=fixture({dnsFailures:2});await assert.rejects(request(g),e=>e.code==='UPSTREAM_UNAVAILABLE');assert.equal(g.calls(),2);
 const h=fixture({refused:true}),refused=await request(h);assert.equal(refused.status,403);assert.equal(h.calls(),1);
});
test('DNS retry rechecks current brand permission before making a second GET',async()=>{
 const f=fixture({dnsFailures:1,dnsRevoke:true});await assert.rejects(request(f),e=>e.code==='ACCESS_DENIED');assert.equal(f.calls(),1);
});
test('CRM cache retries only DNS before HTTP and emits no raw error data',async()=>{
 let calls=0;const f=diagnosticFixture(async()=>{calls++;if(calls===1)throw Object.assign(new TypeError('private@synthetic.invalid password=secret'),{cause:{code:'EAI_AGAIN'}});return new Response('{}',{headers:{'content-type':'application/json'}});});
 const r=await f.request();assert.equal(r.status,200);assert.equal(calls,2);assert.equal(f.events[0].event,'DASHBOARD_READ_DNS_RETRY');assert(!JSON.stringify(f.events).includes('secret'));assert(!JSON.stringify(f.events).includes('private@'));
});
