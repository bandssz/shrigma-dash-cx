'use strict';
// Validador da biblioteca de mídia para a ponte READ do portal (agente N).
// Sem rede: executor real de media.cjs com pool/Listmonk sintéticos.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const V=require('../services/dashboard-operational/crm-media-read-validator.cjs');
const M=require('../services/crm-campaign/media.cjs');
const {AUTH_SQL}=require('../services/crm-campaign/transport.cjs');
const ORIGIN='https://email.shrigma.com.br',OP='11111111-1111-4111-8111-111111111111',OP2='22222222-2222-4222-8222-222222222222',SECRET='c'.repeat(64);
const canon=(brand,n=1,ext='png',op=OP)=>M.canonicalFilename(brand,op,String(n).padStart(64,'a').slice(-64).replace(/[^a-f0-9]/g,'a'),ext);
const TYPE={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif'};
const native=(filename,id,over={})=>({id,filename,content_type:TYPE[filename.split('.').pop().toLowerCase()]||'image/png',url:ORIGIN+'/uploads/'+encodeURIComponent(filename),thumb_url:null,meta:{width:600,height:300},created_at:'2026-10-01T10:00:00Z',...over});
const out=(filename,id,over={})=>{const n=native(filename,id,over);return {id:n.id,filename:n.filename,url:n.url,thumb_url:n.thumb_url,content_type:n.content_type,width:600,height:300,created_at:n.created_at,...(over.out||{})};};
const body=(brand,items,over={})=>({contract:'crm-media-v1',brand,items,total:items.length,page:1,per_page:24,next_page:null,...over});
const ok=(b,opts)=>V.validateMediaLibraryResponse(JSON.parse(JSON.stringify(b)),{brand:b.brand,page:1,per_page:24,secrets:[SECRET],...opts});
function executor({pages,log}){
 const pool={async query(sql,args){log.push(['sql',sql,args]);return {rows:[{auth:{actor:'panel:dcrm-'+'a'.repeat(32),caps:['read_content','list_history','submission']}}]};}};
 const lm={origin:ORIGIN,list:async q=>{log.push(['list',q]);return pages(q);},upload:async()=>{log.push(['upload']);throw Error('leitura não pode enviar');}};
 return M.createMediaExecutor({pool,native:lm});
}
const page=(results,{p=1,total=results.length,per=24}={})=>({status:200,body:{data:{results,total,page:p,per_page:per}}});

test('resposta real do executor nas duas marcas: aceita, legado marcado e nunca contado como da marca',async()=>{
 for(const brand of ['fish','aristo']){
  const other=brand==='fish'?'aristo':'fish',log=[];
  const run=executor({log,pages:()=>page([native(canon(brand,1),1),native(canon(other,2),2),native('banner-antigo.jpg',3),native(canon(brand,4,'gif',OP2.toUpperCase()),4)],{total:4})});
  const r=await run({key:'k',method:'GET',input:{brand,page:1,per_page:24}});assert.equal(r.status,200);
  const v=V.validateMediaLibraryResponse(JSON.parse(JSON.stringify(r.body)),{brand,page:1,per_page:24,secrets:[SECRET]});
  assert.deepEqual(v.body.items.map(i=>[i.id,i.legacy]),[[1,false],[3,true],[4,false]]);
  assert.deepEqual({...v.summary},{brand_items:2,legacy_items:1,excluded_legacy:0,excluded_foreign_prefix:0,excluded_irregular:0});
  assert.deepEqual(Object.keys(v.body),[...V.BODY_KEYS]);for(const i of v.body.items)assert.deepEqual(Object.keys(i),[...V.ITEM_KEYS,'legacy']);
  const ex=V.validateMediaLibraryResponse(JSON.parse(JSON.stringify(r.body)),{brand,page:1,per_page:24,legacy:'exclude'});
  assert.deepEqual(ex.body.items.map(i=>i.id),[1,4]);assert.equal(ex.summary.excluded_legacy,1);
 }
});

test('GET de mídia não tem efeito: uma autenticação STABLE, só GET /api/media, sem upload, sem mutex e sem estado',async()=>{
 const log=[];let calls=0;
 // Três páginas só com a outra marca: o scan para em 4 páginas nativas.
 const run=executor({log,pages:({page:p})=>{calls++;return page(p<4?[native(canon('aristo',p),p)]:[native(canon('fish',9),9)],{p,total:200,per:1});}});
 const first=await run({key:'k',method:'GET',input:{brand:'fish',page:1,per_page:1}}),second=await run({key:'k',method:'GET',input:{brand:'fish',page:1,per_page:1}});
 assert.deepEqual(first,second,'mesma resposta, nada guardado entre leituras');
 assert.equal(first.body.page,4);assert.equal(first.body.next_page,5);
 assert.deepEqual(V.validateMediaLibraryResponse(first.body,{brand:'fish',page:1,per_page:1}).body.items.map(i=>i.id),[9]);
 assert.equal(calls,8);assert.ok(log.every(([kind,...rest])=>kind==='list'?rest[0].query===''&&rest[0].perPage===1:kind==='sql'&&rest[0]===AUTH_SQL),JSON.stringify(log));
 assert.equal(log.filter(x=>x[0]==='sql').length,2);assert.equal(log.some(x=>x[0]==='upload'),false);
 // A leitura não ocupa o mutex de upload da marca.
 let release;const gate=new Promise(r=>{release=r;}),log2=[];
 const both=executor({log:log2,pages:async q=>{if(q.query==='')await gate;return page([]);}});
 const pending=both({key:'k',method:'GET',input:{brand:'fish',page:1,per_page:24}});await new Promise(r=>setImmediate(r));
 const bytes=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,2,0,0,0,3,8,2,0,0,0,0,0,0,0,0,0,0,0,0,73,69,78,68,0,0,0,0]);
 const post=await both({key:'k',method:'POST',input:{brand:'fish',operation_id:OP,sha256:require('node:crypto').createHash('sha256').update(bytes).digest('hex'),content_type:'image/png',bytes}});
 assert.notEqual(post.status,409,'GET pendente não bloqueia a marca');release();assert.equal((await pending).status,200);
 // Transporte: listar é GET sem corpo e sem seguir redirect.
 const seen=[];const t=M.mediaTransport({origin:ORIGIN,username:'u',token:'t',fetchFn:async(u,init)=>{seen.push([u,init]);return new Response(JSON.stringify({data:{results:[],total:0,page:1,per_page:24}}),{status:200});}});
 await t.list({page:1,perPage:24,query:''});assert.equal(seen[0][1].method,undefined);assert.equal(seen[0][1].body,undefined);assert.equal(seen[0][1].redirect,'manual');assert.match(seen[0][0],/^https:\/\/email\.shrigma\.com\.br\/api\/media\?page=1&per_page=24&query=$/);
 // SQL: a cadeia de autenticação do GET não escreve; o caminho que grava ultimo_uso não está nela.
 const read=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
 const fn=(src,name)=>{const all=[...src.matchAll(new RegExp('CREATE (?:OR REPLACE )?FUNCTION public\\.'+name+'\\(','g'))],at=all.length?all.at(-1).index:-1;assert.ok(at>=0,name);const ends=['\nCREATE ','\nREVOKE '].map(m=>src.indexOf(m,at)).filter(i=>i>0);return src.slice(at,ends.length?Math.min(...ends):undefined);};
 const gw=read('n8n/growth/crm-campaign-gateway-role.sql'),op=read('n8n/access/panel-operator.sql'),sk=read('n8n/access/panel-short-keys.sql');
 const chain=[fn(gw,'shrigma_crm_campaign_auth_v1'),fn(op,'shrigma_crm_operator_auth_v1'),fn(op,'shrigma_panel_operator_v1'),fn(sk,'shrigma_panel_operator_v1'),fn(sk,'shrigma_template_auth_v2')];
 for(const body of chain)assert.doesNotMatch(body,/\b(INSERT|UPDATE|DELETE|FOR\s+(SHARE|UPDATE)|shrigma_panel_auth_v1|nextval|pg_advisory)\b/i,body.slice(0,80));
 for(const body of chain.slice(1))assert.match(body,/\bSTABLE\b/);
 assert.match(fn(sk,'shrigma_panel_auth_v1'),/UPDATE public\.crm_dash_chave/,'contraprova: este sim grava, e não é chamado pelo GET');
});

test('nome canônico confere com media.cjs; pedido canônico e recuperação fora da leitura',()=>{
 for(const name of [canon('fish'),canon('aristo',2,'jpg'),canon('fish',3,'gif',OP.toUpperCase()),'crm-fish-x.png','CRM-FISH-'+OP+'-'+'a'.repeat(64)+'.png','crm-olivas-'+OP+'-'+'a'.repeat(64)+'.png',canon('fish').replace('.png','.jpeg'),canon('fish').replace('-4111-','-1111-'),'legacy.png',''])
  assert.deepEqual(V.filenameParts(name),M.filenameParts(name),name);
 assert.equal(V.mediaRequest(new URLSearchParams('brand=fish')).query.toString(),'brand=fish&page=1&per_page=24');
 assert.equal(V.mediaRequest(new URLSearchParams('per_page=50&page=3&brand=aristo')).query.toString(),'brand=aristo&page=3&per_page=50');
 for(const q of ['brand=olivas','brand=fish&brand=aristo','brand=fish&page=0','brand=fish&page=01','brand=fish&per_page=51','brand=fish&page=10001','brand=fish&k=x','brand=fish&operation_id='+OP+'&filename=x&sha256='+'a'.repeat(64)])
  assert.throws(()=>V.mediaRequest(new URLSearchParams(q)),{code:'MEDIA_READ_REQUEST_INVALID'},q);
});

test('legado: marcado ou excluído; prefixo de outra marca e legado irregular saem; nada disso conta como da marca',()=>{
 const items=[out(canon('fish'),1),out('promo verão.png',2),out('crm-aristo-banner.png',3),out('CRM-OLIVAS-x.png',4),out('crm-fish-antigo.png',5),
  {...out('logo.png',6),url:ORIGIN+'/uploads/outro.png'},{...out('foto',7),content_type:'image/png'},out('logo@2x.png',8)];
 const v=ok(body('fish',items,{total:8}));
 assert.deepEqual(v.body.items.map(i=>[i.id,i.legacy]),[[1,false],[2,true],[5,true],[8,true]]);
 assert.deepEqual({...v.summary},{brand_items:1,legacy_items:3,excluded_legacy:0,excluded_foreign_prefix:2,excluded_irregular:2});
 const e=ok(body('fish',items,{total:8}),{legacy:'exclude'});assert.deepEqual(e.body.items.map(i=>i.id),[1]);assert.equal(e.summary.excluded_legacy,3);
 assert.equal(ok(body('aristo',[out('crm-aristo-banner.png',3)])).body.items[0].legacy,true,'prefixo da própria marca sem nome canônico continua legado');
});

test('resposta fora do contrato é recusada inteira: marca, URL, credencial, paginação e item',()=>{
 const good=out(canon('fish'),1),deny=(b,code,opts)=>assert.throws(()=>ok(b,opts),e=>e instanceof V.MediaReadValidationError&&e.status===502&&(!code||e.code===code),JSON.stringify(b).slice(0,160));
 ok(body('fish',[good]));
 deny(body('fish',[out(canon('aristo'),1)]),'MEDIA_READ_FOREIGN_BRAND');
 deny(body('aristo',[good]),'MEDIA_READ_FOREIGN_BRAND');
 deny({...body('fish',[good]),brand:'aristo'},null,{brand:'fish'});
 deny({...body('fish',[good]),contract:'crm-media-v2'});deny({...body('fish',[good]),state:'found'});deny([good]);
 const {next_page:_,...noNext}=body('fish',[good]);deny(noNext);
 for(const url of ['http://email.shrigma.com.br/uploads/'+good.filename,'https://evil.example/uploads/'+good.filename,'https://user:pw@email.shrigma.com.br/uploads/'+good.filename,'https://email.shrigma.com.br:8443/uploads/'+good.filename,
  'https://email.shrigma.com.br/uploads/'+good.filename+'?token=abc','https://email.shrigma.com.br/uploads/'+good.filename+'?','https://email.shrigma.com.br/uploads/'+good.filename+'#x','https://email.shrigma.com.br/media/'+good.filename,
  'https://email.shrigma.com.br/uploads/a/'+good.filename,'https://email.shrigma.com.br/uploads/..%2f'+good.filename,'https://EMAIL.shrigma.com.br/uploads/'+good.filename,'javascript:alert(1)',' https://email.shrigma.com.br/uploads/'+good.filename])
  deny(body('fish',[{...good,url}]),null);
 deny(body('fish',[{...good,thumb_url:'https://evil.example/uploads/t.png'}]),'MEDIA_READ_URL_DENIED');
 deny(body('fish',[{...good,thumb_url:'https://email.shrigma.com.br/uploads/t.png?sig=1'}]),'MEDIA_READ_URL_DENIED');
 assert.equal(ok(body('fish',[{...good,thumb_url:'https://email.shrigma.com.br/uploads/thumb_'+good.filename}])).body.items[0].thumb_url.endsWith('thumb_'+good.filename),true);
 deny(body('fish',[{...good,filename:good.filename+SECRET}]),'MEDIA_READ_SECRET_ECHO');
 deny(body('fish',[{...out('legado.png',1),created_at:SECRET}]),'MEDIA_READ_SECRET_ECHO');
 for(const bad of [{...good,extra:1},{...good,id:0},{...good,id:'1'},{...good,content_type:'image/webp'},{...good,content_type:'image/svg+xml'},{...good,content_type:'image/jpeg'},{...good,width:5000,height:5000},{...good,width:0},{...good,created_at:'ontem'},{...good,filename:'a/b.png'},{...good,filename:'x'.repeat(181)}])
  deny(body('fish',[bad]),null);
 deny(body('fish',[good,{...good}]),'MEDIA_READ_ITEM_INVALID');
 // Paginação
 deny(body('fish',[good],{per_page:50}),'MEDIA_READ_PAGE_INVALID');
 deny(body('fish',[good],{total:30,next_page:null}),'MEDIA_READ_PAGE_INVALID');
 deny(body('fish',[good],{total:30,next_page:3}),'MEDIA_READ_PAGE_INVALID');
 ok(body('fish',[good],{total:30,next_page:2}));
 ok(body('fish',[],{page:4,total:200,next_page:5}),{page:1});
 deny(body('fish',[],{page:2,total:200,next_page:3}),'MEDIA_READ_PAGE_INVALID',{page:1});
 deny(body('fish',[good],{page:5,total:200,next_page:6}),'MEDIA_READ_PAGE_INVALID',{page:1});
 deny(body('fish',[good],{page:2,total:24,next_page:null}),'MEDIA_READ_PAGE_INVALID',{page:2});
 deny(body('fish',Array.from({length:25},(_,i)=>out(canon('fish',i+1),i+1)),{total:25}),'MEDIA_READ_PAGE_INVALID');
 deny(body('fish',[],{total:0,page:2,next_page:null}),'MEDIA_READ_PAGE_INVALID',{page:1});
 deny(body('fish',[good],{total:1000001}),'MEDIA_READ_PAGE_INVALID');
 assert.throws(()=>V.validateMediaLibraryResponse(body('fish',[good]),{brand:'fish',page:1,per_page:24,allowedOrigin:'http://email.shrigma.com.br'}),{code:'MEDIA_READ_VALIDATOR_CONFIG'});
 assert.throws(()=>V.validateMediaLibraryResponse(body('fish',[good]),{brand:'olivas',page:1,per_page:24}),{code:'MEDIA_READ_VALIDATOR_CONFIG'});
});
