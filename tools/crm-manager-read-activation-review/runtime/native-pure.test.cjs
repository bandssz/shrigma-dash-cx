'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{guard}=require('./oci-guard.cjs');
function model(){const data={'/proc/self/status':'CapEff:\t0000000000000000\nCapPrm:\t0000000000000000\nCapBnd:\t0000000000000000\nNoNewPrivs:\t1\n','/sys/fs/cgroup/memory.max':'335544320','/sys/fs/cgroup/pids.max':'64','/sys/fs/cgroup/cpu.max':'35000 100000','/proc/self/mountinfo':'1 0 0:1 / / ro - overlay overlay ro\n2 1 0:2 / /proof ro - ext4 /dev/lab ro\n3 1 0:2 / /runtime-proof rw - ext4 /dev/lab rw\n'};return {proc:{platform:'linux',getuid:()=>1000,getgid:()=>1000,versions:{node:'22.23.3'},env:{READ_RUNTIME_NATIVE_OCI_PROOF:'1',READ_RUNTIME_CLUSTER:'shrigma-read-runtime-0123456789abcdef'}},f:{readFileSync:k=>data[k],lstatSync:()=>({isDirectory:()=>true,isSymbolicLink:()=>false,uid:1000,gid:1000,mode:0o40700}),readdirSync:()=>[]},data};}
test('OCI guard accepts exact bounded model and rejects missing opt-in/limits/RO/caps',()=>{
 const good=model();assert.equal(guard(good),true);
 for(const change of [m=>m.proc.env.READ_RUNTIME_NATIVE_OCI_PROOF='0',m=>m.proc.getuid=()=>0,m=>m.data['/sys/fs/cgroup/memory.max']='335544321',m=>m.data['/sys/fs/cgroup/pids.max']='65',m=>m.data['/sys/fs/cgroup/cpu.max']='35001 100000',m=>m.data['/proc/self/status']=m.data['/proc/self/status'].replace('CapEff:\t0000000000000000','CapEff:\t0000000000000001'),m=>m.data['/proc/self/mountinfo']=m.data['/proc/self/mountinfo'].replace('/ /proof ro','/ /proof rw'),m=>m.f.readdirSync=()=>['occupied']]){const v=model();change(v);assert.throws(()=>guard(v));}
});
test('copied frozen execution bytes match pins; test import has no PG/network side effects',()=>{
 const pins=require('./source-pins.cjs');for(const [name,pin]of Object.entries(pins))assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,name))).digest('hex'),pin);
 // native import uses only public F.source module; it never creates its guarded client.
 const n=require('./native-oci.test.cjs');assert.deepEqual(n.CONNECT,{host:'comunicacao_postgres',port:5432,database:'listmonk',user:'postgres',ssl:false,application_name:'shrigma-read-runtime-native-oci-only',connectionTimeoutMillis:5000,query_timeout:6000});
});
test('runner has opt-in, fixed public image, internal bridge/no PG publish, ID+label cleanup',()=>{
 const text=fs.readFileSync(path.join(__dirname,'../run-native-oci-proof.sh'),'utf8').split('\n').filter(l=>!l.trim().startsWith('#')).join('\n');
 assert.ok(text.includes('5ca20e4ea134b7a1a139b80c74a65573a4386d9584fcac40aeedaeb9cf8fe815'));assert.ok(text.includes('network create --internal --driver bridge'));assert.ok(!text.includes('--publish'));assert.ok(text.includes('--host unix:///var/run/docker.sock'));assert.ok(text.includes('--config "$READ_RUNTIME_DOCKER_CONFIG"'));assert.ok(text.includes('--env POSTGRES_PASSWORD '));assert.ok(!/^[^#\n]*(?:read_runtime_docker|docker)\s+logs\b/m.test(text));assert.ok(!text.includes(' prune'));assert.ok(text.includes('container inspect --format'));assert.ok(text.includes('read_runtime_cleanup EXIT'));
});
