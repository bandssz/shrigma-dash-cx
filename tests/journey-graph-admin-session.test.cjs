'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const D=require('../tools/graph-admin-session/dbgate-6.cjs');
const READ='SELECT 1 AS count;',WRITE='DO $graph_install$ BEGIN PERFORM 1; END $graph_install$;';
const SID='00000000-0000-4000-8000-000000000001',OTHER='00000000-0000-4000-8000-000000000099';
const columns=[...D.IDENTITY_COLUMNS],tick=()=>new Promise(r=>setImmediate(r));
function fixture(options={}){
 const calls=[],records=new Map(),intervals=new Map(),timeouts=new Map();let sse,closed=false,sequence=2,timeout=0,appName='DbGate',pid=101,writes=0,statsPolls=0,intent=false,xid=1000,cancelledBodies=0;
 const timers={setTimeout(fn,ms){const timer=setTimeout(()=>{timeouts.delete(timer);fn();},ms===50?0:ms);if(ms>=5000)timer.unref();timeouts.set(timer,{fn,ms});return timer;},clearTimeout(timer){clearTimeout(timer);timeouts.delete(timer);},setInterval(fn,ms){const key={};intervals.set(key,{fn,ms});return key;},clearInterval(key){intervals.delete(key);}};
 const json=(x,status=200)=>new Response(JSON.stringify(x),{status,headers:{'content-type':'application/json'}});
 const emit=(name,data=null)=>{if(!closed)sse.enqueue(new TextEncoder().encode('event: '+name+'\ndata: '+JSON.stringify(data)+'\n\n'));};
 function result(rows,cols){const id='00000000-0000-4000-8000-'+String(sequence++).padStart(12,'0');records.set(id,{rows,columns:cols.map(columnName=>({columnName}))});emit('session-recordset-'+SID,{jslid:id,resultIndex:0});}
 const fetch=async(url,request)=>{
  const u=new URL(url),body=request.body===undefined?undefined:JSON.parse(request.body);calls.push({url:u,request,body});assert.equal(request.redirect,'manual');
  if(options.hangBody===u.pathname)return new Response(new ReadableStream({cancel(){cancelledBodies++;}}),{status:200,headers:{'content-type':'application/json'}});
  if(u.pathname==='/')return new Response(null,{status:302,headers:{location:options.redirect||'/','set-cookie':options.cookie||'easypanel_token=syntheticCookie; Path=/; HttpOnly; SameSite=Lax'}});
  assert.equal(request.headers.cookie,'easypanel_token=syntheticCookie');assert.equal(u.searchParams.has('easypanel-token'),false);
  if(u.pathname==='/config/get')return json({version:options.version||D.VERSION,buildTime:D.BUILD_TIME,isDocker:true,isElectron:false});
  if(u.pathname==='/auth/get-providers')return json(options.providers||{default:'none',providers:[{amoid:'none',workflowType:'anonymous'}]});
  if(u.pathname==='/auth/login'){assert.deepEqual(body,{amoid:'none'});return json({accessToken:'synthetic.payload.signature'});}
  assert.equal(request.headers.authorization,'Bearer synthetic.payload.signature');
  if(u.pathname==='/connections/list')return json([{_id:'EASYPANEL',server:'comunicacao_postgres',user:'postgres',engine:'postgres@dbgate-plugin-postgres',useDatabaseUrl:false,...options.connection}]);
  if(u.pathname==='/stream')return new Response(new ReadableStream({start(c){sse=c;},cancel(){closed=true;}}),{headers:{'content-type':'text/event-stream'}});
  if(u.pathname==='/sessions/create'){if(options.loseCreateAck)throw Error('secret create response');assert.deepEqual(body,{conid:'EASYPANEL',database:'listmonk'});return json({conid:'EASYPANEL',database:'listmonk',sesid:SID});}
  if(u.pathname==='/sessions/ping'){assert.equal(body.sesid,SID);return json(options.pingFailure?{status:'error'}:{state:'ok'});}
  if(u.pathname==='/sessions/execute-query'){
   assert.equal(body.sesid,SID);const sql=body.sql;
   if(sql===D.IDENTITY_SQL)result([{database:options.database||'listmonk',role:options.role||'postgres',pid,statement_timeout_ms:timeout,application_name:appName,transaction_isolation:options.isolation||'read committed',transaction_read_only:options.readOnly||'off',transaction_id:String(options.fixedXid||xid++)}],columns);
   else if(sql==='SET statement_timeout = 20000;')timeout=options.rejectTimeout?0:20000;
   else if(sql.startsWith('SET application_name = '))appName=sql.match(/'([^']+)'/)[1];
   else if(sql===READ){
    // Another session's records and malformed JSON must never be parsed/returned.
    emit('session-recordset-'+OTHER,{jslid:OTHER,resultIndex:0});
    sse.enqueue(new TextEncoder().encode('event: session-info-'+OTHER+'\ndata: NOT_JSON\n\n'));
    result(options.rows||[{count:1}],options.resultColumns||['count']);
   }else if(sql===WRITE){
    writes++;if(options.beforeWrite)options.beforeWrite();
    if(options.writeError)emit('session-info-'+SID,{severity:'error',message:'private SQL must not escape'});
    if(options.loseWriteAck)throw Error('secret URL https://user:password@example.test');
    if(options.loseSse){sse.close();closed=true;return json({state:'ok'});}
    if(options.dropDone)return json({state:'ok'});
   }else assert.fail('Unexpected SQL');
   emit('session-done-'+SID);return json({state:'ok'});
  }
  if(u.pathname==='/jsldata/get-stats'){assert.ok(records.has(body.jslid));statsPolls++;return json({isFinished:!(options.delayedStats&&statsPolls===1),rowCount:records.get(body.jslid).rows.length});}
  if(u.pathname==='/jsldata/get-info')return json({columns:records.get(body.jslid).columns});
  if(u.pathname==='/jsldata/get-rows'){assert.equal(body.offset,0);assert.equal(body.limit,2);return json(records.get(body.jslid).rows);}
  if(u.pathname==='/sessions/kill'){assert.equal(body.sesid,SID);emit('session-closed-'+SID);return json({state:'ok'});}
  assert.fail('Unexpected path '+u.pathname);
 };
 const client=D.createDbGateSession({origin:'https://dbgate.example.test',accessToken:'syntheticEasypanelToken',connection:{id:'EASYPANEL',server:'comunicacao_postgres'},reads:[{sql:READ,columns:['count'],maxRows:1}],fetch,timers,
  authorizeWrite:async request=>{assert.equal(request.sql,WRITE);assert.equal(request.sha256,crypto.createHash('sha256').update(WRITE).digest('hex'));assert.equal(request.session.pid,pid);if(options.authorizeThrow)throw Error('secret callback');intent=true;return options.authorized!==false;}});
 return {client,calls,intervals,timeouts,writeCount:()=>writes,hasIntent:()=>intent,streamClosed:()=>closed,statsPolls:()=>statsPolls,cancelledBodies:()=>cancelledBodies,setPid:value=>{pid=value;},emit,
  async dispose(){try{await client.close();}catch{}for(const timer of timeouts.keys())timers.clearTimeout(timer);},
  fireDeadline(){for(const [timer,item] of timeouts)if(item.ms===35000){timers.clearTimeout(timer);item.fn();}}
 };
}
test('authenticated anonymous provider, dedicated identity, 20s timeout and own-session cleanup',async()=>{
 const f=fixture();try{const proof=await f.client.open();assert.equal(proof.pid,101);assert.equal(proof.sessionid,SID);assert.equal(proof.autocommit,true);assert.equal(proof.transaction_isolation,'read committed');assert.equal('transaction_id' in proof,false);const {opened,...identity}=proof;assert.deepEqual(await f.client.identity(),identity);assert.equal(proof.statement_timeout_ms,20000);assert.match(proof.application_name,/^crm-graph-install-[a-f0-9-]+$/);assert.deepEqual(await f.client.sql(READ),[{count:1}]);
  assert.deepEqual([...f.intervals.values()].map(x=>x.ms),[10000]);await [...f.intervals.values()][0].fn();
  assert.equal(f.calls.filter(c=>c.url.searchParams.has('easypanel-token')).length,1);assert.equal(f.calls.find(c=>c.url.pathname==='/sessions/create').body.database,'listmonk');
  assert.deepEqual(await f.client.close(),{closed:true});assert.equal(f.intervals.size,0);assert.equal(f.calls.filter(c=>c.url.pathname==='/sessions/kill').length,1);
 }finally{await f.dispose();}
});
test('version, auth provider, redirect and connection mismatch fail before session creation',async()=>{
 for(const options of [{version:'6.0.1'},{providers:{default:'logins',providers:[{amoid:'logins',workflowType:'credentials'}]}},{redirect:'https://other.example.test/'},{cookie:'easypanel_token=syntheticCookie; Path=/; HttpOnly; Domain=example.test'},{connection:{useDatabaseUrl:true}},{connection:{engine:'mysql@dbgate-plugin-mysql'}},{connection:{user:'central_leitor'}},{connection:{server:'other_postgres'}},{connection:{isReadOnly:'true'}},{connection:{useSshTunnel:true}}]){
  const f=fixture(options);await assert.rejects(f.client.open(),/GRAPH_ADMIN_/);assert.equal(f.calls.some(c=>c.url.pathname==='/sessions/create'),false);await f.dispose();
 }
});
test('identity or missing timeout blocks opening and no DO is submitted',async()=>{
 for(const options of [{database:'chatwoot'},{role:'central_leitor'},{rejectTimeout:true}]){const f=fixture(options);try{await assert.rejects(f.client.open(),/DB_IDENTITY|DB_TIMEOUT/);await assert.rejects(f.client.sql(WRITE),/NOT_OPEN/);assert.equal(f.writeCount(),0);}finally{await f.dispose();}}
});
test('exact allowlist rejects arbitrary SQL; successful DO requires prior durable intent and cannot repeat',async()=>{
 const f=fixture({beforeWrite:()=>assert.equal(f.hasIntent(),true)});try{await f.client.open();for(const sql of ['SELECT * FROM subscribers;','BEGIN;','SET statement_timeout=0;','ALTER ROLE postgres LOGIN;',WRITE+' '+WRITE,'DO $graph_install$ BEGIN PERFORM 1; END $acl_preservation$;'])await assert.rejects(f.client.sql(sql),/SQL_NOT_ALLOWED/);
  assert.deepEqual(await f.client.sql(WRITE),[]);assert.equal(f.writeCount(),1);await assert.rejects(f.client.sql(WRITE),/WRITE_ALREADY_ATTEMPTED/);assert.deepEqual(await f.client.sql(READ),[{count:1}]);
 }finally{await f.dispose();}
});
test('changed backend PID refuses DO before authorization or dispatch',async()=>{
 const f=fixture();try{await f.client.open();f.setPid(202);await assert.rejects(f.client.sql(WRITE),/DB_IDENTITY/);assert.equal(f.hasIntent(),false);assert.equal(f.writeCount(),0);}finally{await f.dispose();}
});
test('authorization rejection or uncertain callback never sends DO',async()=>{
 for(const options of [{authorized:false},{authorizeThrow:true}]){const f=fixture(options);try{await f.client.open();await assert.rejects(f.client.sql(WRITE),/WRITE_NOT_AUTHORIZED|INTENT_UNKNOWN/);assert.equal(f.writeCount(),0);if(options.authorizeThrow)await assert.rejects(f.client.sql(WRITE),/WRITE_ALREADY_ATTEMPTED/);}finally{await f.dispose();}}
});
test('SQL error followed by done is failure, still permits readback, never retries the write',async()=>{
 const f=fixture({writeError:true});try{await f.client.open();await assert.rejects(f.client.sql(WRITE),error=>error.message==='GRAPH_ADMIN_SQL_REJECTED');assert.equal(f.writeCount(),1);assert.deepEqual(await f.client.sql(READ),[{count:1}]);await assert.rejects(f.client.sql(WRITE),/WRITE_ALREADY_ATTEMPTED/);}finally{await f.dispose();}
});
test('lost acknowledgement or lost SSE blocks further execution and does not expose secret errors',async()=>{
 for(const options of [{loseWriteAck:true},{loseSse:true}]){const f=fixture(options);try{await f.client.open();await assert.rejects(f.client.sql(WRITE),error=>/^GRAPH_ADMIN_(TRANSPORT_UNKNOWN|SESSION_UNKNOWN)$/.test(error.message));await assert.rejects(f.client.sql(READ),/NOT_OPEN/);await assert.rejects(f.client.sql(WRITE),/NOT_OPEN/);assert.equal(f.writeCount(),1);}finally{await f.dispose();}}
});
test('missing completion becomes uncertain and concurrent operations are refused',async()=>{
 const f=fixture({dropDone:true});try{await f.client.open();const pending=f.client.sql(WRITE);await tick();await assert.rejects(f.client.sql(READ),/BUSY/);f.fireDeadline();await assert.rejects(pending,/SESSION_UNKNOWN/);assert.equal(f.writeCount(),1);}finally{await f.dispose();}
});
test('finished result file and exact row/column allowlists are required',async()=>{
 const delayed=fixture({delayedStats:true});try{await delayed.client.open();assert.ok(delayed.statsPolls()>2);assert.deepEqual(await delayed.client.sql(READ),[{count:1}]);}finally{await delayed.dispose();}
 for(const options of [{rows:[{count:1},{count:2}]},{resultColumns:['private_email'],rows:[{private_email:'synthetic'}]},{rows:[{count:1,private_email:'synthetic'}]}]){const f=fixture(options);try{await f.client.open();await assert.rejects(f.client.sql(READ),/RESULT_/);assert.equal(f.writeCount(),0);}finally{await f.dispose();}}
});

test('root-default cookie scope is accepted without an explicit Path attribute',async()=>{
 const f=fixture({cookie:'easypanel_token=syntheticCookie; HttpOnly; SameSite=Lax'});try{await f.client.open();assert.deepEqual(await f.client.sql(READ),[{count:1}]);}finally{await f.dispose();}
});
test('transaction wrapper or non READ COMMITTED mode refuses opening before any write',async()=>{
 for(const options of [{fixedXid:77},{isolation:'repeatable read'},{readOnly:'on'}]){const f=fixture(options);try{await assert.rejects(f.client.open(),/AUTOCOMMIT_UNPROVEN|DB_TRANSACTION/);assert.equal(f.writeCount(),0);}finally{await f.dispose();}}
});
test('full response-body deadlines abort both authentication and an execution acknowledgement',async()=>{
 const auth=fixture({hangBody:'/config/get'});try{const opened=auth.client.open();await tick();auth.fireDeadline();await assert.rejects(opened,/TRANSPORT_UNKNOWN/);assert.equal(auth.cancelledBodies(),1);assert.equal(auth.calls.some(c=>c.url.pathname==='/sessions/create'),false);}finally{await auth.dispose();}
 const options={},f=fixture(options);try{await f.client.open();options.hangBody='/sessions/execute-query';const read=f.client.sql(READ);await tick();f.fireDeadline();await assert.rejects(read,/TRANSPORT_UNKNOWN|SESSION_UNKNOWN/);assert.equal(f.cancelledBodies(),1);await assert.rejects(f.client.sql(READ),/NOT_OPEN/);}finally{await f.dispose();}
});

test('bootstrap accepts absolute same-origin root only, without following redirects',async()=>{
 const f=fixture({redirect:'https://dbgate.example.test/'});try{await f.client.open();assert.equal(f.calls.filter(c=>c.url.pathname==='/').length,1);}finally{await f.dispose();}
 for(const redirect of ['https://other.example.test/','https://user@dbgate.example.test/','http://dbgate.example.test/','https://dbgate.example.test/?token=private','https://dbgate.example.test/#private','https://dbgate.example.test/other']){const f=fixture({redirect});try{await assert.rejects(f.client.open(),/AUTH_REDIRECT/);assert.equal(f.calls.length,1);}finally{await f.dispose();}}
});

test('result collection is included in the execution deadline, even after done',async()=>{
 const options={},f=fixture(options);try{await f.client.open();options.hangBody='/jsldata/get-rows';const read=f.client.sql(READ);await tick();f.fireDeadline();await assert.rejects(read,/SESSION_UNKNOWN|TRANSPORT_UNKNOWN/);await assert.rejects(f.client.sql(READ),/NOT_OPEN/);}finally{await f.dispose();}
});

test('uncertain session creation cancels local SSE without guessing a session to kill',async()=>{
 const f=fixture({loseCreateAck:true});try{await assert.rejects(f.client.open(),/TRANSPORT_UNKNOWN/);await assert.rejects(f.client.close(),/NO_OWN_SESSION/);assert.equal(f.streamClosed(),true);assert.equal(f.calls.some(c=>c.url.pathname==='/sessions/kill'),false);assert.equal(f.writeCount(),0);}finally{await f.dispose();}
});
