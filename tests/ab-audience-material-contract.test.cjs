'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const M=require('../n8n/growth/ab-audience-material.cjs');
const copy=v=>JSON.parse(JSON.stringify(v));
const scope={brand:'fish',campaignId:100};
const at='2026-09-28T10:00:00.123456+00:00';
function snapshot(){
 return {
  campaign:{id:100,uuid:'10000000-0000-4000-8000-000000000100',name:'Synthetic A',subject:'Olá 🐟',from_email:'Sender <sender@example.invalid>',body:'<p>{{ .Subscriber.Name }} — olá 🐟</p>',body_source:null,altbody:'Olá',content_type:'html',send_at:'2026-10-02T16:00:00+00:00',headers:[{'Reply-To':'reply@example.invalid','X-SES-CONFIGURATION-SET':'synthetic'},{'X-Other':'keep'}],attribs:{crm:{policy:'crm-campaign-v1',brand:'fish',initiative_key:'week',utm_campaign:'week'},other:{enabled:true,count:2}},status:'draft',tags:['synthetic','fish'],type:'regular',messenger:'email',template_id:1,to_send:0,sent:0,max_subscriber_id:0,last_subscriber_id:0,archive:false,archive_slug:null,archive_template_id:null,archive_meta:{title:'Synthetic archive'},started_at:null,created_at:at,updated_at:at},
  template:{id:1,name:'Synthetic template',type:'campaign',subject:'',body:'<html>{{ template "content" . }}</html>',body_source:null,is_default:false,created_at:at,updated_at:at},
  lists:[{relation:{id:10,campaign_id:100,list_id:17,list_name:'Fish'},list:{id:17,uuid:'10000000-0000-4000-8000-000000000017',name:'Fish',type:'private',optin:'single',status:'active',tags:['fish'],description:'Synthetic list',created_at:at,updated_at:at}}],
  media:[{relation:{campaign_id:100,media_id:1,filename:'attachment.pdf'},media:{id:1,uuid:'10000000-0000-4000-8000-000000000001',provider:'filesystem',filename:'attachment.pdf',content_type:'application/pdf',thumb:'',meta:{length:100},created_at:at}}]
 };
}
const material=raw=>M.materialize(raw,scope);
const hash=raw=>M.hash(raw,scope);
const refusal=(fn,code)=>assert.throws(fn,error=>error.code===code);

test('operational progress changes the former whole-row MD5 input but preserves material',()=>{
 const original=snapshot(),changed=copy(original);
 Object.assign(changed.campaign,{status:'running',sent:50,to_send:200,max_subscriber_id:500,last_subscriber_id:100,started_at:'2026-09-28T11:00:00.000Z',updated_at:'2026-09-28T11:05:00.000Z'});
 // Model the raw input of shrigma_campaign_current; SQL integration tests
 // exercise PostgreSQL's exact jsonb text/MD5 implementation separately.
 const legacy=x=>createHash('md5').update(JSON.stringify(x)).digest('hex');
 assert.notEqual(legacy(original),legacy(changed));assert.equal(hash(original),hash(changed));
 assert.deepEqual(M.OPERATIONAL_CAMPAIGN_FIELDS,['status','sent','to_send','max_subscriber_id','last_subscriber_id','started_at','updated_at']);
 for(const key of M.OPERATIONAL_CAMPAIGN_FIELDS)assert.equal(Object.hasOwn(M.normalize(original,scope).snapshot.campaign,key),false);
});

test('every supported semantic campaign field participates, including unknown future columns',()=>{
 const original=snapshot(),expected=hash(original),changes={
  uuid:'10000000-0000-4000-8000-000000000101',name:'New name',subject:'New subject',from_email:'new@example.invalid',body:'<p>New body</p>',body_source:'{"blocks":[]}',altbody:'New text',content_type:'markdown',send_at:'2026-10-02T17:00:00+00:00',
  headers:[{'Reply-To':'new@example.invalid','X-SES-CONFIGURATION-SET':'other'},{'X-Other':'keep'}],attribs:{...original.campaign.attribs,custom:'changed'},tags:['fish','synthetic'],archive:true,archive_slug:'new-slug',archive_meta:{title:'Changed archive'},created_at:'2026-09-27T10:00:00+00:00',future_render_setting:{enabled:true}
 };
 for(const [key,value]of Object.entries(changes)){const changed=copy(original);changed.campaign[key]=value;assert.notEqual(hash(changed),expected,key);}
 const changed=copy(original);changed.campaign.template_id=2;changed.template.id=2;assert.notEqual(hash(changed),expected,'template_id');
 const other=copy(original);other.campaign.id=101;other.lists[0].relation.campaign_id=101;other.media[0].relation.campaign_id=101;
 assert.notEqual(M.hash(other,{brand:'fish',campaignId:101}),expected,'campaign identity');
});

test('every template column and all declared dependency metadata remain hashed',()=>{
 const original=snapshot(),expected=hash(original);
 const mutations=[
  x=>x.template.name='Changed',x=>x.template.subject='Changed',x=>x.template.body='Changed {{ template "content" . }}',x=>x.template.body_source='Changed',x=>x.template.is_default=true,x=>x.template.created_at='2026-09-27T10:00:00+00:00',x=>x.template.updated_at='2026-09-29T10:00:00+00:00',x=>x.template.future_property='changed',
  x=>x.lists[0].relation.id=11,x=>x.lists[0].relation.list_name='Changed',x=>x.lists[0].relation.future_property='changed',x=>x.lists[0].list.uuid='10000000-0000-4000-8000-000000000099',x=>x.lists[0].list.name='Changed',x=>x.lists[0].list.type='public',x=>x.lists[0].list.optin='double',x=>x.lists[0].list.status='archived',x=>x.lists[0].list.tags=['fish','new'],x=>x.lists[0].list.description='Changed',x=>x.lists[0].list.updated_at='2026-09-29T10:00:00+00:00',x=>x.lists[0].list.future_property='changed',
  x=>x.media[0].relation.filename='renamed.pdf',x=>x.media[0].relation.future_property='changed',x=>x.media[0].media.uuid='10000000-0000-4000-8000-000000000099',x=>x.media[0].media.provider='s3',x=>x.media[0].media.filename='renamed.pdf',x=>x.media[0].media.content_type='text/plain',x=>x.media[0].media.thumb='new-thumb',x=>x.media[0].media.meta={length:101},x=>x.media[0].media.created_at='2026-09-29T10:00:00+00:00',x=>x.media[0].media.future_property='changed'
 ];
 for(const [i,mutate]of mutations.entries()){const changed=copy(original);mutate(changed);assert.notEqual(hash(changed),expected,String(i));}
 for(const category of ['lists','media']){const changed=copy(original),entry=copy(changed[category][0]);entry.relation[category==='lists'?'list_id':'media_id']=2;entry[category==='lists'?'list':'media'].id=2;if(category==='lists')entry.relation.id=20;changed[category].push(entry);assert.notEqual(hash(changed),expected,category+' relationship');}
});

test('dependency timestamps are conservative, never synthesized, and cannot be silently omitted',()=>{
 const raw=snapshot();raw.template.updated_at=null;raw.template.created_at=null;raw.lists[0].list.updated_at=null;raw.media[0].media.created_at=null;
 const first=material(raw),second=material(copy(raw));assert.deepEqual(first,second);
 assert.equal(first.snapshot.template.updated_at,null);assert.equal(first.snapshot.media[0].media.created_at,null);
 const changed=copy(raw);changed.template.updated_at=at;assert.notEqual(hash(changed),first.material_hash);
 for(const field of ['created_at','updated_at']){const missing=copy(raw);delete missing.template[field];refusal(()=>hash(missing),'AB_MATERIAL_TEMPLATE');}
});

test('relation order and object insertion order are immaterial; semantic array order is preserved',()=>{
 const raw=snapshot();for(const category of ['lists','media']){const entry=copy(raw[category][0]);entry.relation[category==='lists'?'list_id':'media_id']=2;entry[category==='lists'?'list':'media'].id=2;if(category==='lists')entry.relation.id=20;raw[category].push(entry);}
 const changed=copy(raw);changed.lists.reverse();changed.media.reverse();changed.campaign=Object.fromEntries(Object.entries(changed.campaign).reverse());
 assert.equal(hash(changed),hash(raw));
 for(const key of ['headers','tags']){const edited=copy(raw);edited.campaign[key].reverse();assert.notEqual(hash(edited),hash(raw),key);}
});

test('normalization validates scope and raw completeness; a client definition is not a snapshot',()=>{
 const raw=snapshot();
 for(const scopeChange of [{brand:'aristo',campaignId:100},{brand:'fish',campaignId:101},{brand:'other',campaignId:100},{brand:'fish',campaignId:'100'},{...scope,extra:true}])refusal(()=>M.normalize(raw,scopeChange),'AB_MATERIAL_SCOPE');
 for(const key of ['campaign','lists','media','template']){const missing=copy(raw);delete missing[key];refusal(()=>hash(missing),'AB_MATERIAL_SNAPSHOT');}
 refusal(()=>hash({...raw,contract:'wrong'}),'AB_MATERIAL_SNAPSHOT');refusal(()=>hash({definition:raw.campaign}),'AB_MATERIAL_SNAPSHOT');
 for(const key of ['subject','body','headers','attribs']){const missing=copy(raw);delete missing.campaign[key];assert.throws(()=>hash(missing));}
 const other=copy(raw);other.campaign.attribs.crm.brand='aristo';refusal(()=>hash(other),'AB_MATERIAL_SCOPE');
 other.campaign.from_email='sender@example.invalid';assert.match(M.hash(other,{brand:'aristo',campaignId:100}),/^[a-f0-9]{64}$/);
});

test('ignored progress fields still require valid JSON and operational shapes',()=>{
 for(const [key,value]of [['status','unknown'],['sent',-1],['sent','0'],['to_send',2147483648],['max_subscriber_id',[]],['last_subscriber_id',null],['started_at','tomorrow'],['updated_at',{}]]){
  const raw=snapshot();raw.campaign[key]=value;refusal(()=>hash(raw),'AB_MATERIAL_SNAPSHOT');
 }
 for(const key of ['status','sent','started_at','updated_at']){const raw=snapshot();delete raw.campaign[key];assert.throws(()=>hash(raw));}
 for(const key of ['to_send','max_subscriber_id','last_subscriber_id']){const missing=snapshot();delete missing.campaign[key];refusal(()=>hash(missing),'AB_MATERIAL_SCOPE');}
});

test('implicit/default/archive templates and dangling or duplicate dependencies fail closed',()=>{
 for(const change of [x=>x.template=null,x=>x.campaign.template_id=null,x=>x.template.id=2,x=>x.template.type='tx',x=>x.campaign.archive_template_id=2]){const raw=snapshot();change(raw);refusal(()=>hash(raw),'AB_MATERIAL_TEMPLATE');}
 for(const change of [x=>x.lists=[],x=>x.lists[0].list=null,x=>x.lists[0].relation.list_id=null,x=>x.lists[0].list.id=99,x=>x.lists[0].relation.campaign_id=99,x=>x.media[0].media=null,x=>x.media[0].relation.media_id=null,x=>x.media[0].media.id=99,x=>x.media[0].relation.campaign_id=99,x=>x.lists.push(copy(x.lists[0])),x=>x.media.push(copy(x.media[0])),x=>x.lists[0].extra='unknown']){const raw=snapshot();change(raw);refusal(()=>hash(raw),'AB_MATERIAL_DEPENDENCY');}
});

test('valid HTML much larger than 32 KiB is supported within the whole-material byte limit',()=>{
 const raw=snapshot();raw.campaign.body='<main>'+('<p>Olá 🐟 — conteúdo</p>'.repeat(50000))+'</main>';
 assert.ok(Buffer.byteLength(raw.campaign.body)>1024*1024);assert.match(hash(raw),/^[a-f0-9]{64}$/);
 raw.campaign.body='a'.repeat(M.LIMITS.bytes);refusal(()=>hash(raw),'AB_MATERIAL_LIMIT');
 refusal(()=>M.canonical('🐟'.repeat(M.LIMITS.bytes/4)),'AB_MATERIAL_LIMIT');
});

test('at most 1000 declared dependencies are allowed, counting the template',()=>{
 const raw=snapshot(),entry=raw.lists[0];raw.media=[];
 raw.lists=Array.from({length:999},(_,i)=>({relation:{...entry.relation,id:i+1,list_id:i+1},list:{...entry.list,id:i+1}}));
 assert.match(hash(raw),/^[a-f0-9]{64}$/);raw.lists.push({relation:{...entry.relation,id:1000,list_id:1000},list:{...entry.list,id:1000}});refusal(()=>hash(raw),'AB_MATERIAL_LIMIT');
});

test('Unicode canonicalization has explicit UTF-8 key order, exact normalization and a portable digest',()=>{
 const value={'\u{10000}':'astral','\ue000':'bmp','é':'composed','e\u0301':'decomposed','a':'🐟'};
 const expected='{"a":"🐟","é":"decomposed","é":"composed","":"bmp","𐀀":"astral"}';
 assert.equal(M.canonical(value),expected);assert.equal(M.digest(value),createHash('sha256').update(Buffer.from(expected,'utf8')).digest('hex'));
 assert.notEqual(M.digest({subject:'é'}),M.digest({subject:'e\u0301'}));
 for(const value of ['\ud800','\udfff','a\u0000b',{'\ud800':'bad'}])refusal(()=>M.canonical(value),'AB_MATERIAL_JSON');
});

test('canonical JSON rejects non-JSON values, unsafe numerics and coercion hooks',()=>{
 const cycle={};cycle.self=cycle;
 for(const value of [undefined,NaN,Infinity,-Infinity,-0,0.5,Number.MAX_SAFE_INTEGER+1,1n,()=>0,Symbol('value'),new Date(),new Map(),Buffer.from('x'),Object.create({inherited:true}),cycle,[,1],[undefined]])refusal(()=>M.canonical(value),'AB_MATERIAL_JSON');
 assert.equal(M.canonical({max:Number.MAX_SAFE_INTEGER,min:Number.MIN_SAFE_INTEGER}),'{"max":9007199254740991,"min":-9007199254740991}');
 let called=0;const getter=Object.defineProperty({},'a',{enumerable:true,get(){called++;return 'secret';}});
 const withToJSON={toJSON(){called++;return {};}};
 const proxy=new Proxy({},{ownKeys(){called++;return [];}});
 const revoked=Proxy.revocable({},{});revoked.revoke();
 for(const value of [getter,withToJSON,proxy,revoked.proxy])refusal(()=>M.canonical(value),'AB_MATERIAL_JSON');assert.equal(called,0);
 const hidden=Object.defineProperty({},'hidden',{value:1}),symbol={[Symbol('key')]:1},extra=[1];extra.label='extra';
 for(const value of [hidden,symbol,extra])refusal(()=>M.canonical(value),'AB_MATERIAL_JSON');
 const data=JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":"data"}}');
 assert.equal(M.canonical(data),'{"__proto__":{"polluted":true},"constructor":{"prototype":"data"}}');assert.equal({}.polluted,undefined);
 assert.equal(M.canonical(Object.assign(Object.create(null),{a:1})),'{"a":1}');
});

test('resource limits cover deeply nested and oversized node collections',()=>{
 let nested=null;for(let i=0;i<M.LIMITS.depth+2;i++)nested=[nested];refusal(()=>M.canonical(nested),'AB_MATERIAL_LIMIT');
 refusal(()=>M.canonical(Array.from({length:M.LIMITS.nodes},()=>null)),'AB_MATERIAL_LIMIT');
});

test('database text is checked before numbers can round into apparently safe JavaScript integers',()=>{
 for(const token of ['1.00000000000000001','9007199254740991.1','9007199254740992','-9007199254740992','1e0','1e-999','1E300','0.5','0.0','-0','-0.0','01','+1','NaN','Infinity']){
  refusal(()=>M.parseDatabaseSnapshot('{"number":'+token+'}'),'AB_MATERIAL_JSON');
 }
 assert.deepEqual(M.parseDatabaseSnapshot('{"number":9007199254740991,"min":-9007199254740991}'),{number:Number.MAX_SAFE_INTEGER,min:Number.MIN_SAFE_INTEGER});
 const raw=snapshot();raw.campaign.body='<p data-n="1.00000000000000001">9007199254740999, 1e999, -0, 🐟</p>';
 const parsed=M.parseDatabaseSnapshot(JSON.stringify(raw));assert.equal(hash(parsed),hash(raw));
 assert.equal(M.parseDatabaseSnapshot(' "\\u0031.0" '),'1.0');
 refusal(()=>M.parseDatabaseSnapshot(raw),'AB_MATERIAL_JSON');
 refusal(()=>M.parseDatabaseSnapshot(' '.repeat(M.LIMITS.bytes+1)),'AB_MATERIAL_LIMIT');
});

test('database parser rejects duplicate keys, malformed JSON, nonportable text and trailing input',()=>{
 const invalid=['{"a":1,"a":2}','{"a":1,"\\u0061":2}','{"nested":{"a":1,"a":2}}','[1,]','{"a":1,}','{"a" 1}','{"a":}','[true false]','{"a":false true}','[null,undefined]','truefalse','1 2','{"a":"unterminated}','"\\x00"','"\\u0000"','"\\ud800"','"\udfff"','"raw\nnewline"','\ufeff{}',''];
 for(const source of invalid)refusal(()=>M.parseDatabaseSnapshot(source),'AB_MATERIAL_JSON');
 for(const value of [null,true,false,0,1,-1,[],{},['a','b'],{a:'quoted " and backslash \\ with \t tab',nested:[true,null]}])assert.deepEqual(M.parseDatabaseSnapshot(' \n'+JSON.stringify(value)+'\r\t'),value);
 let source='null';for(let i=0;i<M.LIMITS.depth+2;i++)source='['+source+']';refusal(()=>M.parseDatabaseSnapshot(source),'AB_MATERIAL_LIMIT');
});

test('every pinned native column is required, while additional row columns are retained',()=>{
 const paths={campaign:['campaign'],template:['template'],list:['lists',0,'list'],list_relation:['lists',0,'relation'],media:['media',0,'media'],media_relation:['media',0,'relation']};
 for(const [kind,fields]of Object.entries(M.REQUIRED_FIELDS))for(const field of fields){
  const raw=snapshot();let row=raw;for(const key of paths[kind])row=row[key];delete row[field];assert.throws(()=>hash(raw),kind+'.'+field);
 }
 const raw=snapshot();raw.campaign.future_column={nested:['retained',1]};assert.deepEqual(material(raw).snapshot.campaign.future_column,raw.campaign.future_column);
});

test('material output is immutable, independent of inputs and has no operational authority',()=>{
 const raw=snapshot(),result=material(raw),normal=M.normalize(raw,scope);
 assert.deepEqual(Object.keys(result).sort(),['contract','brand','campaign_id','material_hash','snapshot','authorizes_selection','authorizes_send','execution_blocked','external_dependencies_complete'].sort());
 assert.equal(result.contract,M.VERSION);assert.equal(result.material_hash,M.digest(normal));assert.equal(result.material_hash,hash(raw));
 assert.equal(result.authorizes_selection,false);assert.equal(result.authorizes_send,false);assert.equal(result.execution_blocked,true);assert.equal(result.external_dependencies_complete,false);assert.equal(M.ENABLED,false);
 raw.campaign.subject='Changed outside';assert.equal(result.snapshot.campaign.subject,'Olá 🐟');assert.throws(()=>result.snapshot.campaign.subject='Changed inside',TypeError);assert.throws(()=>result.snapshot.lists.push({}),TypeError);
});
