'use strict';
// New synthetic proof only. No original transport, authority, credential or DB.
const a=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const net=require('node:net'),{spawn,spawnSync}=require('node:child_process'),{Client}=require('pg');
const here=__dirname,root=path.resolve(here,'../..'),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function check(v,c){if(!v)throw Error(c);}
const uri='postgresql://postgres@127.0.0.1:55432/listmonk';
async function until(fn,deadline,code){while(Date.now()<deadline){if(await fn())return;await wait(25);}throw Error(code);}
function child(exe,args,cwd){
 const p=spawn(exe,args,{cwd,env:{PATH:process.env.PATH,LANG:'C.UTF-8',PGOPTIONS:'-c TimeZone=Etc/UTC'},stdio:['ignore','pipe','pipe']});
 let data=Buffer.alloc(0),ended=false,exit=null,signal=null,bound=false;
 const capture=b=>{data=Buffer.concat([data,b]);if(data.length>1048576){bound=true;p.kill('SIGKILL');}};
 p.stdout.on('data',capture);p.stderr.on('data',capture);
 p.on('close',(c,s)=>{ended=true;exit=c;signal=s;});p.on('error',()=>{bound=true;ended=true;});
 return {p,get ended(){return ended},get exit(){return exit},get signal(){return signal},get bytes(){return data.length},get bound(){return bound},get body(){return data}};
}
async function mailpit(){
 const r=await fetch('http://127.0.0.1:58025/api/v1/messages',{signal:AbortSignal.timeout(2000)});
 check(r.status===200,'MAILPIT_READ_REFUSED');const b=Buffer.from(await r.arrayBuffer());check(b.length<=65536,'MAILPIT_OUTPUT_BOUND_REFUSED');
 const j=JSON.parse(b);check(Number.isSafeInteger(j.total)&&j.total>=0,'MAILPIT_SHAPE_REFUSED');return j.total;
}
// Real loopback SMTP frontend forwards exact synthetic bytes to Mailpit before
// withholding only the final DATA reply. Message/header bytes are RAM only.
async function smtpRelay(){
 const held={protected:false,direct:false},releases={},counts={protected:0,direct:0};let closed=false,forwarded=0,refusal=null;const sockets=new Set();
 const recipients={protected:'fish@example.invalid',direct:'drain-admin@fixture.invalid'};
 function forward(body,kind){return new Promise((resolve,reject)=>{
  const c=net.connect(51025,'127.0.0.1');sockets.add(c);let buffer='',step=0;
  const commands=['EHLO fixture\r\n','MAIL FROM:<smoke@example.invalid>\r\n','RCPT TO:<'+recipients[kind]+'>\r\n','DATA\r\n',body+'.\r\n','QUIT\r\n'];
  c.setTimeout(3000,()=>c.destroy(Error('SMTP_FORWARD_TIMEOUT')));c.on('error',reject);c.on('close',()=>sockets.delete(c));
  c.on('data',b=>{buffer+=b.toString('latin1');check(buffer.length<=65536,'SMTP_REPLY_BOUND_REFUSED');
   let end;while((end=buffer.indexOf('\r\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+2);if(!/^\d{3}[ -]/.test(line))return reject(Error('SMTP_REPLY_SHAPE_REFUSED'));if(line[3]==='-')continue;
    if(step===commands.length){c.end();return resolve();}
    if(!['220','250','354'].includes(line.slice(0,3)))return reject(Error('SMTP_FORWARD_REFUSED'));
    c.write(commands[step++],'latin1');
   }
  });
 });}
 const server=net.createServer(c=>{sockets.add(c);c.on('close',()=>sockets.delete(c));c.setTimeout(20000,()=>c.destroy());let b='',inData=false,body='',kind=null;
  c.write('220 isolated fixture\r\n');c.on('error',()=>{});
  c.on('data',chunk=>{b+=chunk.toString('latin1');if(b.length+body.length>131072){refusal='SMTP_BODY_BOUND_REFUSED';c.destroy();return;}
   let end;while((end=b.indexOf('\r\n'))>=0){const line=b.slice(0,end);b=b.slice(end+2);
    if(inData){if(line==='.'){
      inData=false;const bytes=body,messageKind=kind;body='';kind=null;
      if(!messageKind||counts[messageKind]!==0){refusal='SMTP_MESSAGE_CLASS_OR_DUPLICATE_REFUSED';c.destroy();return;}
      counts[messageKind]++;forward(bytes,messageKind).then(()=>{forwarded++;held[messageKind]=true;releases[messageKind]=()=>{held[messageKind]=false;c.write('250 isolated accepted\r\n');};}).catch(()=>{refusal='SMTP_FORWARD_REFUSED';c.destroy();});
     }else body+=line+'\r\n';continue;}
    const command=line.toUpperCase();if(command==='DATA'){inData=true;c.write('354 isolated fixture\r\n');}
    else if(command==='QUIT'){c.end('221 isolated fixture\r\n');}
    else if(command.startsWith('RCPT TO:')){
     const recipient=line.match(/^RCPT TO:<([^<>]+)>$/i);const selected=recipient&&Object.keys(recipients).find(k=>recipients[k]===recipient[1]);
     if(!selected||kind!==null){refusal='SMTP_RECIPIENT_CLASS_REFUSED';c.destroy();return;}kind=selected;c.write('250 isolated fixture\r\n');
    }
    else if(command==='RSET'){kind=null;c.write('250 isolated fixture\r\n');}
    else if(/^(EHLO|HELO|MAIL FROM:|RCPT TO:|RSET|NOOP)/.test(command))c.write('250 isolated fixture\r\n');
    else{refusal='SMTP_COMMAND_REFUSED';c.destroy();}
   }
  });
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 return {port:server.address().port,isHeld:k=>held[k],count:k=>counts[k],get forwarded(){return forwarded},get refusal(){return refusal},release:k=>{if(releases[k])releases[k]();},releaseAll:()=>{for(const k of Object.keys(releases))releases[k]();},close:async()=>{for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));closed=true;},get closed(){return closed}};
}
async function importRequest(token){
 const form=new FormData();form.set('params',JSON.stringify({mode:'subscribe',subscription_status:'confirmed',delim:',',lists:[9001],overwrite:false,overwrite_userinfo:false,overwrite_subscription_status:false}));
 form.set('file',new Blob(['email,name,attributes\nimported@fixture.invalid,Import synthetic,{}\n'],{type:'text/csv'}),'physical-drain.csv');
 const r=await fetch('http://127.0.0.1:50123/api/import/subscribers',{method:'POST',headers:{Authorization:'token physical-drain-fixture-api:'+token},body:form,signal:AbortSignal.timeout(3000)});
 const bytes=Buffer.from(await r.arrayBuffer());check(bytes.length<=16384,'IMPORT_RESPONSE_BOUND_REFUSED');
 check(r.status===200,'REAL_IMPORT_ENDPOINT_REFUSED');const j=JSON.parse(bytes);check(j&&j.data&&typeof j.data.status==='string','IMPORT_RESPONSE_SHAPE_REFUSED');
}
async function main(){
 a.equal(process.version,'v22.23.3');a.equal(process.getuid(),1000);a.equal(process.env.PHYSICAL_DRAIN_FIXTURE_ISOLATED,'1');a.equal(require('pg/package.json').version,'8.23.1');
 const assets=JSON.parse(fs.readFileSync(path.join(here,'ASSETS.json')));
 for(const [name,p]of Object.entries(assets.files)){const b=fs.readFileSync(path.join(root,name));check(b.length===p.bytes&&sha(b)===p.sha256,'SOURCE_PIN_REFUSED');}
 const runtime=path.resolve(process.argv[2]||'');check(runtime.startsWith('/tmp/')&&!fs.existsSync(path.join(root,'.git')),'FIXTURE_PATH_REFUSED');
 const build=JSON.parse(fs.readFileSync(path.join(runtime,'compile.json'))),exe=path.join(runtime,'listmonk.bin');
 check(sha(fs.readFileSync(exe))===build.binarySha256,'EXECUTABLE_PIN_REFUSED');
 const db=new Client({connectionString:uri,options:'-c TimeZone=Etc/UTC',statement_timeout:3000});
 const locker=new Client({connectionString:uri,options:'-c TimeZone=Etc/UTC',statement_timeout:3000});
 let relay,app,identity,lockOpen=false,dbEnded=false,lockerEnded=false,caseCount=0;
 const started=Date.now(),deadline=started+55000;
 const report={schema:'physical-drain-full-executable-native-proof-v1',ok:false,caseCount:0,originalCalls:0,originalWrites:0,operational:false,originalPhysicalDrainProved:false,candidate639Changed:false,newFutureExecutableTested:true,node:process.version,uid:process.getuid(),binarySha256:build.binarySha256};
 try{
  await db.connect();await locker.connect();a.equal((await db.query("SHOW server_version_num")).rows[0].server_version_num,'170010');
  // Dependency-only bootstrap deliberately leaves these objects absent.
  // Install the pinned REAL empty fixture dependency before the unchanged
  // inline gate/finalizer uses it; no stub, disposition or production grant.
  const SourceProfile=require(path.join(root,'tools/listmonk-regular-build/native_batch_profile.cjs'));
  await db.query(SourceProfile.readPermanentExclusionFixture(root));
  a.equal((await db.query('SELECT count(*)::integer n FROM crm_audience_v2.regular_delivery_permanent_exclusion')).rows[0].n,0);
  relay=await smtpRelay();const before=await mailpit();
  const values={smtp:[{enabled:true,host:'127.0.0.1',port:relay.port,auth_protocol:'none',username:'',password:'',hello_hostname:'example.invalid',max_conns:2,idle_timeout:'2s',wait_timeout:'2s',max_msg_retries:0,tls_type:'none',tls_skip_verify:false,email_headers:{}}],
   'app.root_url':'http://127.0.0.1:50123','app.from_email':'Smoke <smoke@example.invalid>','app.check_updates':false,'app.notify_emails':['drain-admin@fixture.invalid'],
   'app.enable_public_archive':false,'app.enable_public_subscription_page':false,'app.send_optin_confirmation':false,
   'app.concurrency':2,'app.message_rate':20,'app.batch_size':1,'app.max_send_errors':1,'app.cache_slow_queries':false,
   'privacy.individual_tracking':false,'privacy.disable_tracking':false,'privacy.unsubscribe_header':false,'bounce.enabled':false,'bounce.mailboxes':[],messengers:[]};
  for(const[k,v]of Object.entries(values))await db.query("INSERT INTO settings(key,value)VALUES($1,$2::jsonb)ON CONFLICT(key)DO UPDATE SET value=excluded.value",[k,JSON.stringify(v)]);
  // Genuine public API auth and importer, exclusively in this empty synthetic
  // loopback fixture. The token is random RAM-only, never a production actor.
  const apiToken=crypto.randomBytes(32).toString('hex');
  await db.query("INSERT INTO roles(id,type,name,permissions)VALUES(9001,'user','Physical synthetic import',ARRAY['subscribers:import','lists:manage_all'])");
  await db.query("INSERT INTO users(id,username,password_login,password,email,name,type,user_role_id,status)VALUES(9001,'physical-drain-fixture-api',false,$1,'api@fixture.invalid','Physical synthetic API','api',9001,'enabled')",[apiToken]);
  await db.query("INSERT INTO lists(id,uuid,name,type,optin,status,tags)VALUES(9001,gen_random_uuid(),'Physical isolated import','private','single','active',ARRAY['physical-fixture'])");
  await db.query("SELECT setval(pg_get_serial_sequence('public.subscribers','id'),(SELECT max(id) FROM public.subscribers),true)");
  // A nonempty RAM-only synthetic password keeps lib/pq from consuming dbname.
  // The isolated PostgreSQL fixture uses trust; no original credential is read.
  const fixtureDbPassword=crypto.randomBytes(16).toString('hex');
  const config=path.join(runtime,'config.toml');fs.writeFileSync(config,'[app]\naddress="127.0.0.1:50123"\n[db]\nhost="127.0.0.1"\nport=55432\nuser="postgres"\npassword="'+fixtureDbPassword+'"\ndatabase="listmonk"\nssl_mode="disable"\nmax_open=5\nmax_idle=5\nmax_lifetime="60s"\n',{mode:0o600});
  identity=child(exe,['--config',config,'--crm-regular-identity'],runtime);
  await until(()=>identity.ended,Math.min(deadline,Date.now()+5000),'IDENTITY_END_REFUSED');
  check(identity.exit===0&&!identity.bound,'IDENTITY_REFUSED');const lines=identity.body.toString().trim().split('\n');check(lines.length===1,'IDENTITY_FRAME_REFUSED');
  const id=JSON.parse(lines[0]);check(id.worker_sha256===build.binarySha256&&/^[a-f0-9]{64}$/.test(id.runtime_sha256),'MEASURED_IDENTITY_REFUSED');caseCount++;
  // The existing constructor installed genuine public functions with all
  // guarded worker/source states OFF. This NEW synthetic campaign is non-AB.
  // Correct its deliberately invalid quarantine binding before activation.
  const H=require(path.join(root,'n8n/growth/segment-audience-review.cjs'));
  const v=(await db.query('SELECT public.shrigma_campaign_current(400) current')).rows[0].current.version;
  const b=(await db.query('SELECT binding FROM crm_audience_v2.campaign_binding WHERE campaign_id=400')).rows[0].binding;b.campaign_version=v;
  const bh=H.digest(b);
  await db.query('UPDATE crm_audience_v2.campaign_binding SET campaign_version=$1,binding=$2::jsonb,binding_hash=$3 WHERE campaign_id=400',[v,JSON.stringify(b),bh]);
  await db.query('UPDATE crm_audience_v2.campaign_binding_revision SET binding=$1::jsonb,binding_hash=$2 WHERE campaign_id=400',[JSON.stringify(b),bh]);
  await db.query("UPDATE subscribers SET status='blocklisted' WHERE id IN(5,6,7)");
  await db.query("UPDATE campaigns SET status='draft' WHERE id=300");
  await db.query(`INSERT INTO crm_audience_v2.regular_sender_policy(brand,envelope_from,account_id,region,configuration_set,enabled)
   VALUES('fish','smoke@example.invalid','000000000000','native-fixture','native-fixture',true)`);
  await db.query(`INSERT INTO crm_audience_v2.regular_delivery_campaign(campaign_id,binding_version,binding_hash,material,worker_sha256,runtime_sha256,envelope_from,account_id,region,configuration_set,enabled)
   SELECT c.id,b.binding_version,b.binding_hash,crm_audience_v2.regular_delivery_material(c.id),$1,$2,'smoke@example.invalid','000000000000','native-fixture','native-fixture',true
   FROM public.campaigns c JOIN crm_audience_v2.campaign_binding_effective(c.id)b ON true WHERE c.id=400`,[id.worker_sha256,id.runtime_sha256]);
  await db.query(`UPDATE crm_audience_v2.regular_worker_deployment SET enabled=true,worker_sha256=$1,runtime_sha256=$2,query_sha256=$3,database_role=session_user,
   approved_at=clock_timestamp(),approved_by='synthetic-physical-drain-fixture',topology_receipt_sha256=$4 WHERE singleton`,[id.worker_sha256,id.runtime_sha256,build.querySha256,'f'.repeat(64)]);
  app=child(exe,['--config',config],runtime);
  await until(async()=>!app.ended&&(await db.query('SELECT EXISTS(SELECT 1 FROM crm_audience_v2.regular_worker_lease WHERE NOT suspended AND expires_at>clock_timestamp())ok')).rows[0].ok,Math.min(deadline,Date.now()+8000),'INITIAL_COMMITTED_HEARTBEAT_REFUSED');
  await db.query("UPDATE campaigns SET status='scheduled' WHERE id=400");
  await until(()=>relay.isHeld('protected')||relay.refusal||app.ended,Math.min(deadline,Date.now()+12000),'SMTP_ACK_NOT_HELD');
  check(relay.isHeld('protected')&&!relay.refusal&&!app.ended,'SMTP_ACK_HOLD_REFUSED');
  const state=(await db.query("SELECT count(*)::integer n FROM public.shrigma_email_dispatch WHERE transport_state='in_flight'")).rows[0];a.equal(state.n,1);
  // Complete a one-row real import before SIGTERM. Session.Start's actual
  // PostCB calls NotifySystem, which calls the real Emailer.Push outside msgQ.
  await importRequest(apiToken);
  await until(()=>relay.isHeld('direct')||relay.refusal||app.ended,Math.min(deadline,Date.now()+4000),'DIRECT_IMPORT_SMTP_ACK_NOT_HELD');
  check(relay.isHeld('direct')&&relay.isHeld('protected')&&!relay.refusal&&!app.ended,'BOTH_REAL_SMTP_ACKS_NOT_HELD');
  const imported=(await db.query("SELECT count(*)::integer n FROM subscribers s JOIN subscriber_lists sl ON sl.subscriber_id=s.id WHERE sl.list_id=9001 AND sl.status='confirmed' AND s.email='imported@fixture.invalid'")).rows[0];a.equal(imported.n,1);
  await locker.query('BEGIN');lockOpen=true;await locker.query("SELECT dispatch_id FROM public.shrigma_email_dispatch WHERE transport_state='in_flight' FOR UPDATE");
  app.p.kill('SIGTERM');await wait(150);check(!app.ended,'PROCESS_ENDED_BEFORE_SMTP_ACK');caseCount++;
  relay.release('protected');await until(async()=> (await db.query("SELECT count(*)::int n FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%regular_delivery_finish%'")).rows[0].n>0,Math.min(deadline,Date.now()+350),'FINISH_LOCK_NOT_OBSERVED');
  check(!app.ended,'PROCESS_ENDED_BEFORE_FINISH_SQL');caseCount++;
  await locker.query('COMMIT');lockOpen=false;
  await until(async()=> (await db.query("SELECT status='finished' AND sent=1 ok FROM campaigns WHERE id=400")).rows[0].ok,Math.min(deadline,Date.now()+4000),'PROTECTED_FINISH_NOT_COMMITTED');
  // This finite marker is emitted by main ONLY after Manager's join returns
  // and the actual Emailer join expires. Without main's smtp.DrainPhysical,
  // the child exits before the held direct callback completes: this case fails.
  await until(()=>app.ended||app.body.includes(Buffer.from('PHYSICAL_SMTP_DRAIN_REFUSED')),Math.min(deadline,Date.now()+9000),'MAIN_EMAILER_JOIN_NOT_REACHED');
  check(!app.ended&&relay.isHeld('direct')&&app.body.includes(Buffer.from('PHYSICAL_SMTP_DRAIN_REFUSED')),'PROCESS_ENDED_BEFORE_DIRECT_EMAILER_ACK');caseCount++;
  check(!app.body.includes(Buffer.from('PHYSICAL_DRAIN_COMPLETED')),'DIRECT_CALLBACK_FALSE_DRAIN_ACK');
  relay.release('direct');app.p.kill('SIGTERM');
  await until(()=>app.ended,Math.min(deadline,Date.now()+5000),'SIGTERM_PROCESS_NOT_ENDED');
  check(app.exit===0&&app.signal===null&&!app.bound&&app.body.includes(Buffer.from('PHYSICAL_DRAIN_COMPLETED')),'SIGTERM_COMPLETION_ACK_REFUSED');caseCount++;
  const final=(await db.query(`SELECT
   (SELECT count(*)::integer FROM shrigma_email_dispatch WHERE transport_state='accepted')accepted,
   (SELECT count(*)::integer FROM shrigma_email_dispatch WHERE transport_state IN('reserved','in_flight','outcome_unknown'))pending,
   (SELECT status::text FROM campaigns WHERE id=400)status,
   (SELECT sent FROM campaigns WHERE id=400)sent,
   (SELECT acknowledged_sent FROM crm_audience_v2.regular_delivery_campaign WHERE campaign_id=400)ack`)).rows[0];
  a.deepEqual(final,{accepted:1,pending:0,status:'finished',sent:1,ack:1});a.equal(relay.forwarded,2);a.equal(relay.count('protected'),1);a.equal(relay.count('direct'),1);a.equal(await mailpit(),before+2);caseCount++;
 Object.assign(report,{ok:true,caseCount,measuredExecutableIdentity:true,heldSmtpAckObserved:true,finishSqlLockObserved:true,
   realProcessAliveUntilSmtpAndFinish:true,realSigtermExitZero:true,mailpitAcceptedCount:2,protectedMailpitAcceptedCount:1,directMailpitAcceptedCount:1,dispatchAcceptedCount:1,noRetransmission:true,claimFinishSqlUnchanged:true,
   realImportPostCBObserved:true,realNotifySystemEmailerOutsideManager:true,directCallbackHeldBeforeSigterm:true,mainEmailerJoinReachedAfterManager:true,mainEmailerDeadlineRefusedWithoutExit:true,directAckReleasedBeforeExit:true,sigtermRequestsSameProcess:2});
 }catch(e){report.refusalCode=/^[A-Z0-9_]{1,80}$/.test(e.message||'')?e.message:'NATIVE_FOCAL_REFUSED';report.sqlState=/^[0-9A-Z]{5}$/.test(e.code||'')?e.code:null;report.exceptionType=e.constructor.name;}
 finally{
  if(relay){relay.releaseAll();await relay.close();report.smtpFrontendClosed=relay.closed;}
  if(identity&&!identity.ended){identity.p.kill('SIGKILL');await until(()=>identity.ended,Date.now()+2000,'IDENTITY_PROCESS_CLOSE_REFUSED').catch(()=>{});report.ok=false;}
  if(app&&!app.ended){app.p.kill('SIGKILL');await until(()=>app.ended,Date.now()+2000,'SYNTHETIC_PROCESS_CLOSE_REFUSED').catch(()=>{});report.forcedProcessKill=true;report.ok=false;}
  try{if(lockOpen)await locker.query('ROLLBACK');}finally{try{await locker.end();lockerEnded=true;}finally{await db.end();dbEnded=true;}}
  report.clientsEnded=dbEnded&&lockerEnded;report.workerProcessEnded=Boolean(app&&app.ended);report.executionSeconds=(Date.now()-started)/1000;
  report.ok=report.ok&&report.clientsEnded&&report.workerProcessEnded&&report.smtpFrontendClosed&&report.executionSeconds<=60;
  const target=process.env.PHYSICAL_DRAIN_RECEIPT;check(target&&path.resolve(target).startsWith('/tmp/'),'REPORT_PATH_REFUSED');fs.writeFileSync(target,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o644});
  console.log(JSON.stringify({ok:report.ok,caseCount:report.caseCount,refusalCode:report.refusalCode,clientsEnded:report.clientsEnded,originalCalls:0}));
 }
 return report.ok?0:1;
}
main().then(c=>{process.exitCode=c}).catch(()=>{console.log(JSON.stringify({ok:false,refusalCode:'FIXTURE_SETUP_REFUSED',originalCalls:0}));process.exitCode=1;});
