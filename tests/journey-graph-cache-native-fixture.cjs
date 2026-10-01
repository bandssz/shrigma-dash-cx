'use strict';
// Isolated real native schema, actual HTTP clone and process-generated cache lease.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {Pool}=require('pg'),{randomUUID}=require('node:crypto');
const root=path.resolve(__dirname,'..'),uri=new URL(process.env.TEST_DATABASE_URL||'https://invalid');
assert.equal(process.env.GRAPH_CACHE_NATIVE_PROOF_ISOLATED,'1');assert.equal(uri.protocol,'postgresql:');assert.equal(uri.hostname,'127.0.0.1');assert.equal(uri.username,'crm_shadow');assert.equal(uri.pathname,'/listmonk');assert.ok(uri.port&&uri.port!=='5432');assert.equal(uri.password,'');assert.equal(uri.search,'');
const pool=new Pool({connectionString:uri.href,max:2,statement_timeout:20000}),query=pool.query.bind(pool),read=f=>fs.readFileSync(path.join(root,f),'utf8');
const R=require(path.join(root,'n8n/growth/journey-graph-release.cjs')),N=require(path.join(root,'n8n/growth/journey-graph-native.cjs')),{body,graph}=require(path.join(root,'tests/journey-graph-release-fixture.cjs'));
const target='native-proof-cache';
async function prepare(){
 await query(`CREATE TABLE shrigma_template_email_registry(template_id integer PRIMARY KEY,brand text);
 CREATE TABLE shrigma_flow_definition(key text PRIMARY KEY,brand text,runtime_ready boolean,published_version integer,published jsonb,enabled boolean DEFAULT true);
 CREATE TABLE shrigma_send_log(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,email text,brand text,kind text,flow text,channel text,piece text,template_id integer,ref text,subscriber_id integer);
 CREATE TABLE shrigma_exposure_7d(subscriber_id integer PRIMARY KEY,marketing_7d integer);
 CREATE SCHEMA crm_maintenance_candidate;CREATE TABLE crm_maintenance_candidate.control(singleton boolean PRIMARY KEY DEFAULT true,version integer DEFAULT 1,enabled boolean DEFAULT false,mode text DEFAULT 'closed');INSERT INTO crm_maintenance_candidate.control DEFAULT VALUES;
 INSERT INTO roles(id,type,name,permissions) VALUES(1,'user','Synthetic super',ARRAY['*']),(3,'user','Synthetic graph',ARRAY['templates:get','templates:manage','tx:send']);
 INSERT INTO users(username,password,email,name,type,user_role_id,status) VALUES('graph-proof','synthetic-token','graph-proof@example.invalid','Synthetic graph proof','api',3,'enabled');`);
 const helpers=read('tests/sql/journey-cart-fixture.sql');await query(helpers.slice(helpers.indexOf('CREATE FUNCTION shrigma_flow_slot'),helpers.indexOf('CREATE FUNCTION shrigma_email_claim_cart')));
 await query(read('tests/journey-graph-cart-legacy-fixture.sql'));
 for(const name of ['store','source','release','native','cart','cache-identity'])await query(read('n8n/growth/journey-graph-'+name+'.sql'));
 const provider=R.createReleaseProvider({query});
 for(const brand of ['fish','aristo']){
  const tid=brand==='fish'?60:95;
  await query('INSERT INTO templates(id,name,type,subject,body) VALUES($1,$2,\'tx\',\'Seu carrinho\',$3)',[tid,'Native '+brand,body(brand)]);
  await query('INSERT INTO shrigma_template_email_registry VALUES($1,$2)',[tid,brand]);
  await query('INSERT INTO shrigma_flow_definition(key,brand,runtime_ready,published_version,published) VALUES($1,$2,true,6,$3)',[brand+':carrinho',brand,graph(brand)]);
  const source=(await query('SELECT crm_graph_candidate.release_source_v1($1,$2) result',[brand,tid])).rows[0].result;
  await provider.prepare('panel:native-proof',{request_id:randomUUID(),brand,binding:source.binding,expected_snapshot:source.source_snapshot});
 }
 await query("SELECT setval(pg_get_serial_sequence('public.templates','id'),(SELECT max(id) FROM templates))");
 await query('INSERT INTO crm_graph_candidate.cache_identity_deployment_v1(cache_target,enabled,executable_sha256,runtime_sha256,expected_role) VALUES($1,true,$2,$3,current_user)',[target,process.env.GRAPH_NATIVE_BINARY_SHA,process.env.GRAPH_NATIVE_RUNTIME_SHA]);
 const off=(await query('SELECT (SELECT enabled FROM crm_graph_candidate.control WHERE singleton) graph_enabled,(SELECT bool_and(NOT enabled) FROM crm_graph_candidate.cart_control_v1) cart_off,(SELECT count(*)::int FROM crm_graph_candidate.entry) entries')).rows[0];assert.deepEqual(off,{graph_enabled:false,cart_off:true,entries:0});
 return {prepared:true,graph_enabled:false,cart_enabled:false,cache_enabled_synthetic:true};
}
async function clones(){
 const origin=new URL(process.env.GRAPH_NATIVE_HTTP_ORIGIN);assert.equal(origin.protocol,'http:');assert.equal(origin.hostname,'127.0.0.1');assert.ok(origin.port);assert.equal(origin.pathname,'/');assert.equal(origin.search,'');
 let creates=0,reads=0;const authorization='Basic '+Buffer.from('graph-proof:synthetic-token').toString('base64');
 async function request(method,route,payload){assert.ok(route==='/api/templates'||/^\/api\/templates\/[1-9][0-9]*$/.test(route));if(method==='POST')creates++;else reads++;
  const response=await fetch(new URL(route,origin),{method,headers:{Authorization:authorization,'Content-Type':'application/json'},...(payload?{body:JSON.stringify(payload)}:{}),redirect:'error',signal:AbortSignal.timeout(10000)});return {status:response.status,body:await response.json()};}
 const provider=N.createNativeProvider({query,cacheTarget:target,nativeCreate:b=>request('POST','/api/templates',b),nativeRead:id=>request('GET','/api/templates/'+id)});
 const receipts=[];
 for(const release of (await query('SELECT id,brand,material_sha256 FROM crm_graph_candidate.message_release_v1 ORDER BY brand')).rows){
  const reserved=await provider.prepare('panel:native-proof',{request_id:randomUUID(),brand:release.brand,release_id:release.id,expected_material_sha256:release.material_sha256});
  const clone=await provider.create(release.brand,reserved.native_id);assert.equal(clone.state,'ready');receipts.push({brand:release.brand,template_id:clone.clone_template_id});
  assert.equal((await provider.create(release.brand,reserved.native_id)).state,'ready');assert.equal((await provider.reconcile(release.brand,reserved.native_id)).diagnosis,'ready');
 }
 assert.equal(creates,2);assert.equal(reads,0);
 const deadline=Date.now()+27000;let proof;
 while(Date.now()<deadline){
  proof=(await query(`SELECT (SELECT executable_sha256=$2 AND runtime_sha256=$3 AND expires_at>clock_timestamp() AND suspended_at IS NULL FROM crm_graph_candidate.cache_identity_lease_v1 WHERE cache_target=$1) process_identity,
   (SELECT count(*)::int FROM crm_graph_candidate.cache_identity_snapshot_v1 WHERE cache_target=$1 AND expires_at>clock_timestamp()) snapshot_count,
   (SELECT bool_and(s.native_sha256=n.native_sha256 AND s.instance_id=l.instance_id AND s.lease_token=l.lease_token) FROM crm_graph_candidate.cache_identity_snapshot_v1 s JOIN crm_graph_candidate.native_template_v1 n ON n.cache_target=s.cache_target AND n.clone_template_id=s.template_id JOIN crm_graph_candidate.cache_identity_lease_v1 l ON l.cache_target=s.cache_target WHERE s.cache_target=$1) snapshot_match`,[target,process.env.GRAPH_NATIVE_BINARY_SHA,process.env.GRAPH_NATIVE_RUNTIME_SHA])).rows[0];
  if(proof.process_identity===true&&proof.snapshot_count===2&&proof.snapshot_match===true)break;await new Promise(r=>setTimeout(r,250));
 }
 assert.deepEqual(proof,{process_identity:true,snapshot_count:2,snapshot_match:true});
 assert.equal((await query('SELECT count(*)::int n FROM shrigma_email_dispatch')).rows[0].n,0);
 assert.equal((await query('SELECT count(*)::int n FROM shrigma_send_log')).rows[0].n,0);
 return {success:true,actual_http_clone:true,creates,extra_create_on_replay:false,process_generated_heartbeat:true,actual_compiled_cache_snapshots:2,brands:receipts.map(x=>x.brand),graph_enabled:false,cart_enabled:false,entries:0,dispatches:0,send_logs:0};
}
(async()=>{try{const mode=process.argv[2];assert.ok(['prepare','clones'].includes(mode));console.log(JSON.stringify(await (mode==='prepare'?prepare():clones())));}finally{await pool.end();}})().catch(e=>{console.error(e.message);process.exit(1);});
