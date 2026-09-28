'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const D=require('../tools/graph-admin-session/dbgate-6.cjs');
const READ='SELECT 1 AS count;',PREPARE='DO $credential_prepare$ BEGIN PERFORM 1; END $credential_prepare$;',FINAL='DO $worker_access$ BEGIN PERFORM 1; END $worker_access$;';
const LEGACY='DO $graph_install$ BEGIN PERFORM 1; END $graph_install$;',ACL='DO $acl_preservation$ BEGIN PERFORM 1; END $acl_preservation$;';
const SID='10000000-0000-4000-8000-000000000001',hash=s=>crypto.createHash('sha256').update(s).digest('hex');
function fixture(options={}){
 const calls=[],statements=[],records=new Map(),intervals=new Map();let stream,closed=false,next=2,timeout=0,app='DbGate',readonly=options.initialReadOnly||'off',search=['public'],pid=99,xid=100,writes=0,readCount=0,authorizations=0;
 const mode=options.mode||'worker-access',database=Object.hasOwn(options,'database')?options.database:mode==='worker-scope-read'?'postgres':undefined;
 const actualDatabase=options.actualDatabase||database||'listmonk';
 const emit=(event,value)=>stream.enqueue(new TextEncoder().encode('event: '+event+'\ndata: '+JSON.stringify(value??null)+'\n\n'));
 const json=value=>new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});
 function result(rows,columns){const id='10000000-0000-4000-8000-'+String(next++).padStart(12,'0');records.set(id,{rows,columns:columns.map(columnName=>({columnName}))});emit('session-recordset-'+SID,{jslid:id,resultIndex:0});}
 const fetch=async(url,request)=>{
  const route=new URL(url).pathname,body=request.body?JSON.parse(request.body):null;calls.push({route,body});assert.equal(request.redirect,'manual');
  if(route==='/')return new Response(null,{status:302,headers:{location:'/','set-cookie':'easypanel_token=synthetic; HttpOnly'}});
  if(route==='/config/get')return json({version:D.VERSION,buildTime:D.BUILD_TIME,isDocker:true,isElectron:false});
  if(route==='/auth/get-providers')return json({default:'none',providers:[{amoid:'none',workflowType:'anonymous'}]});
  if(route==='/auth/login')return json({accessToken:'synthetic.payload.signature'});
  if(route==='/connections/list')return json([{_id:'EASYPANEL',server:'comunicacao_postgres',user:'postgres',engine:'postgres@dbgate-plugin-postgres',useDatabaseUrl:false}]);
  if(route==='/stream')return new Response(new ReadableStream({start(c){stream=c;},cancel(){closed=true;}}),{headers:{'content-type':'text/event-stream'}});
  if(route==='/sessions/create'){assert.deepEqual(body,{conid:'EASYPANEL',database:database||'listmonk'});return json({...body,sesid:SID});}
  if(route==='/sessions/ping')return json({state:'ok'});
  if(route==='/sessions/execute-query'){
   assert.equal(body.sesid,SID);const sql=body.sql;statements.push(sql);
   if(sql===D.WORKER_IDENTITY_SQL)result([{database:options.identityDatabase||actualDatabase,role:options.role||'postgres',pid,statement_timeout_ms:timeout,application_name:app,transaction_isolation:options.isolation||'read committed',transaction_read_only:readonly,transaction_id:String(options.fixedXid||xid++),search_schemas:search}],D.WORKER_IDENTITY_COLUMNS);
   else if(sql==='SET statement_timeout = 20000;')timeout=options.rejectTimeout?0:20000;
   else if(sql.startsWith('SET application_name = '))app=sql.match(/'([^']+)'/)[1];
   else if(sql==='SET search_path = pg_catalog,public;'){if(!options.rejectSearch)search=['pg_catalog','public'];}
   else if(sql==='SET default_transaction_read_only = on;'){if(!options.rejectReadOnly)readonly='on';}
   else if(sql===READ){readCount++;result([{count:1}],['count']);}
   else if(sql===PREPARE||sql===FINAL){writes++;if(options.lostAck)throw Error('private transport details');if(options.sqlError)emit('session-info-'+SID,{severity:'error',message:'private server details'});}
   else assert.fail('UNEXPECTED_SQL');
   emit('session-done-'+SID);return json({state:'ok'});
  }
  if(route==='/jsldata/get-stats')return json({isFinished:true,rowCount:records.get(body.jslid).rows.length});
  if(route==='/jsldata/get-info')return json({columns:records.get(body.jslid).columns});
  if(route==='/jsldata/get-rows')return json(records.get(body.jslid).rows);
  if(route==='/sessions/kill'){emit('session-closed-'+SID);return json({state:'ok'});}
  assert.fail('UNEXPECTED_ROUTE');
 };
 const config={origin:'https://dbgate.example.test',accessToken:'syntheticAccessToken',connection:{id:'EASYPANEL',server:'comunicacao_postgres'},mode,database,
  reads:options.reads||[{sql:READ,columns:['count'],maxRows:1}],fetch,
  timers:{setTimeout,clearTimeout,setInterval(fn,ms){const id={};intervals.set(id,{fn,ms});return id;},clearInterval(id){intervals.delete(id);}}};
 if(mode!=='worker-scope-read'||options.supplyWriteCallback)config.authorizeWrite=async request=>{authorizations++;assert.equal(request.sha256,hash(request.sql));assert.equal(request.session.database,'listmonk');assert.equal(request.session.pid,pid);if(options.staleIntent)throw Error('STALE_PRIVATE_INTENT');return request.sha256===(options.expectedHash||hash(options.expectedSQL||PREPARE));};
 const client=D.createDbGateSession(config);
 return {client,calls,statements,writes:()=>writes,authorizations:()=>authorizations,readCount:()=>readCount,setPid:x=>{pid=x;},setReadOnly:x=>{readonly=x;},setSearch:x=>{search=x;},async dispose(){try{await client.close();}catch{}assert.equal(intervals.size,0);assert.equal(closed,true);}};
}
test('worker-access owns a listmonk session and configures search path before guarded reads',async()=>{
 const f=fixture();try{const proof=await f.client.open();assert.equal(proof.database,'listmonk');assert.equal(proof.transaction_read_only,'off');assert.deepEqual(proof.search_schemas,['pg_catalog','public']);assert.equal(proof.autocommit,true);
  assert.deepEqual(f.statements.slice(0,3),[D.WORKER_IDENTITY_SQL,D.WORKER_IDENTITY_SQL,'SET statement_timeout = 20000;']);assert.match(f.statements[3],/^SET application_name = 'crm-graph-worker-access-/);assert.equal(f.statements[4],'SET search_path = pg_catalog,public;');
  assert.deepEqual(await f.client.sql(READ),[{count:1}]);assert.ok(f.statements.indexOf(READ)>4);assert.equal(f.calls.some(c=>/save|update|restart/.test(c.route)),false);
 }finally{await f.dispose();}
});
test('worker-access accepts exactly one approved credential or access DO and refuses historical tags',async()=>{
 for(const sql of [PREPARE,FINAL]){const f=fixture({expectedSQL:sql});try{await f.client.open();for(const denied of [LEGACY,ACL,PREPARE+' '+FINAL,'BEGIN;','SET default_transaction_read_only=off;'])await assert.rejects(f.client.sql(denied),/SQL_NOT_ALLOWED/);assert.equal(f.authorizations(),0);await f.client.sql(sql);assert.equal(f.writes(),1);await assert.rejects(f.client.sql(sql),/WRITE_ALREADY_ATTEMPTED/);assert.deepEqual(await f.client.sql(READ),[{count:1}]);}finally{await f.dispose();}}
});
test('worker access refuses another database or changed backend before authorization',async()=>{
 for(const database of ['postgres','chatwoot'])assert.throws(()=>fixture({database}),/DATABASE_CONFIG/);
 for(const options of [{identityDatabase:'chatwoot'},{role:'central_leitor'},{rejectSearch:true},{rejectTimeout:true},{initialReadOnly:'on'},{fixedXid:101}]){const f=fixture(options);try{await assert.rejects(f.client.open(),/DB_IDENTITY|DB_SEARCH_PATH|DB_TIMEOUT|DB_TRANSACTION|AUTOCOMMIT_UNPROVEN/);assert.equal(f.writes(),0);}finally{await f.dispose();}}
 const f=fixture();try{await f.client.open();f.setPid(100);await assert.rejects(f.client.sql(PREPARE),/DB_IDENTITY/);assert.equal(f.authorizations(),0);assert.equal(f.writes(),0);}finally{await f.dispose();}
});
test('wrong approved hash and stale intent refuse dispatch; an uncertain callback consumes write eligibility',async()=>{
 for(const options of [{expectedHash:'0'.repeat(64)},{staleIntent:true}]){const f=fixture(options);try{await f.client.open();await assert.rejects(f.client.sql(PREPARE),/WRITE_NOT_AUTHORIZED|INTENT_UNKNOWN/);assert.equal(f.writes(),0);if(options.staleIntent)await assert.rejects(f.client.sql(PREPARE),/WRITE_ALREADY_ATTEMPTED/);}finally{await f.dispose();}}
});
test('worker lost acknowledgement never retries and sanitizes error output',async()=>{
 const f=fixture({lostAck:true});try{await f.client.open();await assert.rejects(f.client.sql(PREPARE),e=>e.message==='GRAPH_ADMIN_TRANSPORT_UNKNOWN');await assert.rejects(f.client.sql(PREPARE),/NOT_OPEN/);assert.equal(f.writes(),1);}finally{await f.dispose();}
});
test('scope-read requires an explicit valid database and no write callback',()=>{
 for(const options of [{database:undefined},{database:'listmonk; DROP DATABASE x'},{database:'template1'},{database:'UPPER'},{supplyWriteCallback:true}])assert.throws(()=>fixture({mode:'worker-scope-read',...options}),/DATABASE_CONFIG|CONFIG/);
});
test('scope-read sets its own read-only mode and allows exact SELECT reads on each audited database',async()=>{
 for(const database of ['postgres','chatwoot','listmonk'])for(const initialReadOnly of ['off','on']){const f=fixture({mode:'worker-scope-read',database,initialReadOnly});try{const proof=await f.client.open();assert.equal(proof.database,database);assert.equal(proof.transaction_read_only,'on');assert.deepEqual(proof.search_schemas,['pg_catalog','public']);assert.equal(proof.statement_timeout_ms,20000);assert.equal(f.statements[4],'SET search_path = pg_catalog,public;');assert.equal(f.statements[5],'SET default_transaction_read_only = on;');assert.deepEqual(await f.client.sql(READ),[{count:1}]);for(const sql of [PREPARE,FINAL,LEGACY,ACL,'SET default_transaction_read_only=off;','SELECT 2 AS count;'])await assert.rejects(f.client.sql(sql),/SQL_NOT_ALLOWED/);assert.equal(f.authorizations(),0);assert.equal(f.writes(),0);}finally{await f.dispose();}}
});
test('scope read-only/search-path/identity drift blocks the next read before dispatch',async()=>{
 for(const options of [{rejectReadOnly:true},{identityDatabase:'other'},{role:'central_leitor'},{rejectSearch:true}]){const f=fixture({mode:'worker-scope-read',...options});try{await assert.rejects(f.client.open(),/DB_TRANSACTION|DB_IDENTITY|DB_SEARCH_PATH/);assert.equal(f.readCount(),0);}finally{await f.dispose();}}
 for(const mutate of [f=>f.setReadOnly('off'),f=>f.setPid(999),f=>f.setSearch(['public','pg_catalog'])]){const f=fixture({mode:'worker-scope-read'});try{await f.client.open();mutate(f);await assert.rejects(f.client.sql(READ),/DB_TRANSACTION|DB_IDENTITY|DB_SEARCH_PATH/);assert.equal(f.readCount(),0);}finally{await f.dispose();}}
});
test('worker read specs cannot register a DO or a SELECT-prefixed command batch',()=>{
 for(const mode of ['worker-access','worker-scope-read'])for(const sql of [PREPARE,'SELECT 1; '+PREPARE,'SELECT 1; SET search_path=public;','SELECT \'unterminated','SELECT 1 /* missing'])assert.throws(()=>fixture({mode,reads:[{sql,columns:['count'],maxRows:1}]}),/READ_SPEC/);
});
