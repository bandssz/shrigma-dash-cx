'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{EventEmitter}=require('node:events');
const C=require('./pg17-ci.cjs'),G=require('./pg17-network-guard.cjs');
const id='a'.repeat(64),owner='123-1-audience',ctx={id,owner,caseId:'audience'};
function model(){return {Id:id,Image:C.IMAGE_ID,Config:{Image:C.IMAGE,Labels:{[C.LABEL]:owner},Env:['POSTGRES_DB=listmonk','POSTGRES_HOST_AUTH_METHOD=trust']},State:{Running:true,OOMKilled:false,Dead:false},HostConfig:{Memory:536870912,MemorySwap:536870912,NanoCpus:1000000000,PidsLimit:128,Privileged:false,PortBindings:{'5432/tcp':[{HostIp:'127.0.0.1',HostPort:'55440'}]}},NetworkSettings:{Networks:{github_network_fixture:{NetworkID:'b'.repeat(64)}}},Mounts:[{Type:'volume',Destination:'/var/lib/postgresql/data',Name:'c'.repeat(64),RW:true}]};}
function refuses(fn){assert.throws(fn,/CLAUDE_NATIVE_PG17_CI_REFUSED/);}
test('six exact fixtures, mandatory opt-in and own GHA context',()=>{
 assert.deepEqual(Object.keys(C.FIXTURES),['audience','templates','template_listener','recovery','installer','gateway']);
 assert.deepEqual(C.fixture('template_listener'),{file:'tests/claude-template-read-listener-pg17-postgres.cjs',flag:'CRM_TEMPLATE_TEST_ISOLATED',mode:'test'});
 const env={CLAUDE_NATIVE_PG17_CI:'1',CLAUDE_PG17_CASE:'audience',CLAUDE_PG17_CONTAINER_ID:id,CLAUDE_PG17_OWNER:owner};
 assert.deepEqual(C.context(env),ctx);assert.ok(Object.isFrozen(C.context(env)));
 for(const change of [{CLAUDE_NATIVE_PG17_CI:''},{CLAUDE_PG17_CASE:'unknown'},{CLAUDE_PG17_CONTAINER_ID:'old'},{CLAUDE_PG17_OWNER:'123-1-gateway'}])refuses(()=>C.context({...env,...change}));
 refuses(()=>C.fixture('../native'));refuses(()=>C.fixture('toString'));
});
test('service identity, private port and bounded resource admission precede SQL',()=>{
 assert.equal(C.verifyContainer(model(),ctx),true);
 const mutations=[v=>v.Id='d'.repeat(64),v=>v.Image='sha256:'+id,v=>v.Config.Image='postgres:17',v=>v.Config.Labels[C.LABEL]='other',v=>v.State.Running=false,v=>v.State.OOMKilled=true,v=>v.HostConfig.Memory=0,v=>v.HostConfig.MemorySwap=-1,v=>v.HostConfig.NanoCpus=0,v=>v.HostConfig.PidsLimit=0,v=>v.HostConfig.Privileged=true,v=>v.HostConfig.PortBindings['5432/tcp'][0].HostIp='0.0.0.0',v=>v.HostConfig.PortBindings['5432/tcp'][0].HostPort='5432',v=>v.HostConfig.PortBindings['other/tcp']=[],v=>v.NetworkSettings.Networks={easypanel:{NetworkID:id}},v=>v.NetworkSettings.Networks.other={NetworkID:id},v=>v.Config.Env.push('PGPASSWORD=synthetic')];
 for(const mutate of mutations){const v=model();mutate(v);refuses(()=>C.verifyContainer(v,ctx));}
});
test('cleanup captures only the declared owned anonymous PG volume; failed empty Docker output refuses',()=>{
 assert.equal(C.ownedVolume(model(),ctx),'c'.repeat(64));
 for(const change of [v=>v.Config.Labels[C.LABEL]='other',v=>v.Mounts.push({...v.Mounts[0]}),v=>v.Mounts[0].Type='bind',v=>v.Mounts[0].Destination='/source',v=>v.Mounts[0].Name='existing-data']){const v=model();change(v);refuses(()=>C.ownedVolume(v,ctx));}
 assert.equal(C.dockerOutput({status:0,stdout:''}),'');
 for(const r of [{status:1,stdout:''},{status:null,stdout:''},{status:0,stdout:null}])refuses(()=>C.dockerOutput(r));
});
test('PG17.10, fresh listmonk and actual postgres session are mandatory',()=>{
 const row={version:'170010',db:'listmonk',who:'postgres',session:'postgres',port:5432,readonly:'on',tables:0};
 assert.equal(C.verifyDatabase(row),true);
 for(const change of [{version:'170009'},{db:'postgres'},{who:'service'},{session:'service'},{port:55440},{readonly:'off'},{tables:1}])refuses(()=>C.verifyDatabase({...row,...change}));
});
test('worker is constructed from a closed environment and never inherits PG credentials/options',()=>{
 for(const caseId of Object.keys(C.FIXTURES)){
 const env=C.workerEnvironment(caseId,'/proof/node_modules/pg','/proof/guard.cjs');
 assert.equal(env.TEST_DATABASE_URL,'postgresql://postgres@127.0.0.1:55440/listmonk');assert.equal(env.PG_MODULE,'/proof/node_modules/pg');assert.equal(env.NODE_PATH,'/proof/node_modules');assert.equal(env[C.fixture(caseId).flag],'1');assert.equal(env.CRM_PG_EXPECTED_VERSION_NUM,'170010');assert.ok(Object.isFrozen(env));
 assert.deepEqual(Object.keys(env).sort(),['PATH','LANG','TZ','NODE_PATH','PG_MODULE','TEST_DATABASE_URL',C.fixture(caseId).flag,'CRM_PG_EXPECTED_VERSION_NUM','CLAUDE_PG17_NETWORK_GUARD'].sort());
 }
 refuses(()=>C.workerEnvironment('audience','relative','/proof/guard.cjs'));
});
test('network guard accepts fixed PG and only currently owned HTTP loopback listeners',()=>{
 const ports=new Set([45000]);assert.equal(G.allowed('127.0.0.1',55440,ports),true);assert.equal(G.allowed('localhost',55440,ports),true);assert.equal(G.allowed('127.0.0.1',45000,ports),true);
 for(const [host,port] of [['example.test',55440],['127.0.0.1',5432],['127.0.0.1',45001],['0.0.0.0',45000]])assert.equal(G.allowed(host,port,ports),false);
 // Node22 passes normalized arrays into Socket.connect via net.connect.
 assert.equal(G.options([[{host:'127.0.0.1',port:55440},()=>{}]]).port,55440);
 let calls=0;
 class Socket{connect(){calls++;return this;}}
 class Server extends EventEmitter{listen(){this.emit('listening');return this;}address(){return {address:'127.0.0.1',port:45000};}}
 const fake={net:{Socket,Server},tls:{connect(){}},dgram:{Socket:class{send(){}bind(){}}},dns:{lookup(){calls++;},resolve(){},promises:{async lookup(){calls++;},async resolve(){}}}};
 const scope={module:{exports:{}},process:{env:{}},require:n=>fake[n.slice(5)]};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'pg17-network-guard.cjs'),'utf8'),scope);scope.module.exports.install();
 const server=new Server(),socket=new Socket();assert.throws(()=>socket.connect(45000,'127.0.0.1'),/EXTERNAL_NETWORK_REFUSED/);
 server.listen(0,'127.0.0.1');socket.connect([{port:45000,host:'127.0.0.1'},()=>{}]);socket.connect(55440,'127.0.0.1');assert.equal(calls,2);
 server.emit('close');assert.throws(()=>socket.connect(45000,'127.0.0.1'),/EXTERNAL_NETWORK_REFUSED/);
 for(const fn of [()=>socket.connect('/var/run/postgresql'),()=>socket.connect(55440,'remote.test'),()=>new Server().listen(0,'0.0.0.0'),()=>fake.tls.connect({host:'127.0.0.1',port:55440}),()=>fake.dns.lookup('remote.test'),()=>fake.dns.resolve('localhost'),()=>new fake.dgram.Socket().send('x')])assert.throws(fn,/EXTERNAL_NETWORK_REFUSED/);
 assert.equal(calls,2);
});
