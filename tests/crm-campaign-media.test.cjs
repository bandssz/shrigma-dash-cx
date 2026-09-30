'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),{createHash}=require('node:crypto');
const {createMediaExecutor,mediaTransport,dimensions,validateFile,canonicalFilename}=require('../services/crm-campaign/media.cjs');
const {createServer,mediaGet,MEDIA_PATH}=require('../services/crm-campaign/server.cjs');
const {AUTH_SQL}=require('../services/crm-campaign/transport.cjs');

const operation='11111111-1111-4111-8111-111111111111';
function png(width=2,height=3){const signature=Buffer.from([137,80,78,71,13,10,26,10]),ihdr=Buffer.alloc(25),iend=Buffer.alloc(12);ihdr.writeUInt32BE(13,0);ihdr.write('IHDR',4);ihdr.writeUInt32BE(width,8);ihdr.writeUInt32BE(height,12);ihdr[16]=8;ihdr[17]=2;iend.writeUInt32BE(0,0);iend.write('IEND',4);return Buffer.concat([signature,ihdr,iend]);}
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const item=(filename,id=1,type='image/png',meta={width:2,height:3})=>({id,filename,content_type:type,url:'https://email.shrigma.com.br/uploads/'+filename,thumb_url:null,meta,created_at:'2026-09-30T10:00:00Z'});
const page=(results,total=results.length,p=1,per=50)=>({status:200,body:{data:{results,total,page:p,per_page:per}}});
function pool(identities=[{actor:'media-editor',caps:['read_content','edit_content']}]){let calls=0;return {get calls(){return calls;},async query(sql){assert.equal(sql,AUTH_SQL);return {rows:[{auth:identities[Math.min(calls++,identities.length-1)]}]};}};}

test('byte validation permits only bounded PNG, JPEG and GIF dimensions with exact declared MIME and hash',()=>{
 const bytes=png(),sha=hash(bytes);assert.deepEqual(dimensions(bytes),{type:'image/png',ext:'png',width:2,height:3});assert.equal(validateFile(bytes,'image/png',sha).hash,sha);
 assert.equal(validateFile(bytes,'image/jpeg',sha).error,'MEDIA_FILE_INVALID');assert.equal(validateFile(bytes,'image/png','0'.repeat(64)).error,'MEDIA_HASH_MISMATCH');
 assert.equal(dimensions(Buffer.from('RIFFxxxxWEBP')),null);assert.equal(dimensions(Buffer.from('<svg></svg>')),null);assert.equal(validateFile(png(4096,4096),'image/png',hash(png(4096,4096))).error,'MEDIA_FILE_INVALID');
 const broken=Buffer.from(bytes);broken[broken.length-8]=1;assert.equal(dimensions(broken),null);
});

test('mixed native pages filter unsupported existing files without losing provider pagination',async()=>{
 const bytes=png(),sha=hash(bytes),name=canonicalFilename('fish',operation,sha,'png'),native={origin:'https://email.shrigma.com.br',list:async()=>page([item(name),item('legacy.svg',2,'image/svg+xml',{width:1,height:1}),item('document.pdf',3,'application/pdf',{}),item('huge.png',4,'image/png',{width:5000,height:5000})],60,1,4)};
 const execute=createMediaExecutor({pool:pool(),native}),r=await execute({key:'read',method:'GET',input:{brand:'fish',page:1,per_page:4}});assert.equal(r.status,200);assert.equal(r.body.items.length,1);assert.equal(r.body.items[0].filename,name);assert.equal(r.body.total,60);assert.equal(r.body.next_page,2);
});

test('upload deduplicates by content hash, never posts twice and reauthenticates the same actor immediately before POST',async()=>{
 const bytes=png(),sha=hash(bytes),other='22222222-2222-4222-8222-222222222222',existing=canonicalFilename('fish',other,sha,'png');let uploads=0,lists=0;
 const native={origin:'https://email.shrigma.com.br',list:async({query})=>{lists++;assert.equal(query,sha);return page(lists===1?[item(existing)]:[]);},upload:async()=>{uploads++;throw Error('must not upload duplicate');}};
 let p=pool(),execute=createMediaExecutor({pool:p,native}),r=await execute({key:'edit',method:'POST',input:{brand:'fish',operation_id:operation,sha256:sha,content_type:'image/png',bytes}});assert.equal(r.status,200);assert.equal(r.body.state,'existing');assert.equal(uploads,0);assert.equal(p.calls,1);
 p=pool([{actor:'first',caps:['edit_content']},{actor:'second',caps:['edit_content']}]);execute=createMediaExecutor({pool:p,native:{origin:native.origin,list:async()=>page([]),upload:async()=>{uploads++;}}});r=await execute({key:'edit',method:'POST',input:{brand:'fish',operation_id:operation,sha256:sha,content_type:'image/png',bytes}});assert.equal(r.status,409);assert.equal(r.body.error,'MEDIA_ACTOR_CHANGED');assert.equal(r.body.posted,false);assert.equal(uploads,0);assert.equal(p.calls,2);
});

test('uncertain upload is single-shot and exact GET recovery finds only the generated filename',async()=>{
 const bytes=png(),sha=hash(bytes),name=canonicalFilename('aristo',operation,sha,'png');let uploaded=0,stored=false;
 const native={origin:'https://email.shrigma.com.br',list:async({query})=>page(stored&&query===name?[item(name)]:[]),upload:async()=>{uploaded++;stored=true;throw Error('lost ack');}};
 const execute=createMediaExecutor({pool:pool(),native}),request={brand:'aristo',operation_id:operation,sha256:sha,content_type:'image/png',bytes};const first=await execute({key:'edit',method:'POST',input:request});assert.equal(first.status,502);assert.equal(first.body.filename,name);assert.equal(uploaded,1);
 const read=await execute({key:'read',method:'GET',input:{brand:'aristo',operation_id:operation,sha256:sha,filename:name}});assert.equal(read.status,200);assert.equal(read.body.state,'found');assert.equal(read.body.media.filename,name);assert.equal(uploaded,1);
});

test('the per-brand backend mutex rejects concurrent upload work before a second native mutation',async()=>{
 const bytes=png(),sha=hash(bytes);let release,uploads=0,lists=0;const firstList=new Promise(resolve=>{release=resolve;});
 const native={origin:'https://email.shrigma.com.br',list:async()=>{lists++;if(lists===1)await firstList;return page([]);},upload:async({filename})=>{uploads++;return {status:201,body:{data:item(filename)}};}};
 const execute=createMediaExecutor({pool:pool(),native}),input={brand:'fish',operation_id:operation,sha256:sha,content_type:'image/png',bytes},first=execute({key:'edit',method:'POST',input});await new Promise(resolve=>setImmediate(resolve));const second=await execute({key:'edit',method:'POST',input});assert.equal(second.status,409);assert.equal(second.body.posted,false);release();const done=await first;assert.equal(done.status,201);assert.equal(uploads,1);
});

test('interruption during lookup refuses the native POST while an already-started POST remains outside cancellation',async()=>{
 const bytes=png(),sha=hash(bytes);let interrupted=false,release,uploads=0;const gate=new Promise(resolve=>{release=resolve;}),native={origin:'https://email.shrigma.com.br',list:async()=>{await gate;return page([]);},upload:async()=>{uploads++;throw Error('must not start');}},execute=createMediaExecutor({pool:pool(),native}),pending=execute({key:'edit',method:'POST',input:{brand:'fish',operation_id:operation,sha256:sha,content_type:'image/png',bytes},interrupted:()=>interrupted});await new Promise(resolve=>setImmediate(resolve));interrupted=true;release();const result=await pending;assert.equal(result.status,503);assert.equal(result.body.error,'MEDIA_INTERRUPTED');assert.equal(result.body.posted,false);assert.equal(uploads,0);
 let postStarted,finish;const started=new Promise(resolve=>{postStarted=resolve;}),posted=new Promise(resolve=>{finish=resolve;}),native2={origin:native.origin,list:async()=>page([]),upload:async({filename})=>{uploads++;postStarted();await posted;return {status:200,body:{data:item(filename)}};}},execute2=createMediaExecutor({pool:pool(),native:native2});interrupted=false;const inFlight=execute2({key:'edit',method:'POST',input:{brand:'fish',operation_id:operation,sha256:sha,content_type:'image/png',bytes},interrupted:()=>interrupted});await started;interrupted=true;finish();const completed=await inFlight;assert.equal(completed.status,201);assert.equal(completed.body.state,'created');assert.equal(uploads,1);
});

test('HTTP media query parser rejects non-canonical pagination',()=>{
 const request={rawHeaders:['Authorization','Bearer read'],headers:{authorization:'Bearer read'}};
 assert.throws(()=>mediaGet(request,new URL('http://local/media?brand=fish&page=1e0&per_page=24')),error=>error.status===422);
 assert.throws(()=>mediaGet(request,new URL('http://local/media?brand=fish&page=01&per_page=24')),error=>error.status===422);
});

test('native transport fixes Listmonk paths, uses multipart once and never follows redirects',async()=>{
 const calls=[],bytes=png(),native=mediaTransport({origin:'https://email.shrigma.com.br',username:'user',token:'secret',fetchFn:async(url,init)=>{calls.push({url,init});return new Response(JSON.stringify(url.includes('?')?{data:{results:[],total:0,page:1,per_page:24}}:{data:item('x.png')}),{status:200,headers:{'Content-Type':'application/json'}});}});
 await native.list({page:1,perPage:24,query:''});await native.upload({filename:'x.png',type:'image/png',bytes});assert.equal(calls.length,2);assert.match(calls[0].url,/\/api\/media\?/);assert.equal(calls[0].init.redirect,'manual');assert.equal(calls[1].url,'https://email.shrigma.com.br/api/media');assert.equal(calls[1].init.method,'POST');assert.ok(calls[1].init.body instanceof FormData);assert.doesNotMatch(JSON.stringify(calls),/secret/);
});

async function server(t,options={}){const app=createServer({revision:'a'.repeat(40),enabled:true,executor:async()=>({status:200,body:{ok:true}}),...options});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(()=>app.stop());return app;}
test('HTTP media route is OFF by default and ON accepts exact Bearer multipart without changing campaign route',async t=>{
 let calls=0;const off=await server(t,{mediaExecutor:async()=>{calls++;return {status:200,body:{}};}}),base=()=>`http://127.0.0.1:${off.server.address().port}`;let r=await fetch(base()+MEDIA_PATH+'?brand=fish',{headers:{Authorization:'Bearer read'}});assert.equal(r.status,503);assert.equal((await r.json()).posted,false);assert.equal(calls,0);assert.equal((await (await fetch(base()+'/healthz')).json()).media_enabled,false);
 const inputs=[],on=await server(t,{mediaEnabled:true,mediaExecutor:async value=>{inputs.push(value);return {status:value.method==='POST'?201:200,body:{contract:'crm-media-v1',brand:value.input.brand,items:[]}};}}),origin=`http://127.0.0.1:${on.server.address().port}`;
 r=await fetch(origin+MEDIA_PATH+'?brand=fish&page=1&per_page=24',{headers:{Authorization:'Bearer read'}});assert.equal(r.status,200);assert.equal(inputs[0].key,'read');assert.equal(inputs[0].method,'GET');
 const form=new FormData(),bytes=png(),sha=hash(bytes);form.append('brand','fish');form.append('operation_id',operation);form.append('sha256',sha);form.append('file',new Blob([bytes],{type:'image/png'}),'private-original-name.png');r=await fetch(origin+MEDIA_PATH,{method:'POST',headers:{Authorization:'Bearer edit'},body:form});assert.equal(r.status,201);assert.equal(inputs[1].key,'edit');assert.equal(inputs[1].input.content_type,'image/png');assert.deepEqual(inputs[1].input.bytes,bytes);assert.equal(Object.hasOwn(inputs[1].input,'filename'),false);
});

test('an expired client response does not release media admission before the initiated backend attempt settles',async t=>{
 let release;const gate=new Promise(resolve=>{release=resolve;}),app=await server(t,{mediaEnabled:true,writeDeadlineMs:20,maxPending:1,mediaExecutor:async()=>{await gate;return {status:201,body:{contract:'crm-media-v1',brand:'fish'}};}}),origin=`http://127.0.0.1:${app.server.address().port}`,form=new FormData(),bytes=png();form.append('brand','fish');form.append('operation_id',operation);form.append('sha256',hash(bytes));form.append('file',new Blob([bytes],{type:'image/png'}),'ignored.png');
 const response=await fetch(origin+MEDIA_PATH,{method:'POST',headers:{Authorization:'Bearer edit'},body:form});assert.equal(response.status,502);assert.equal((await response.json()).error,'MEDIA_OUTCOME_UNKNOWN');assert.equal(app.pending(),1);release();for(let i=0;i<30&&app.pending();i++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(app.pending(),0);
});
