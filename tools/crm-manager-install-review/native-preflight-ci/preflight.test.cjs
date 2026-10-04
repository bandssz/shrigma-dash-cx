'use strict';
// Synthetic Linux kernel/filesystem/HTTP only. No Docker, SQL, socket or real env.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const {buildPreflight,PINS}=require('./build-preflight.cjs');
const RUNTIME=process.argv[2]?path.resolve(process.argv[2]):path.resolve(__dirname,'../runtime');
const original=fs.readFileSync(path.join(__dirname,'bootstrap.original.cjs'),'utf8'),fixed=fs.readFileSync(path.join(__dirname,'bootstrap.fixed.cjs'),'utf8');
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
function fixture({initializer=false,source=fixed}={}){
 const operations=[],dirs=new Map([['/manager-install-proof',{uid:initializer?0:1000,gid:initializer?0:1000,mode:initializer?0o755:0o700,names:[],ino:1,dev:4}],['/review',{uid:1000,gid:1000,mode:0o700,names:[],ino:2,dev:5}]]),files=new Map(),descriptors=new Map();let next=10,nextInode=100,network=['lo'],failSync=false,healthHandler;
 const proc={platform:'linux',versions:{node:'22.0.0'},getuid:()=>initializer?0:1000,getgid:()=>initializer?0:1000,execArgv:[initializer?'--max-old-space-size=16':'--max-old-space-size=96'],env:{},exitCode:undefined,argv:[],stderr:{write:v=>operations.push(['stderr',v])}};
 const cap=initializer?'0000000000000001':'0000000000000000';
 const kernel={
 '/proc/self/status':'CapEff:\t'+cap+'\nCapPrm:\t'+cap+'\nCapBnd:\t'+cap+'\nNoNewPrivs:\t1\n',
 '/proc/self/mountinfo':'1 0 0:1 / / ro,relatime - overlay overlay ro\n2 1 8:1 /new-volume /manager-install-proof rw,relatime - ext4 /dev/vda1 rw\n'+(initializer?'':'3 1 0:3 / /review rw,nosuid,nodev,noexec - tmpfs tmpfs rw,size=65536k,uid=1000,gid=1000,mode=700\n'),
 '/sys/fs/cgroup/cpu.max':initializer?'10000 100000':'25000 100000',
 '/sys/fs/cgroup/memory.max':initializer?'67108864':'268435456','/sys/fs/cgroup/pids.max':initializer?'16':'32'};
 function metadata(p){const d=dirs.get(p),f=files.get(p);if(!d&&!f)throw Error('UNEXPECTED_FIXTURE_STAT');const v=d||f;return{...v,size:f?f.bytes.length:0,isDirectory:()=>Boolean(d),isFile:()=>Boolean(f),isSymbolicLink:()=>false};}
 const fakeFs={constants:fs.constants,
 readFileSync(p,encoding){operations.push(['read',p]);if(typeof p==='number')p=descriptors.get(p);if(Object.hasOwn(kernel,p))return kernel[p];if(!files.has(p))throw Error('UNEXPECTED_FIXTURE_READ');const b=files.get(p).bytes;return encoding?b.toString(encoding):Buffer.from(b);},
 lstatSync(p){operations.push(['stat',p]);return metadata(p);},fstatSync(fd){operations.push(['fstat',descriptors.get(fd)]);return metadata(descriptors.get(fd));},
 readdirSync(p){operations.push(['list',p]);if(p==='/sys/class/net')return [...network];const d=dirs.get(p);if(!d)throw Error('UNEXPECTED_FIXTURE_LIST');if(proc.getuid()===0&&d.uid!==0&&(d.mode&0o077)===0){const e=Error('SYNTHETIC_DAC_RAW_CANARY');e.code='EACCES';throw e;}return [...d.names];},
 chmodSync(p,mode){operations.push(['chmod',p,mode]);const v=dirs.get(p)||files.get(p);if(!v)throw Error('UNEXPECTED_FIXTURE_CHMOD');v.mode=mode;},
 chownSync(p,uid,gid){operations.push(['chown',p,uid,gid]);const v=dirs.get(p);if(!v)throw Error('UNEXPECTED_FIXTURE_CHOWN');Object.assign(v,{uid,gid});},
 mkdirSync(p,{mode}){operations.push(['mkdir',p]);if(dirs.has(p))throw Error('DUPLICATE_FIXTURE_DIR');dirs.set(p,{uid:1000,gid:1000,mode,names:[],ino:nextInode++,dev:5});dirs.get(path.dirname(p)).names.push(path.basename(p));},
 openSync(p,flags,mode){operations.push(['open',p,flags]);assert.ok(flags&fs.constants.O_NOFOLLOW);if(flags&fs.constants.O_CREAT){assert.ok(flags&fs.constants.O_EXCL);if(files.has(p))throw Error('DUPLICATE_FIXTURE_FILE');files.set(p,{uid:1000,gid:1000,mode,bytes:Buffer.alloc(0),ino:nextInode++,dev:4});dirs.get(path.dirname(p)).names.push(path.basename(p));}else if(!files.has(p)&&!dirs.has(p))throw Error('UNEXPECTED_FIXTURE_OPEN');const fd=next++;descriptors.set(fd,p);return fd;},
 writeFileSync(fd,bytes){operations.push(['write',descriptors.get(fd)]);files.get(descriptors.get(fd)).bytes=Buffer.from(bytes);},
 fsyncSync(fd){operations.push(['sync',descriptors.get(fd)]);if(failSync)throw Error('SYNTHETIC_FSYNC_RAW_CANARY');},closeSync(fd){operations.push(['close',descriptors.get(fd)]);descriptors.delete(fd);}};
 const fakeHttp={createServer(handler){healthHandler=handler;operations.push(['http-create']);return{on(){return this;},close(){operations.push(['http-close']);},listen(port,host){operations.push(['http-listen',port,host]);return this;}};}};
 const context={module:{exports:{}},Buffer,process:proc,require(name){operations.push(['require',name]);if(name==='node:fs')return fakeFs;if(name==='node:crypto')return crypto;if(name==='node:http')return fakeHttp;if(name==='node:vm')return{Script:class{constructor(s){this.source=s;}runInThisContext(){return vm.runInContext(this.source,context,{timeout:1000});}}};if(name==='/app/node_modules/pg/package.json')return{version:'8.13.1'};throw Error('UNEXPECTED_REQUIRE_RAW_CANARY');}};
 vm.createContext(context);vm.runInContext('(function(module,exports,require){'+source+'\n})(module,module.exports,require)',context,{timeout:1000});operations.length=0;
 return{boot:context.module.exports,context,proc,dirs,files,kernel,operations,fakeFs,setNetwork:v=>network=v,setFailSync:v=>failSync=v,health:()=>healthHandler};
}
function plan(profile='canonical',suffix='a1b2c3d4e5f6'){return buildPreflight({suffix,runtimeRoot:RUNTIME,pidsProfile:profile});}
function execute(plan,initializer=false){const argv=JSON.parse(plan.json).services[initializer?'prepare_volume':'installer'].entrypoint,f=fixture({initializer});f.proc.argv=['node',...argv.slice(5)];vm.runInContext(argv[3],f.context,{timeout:1000});return f;}
test('original initializer demonstrates DAC failure; fixed initializer never enumerates after chown',()=>{
 assert.equal(sha(fixed),PINS.fixedBootstrap);assert.equal(sha(original),PINS.originalBootstrap);const old=fixture({initializer:true,source:original});assert.throws(()=>old.boot.initializeVolume(),e=>e.code==='EACCES');
 const f=fixture({initializer:true});assert.equal(f.boot.initializeVolume(),true);const chown=f.operations.findIndex(v=>v[0]==='chown');assert.ok(chown>0);assert.equal(f.operations.slice(chown+1).some(v=>v[0]==='list'),false);
 assert.deepEqual(f.operations.filter(v=>['chmod','chown','open','write'].includes(v[0])),[['chmod','/manager-install-proof',0o700],['chown','/manager-install-proof',1000,1000]]);assert.equal(f.files.size,0);
});
test('UID1000 runtime guard independently rejects consumed volume, owner, permissions and capabilities',()=>{
 for(const change of [f=>f.dirs.get('/manager-install-proof').names.push('native-preflight.json'),f=>f.dirs.get('/manager-install-proof').names.push('consumer-prefix'),f=>f.dirs.get('/manager-install-proof').uid=0,f=>f.dirs.get('/manager-install-proof').mode=0o755,f=>f.kernel['/proc/self/status']=f.kernel['/proc/self/status'].replace(/0000000000000000/g,'0000000000000001')]){
 const f=fixture();f.proc.env.PGPASSWORD='SYNTHETIC_ONLY';change(f);assert.throws(()=>f.boot.guardRuntime());assert.equal(f.files.size,0);}
});
test('initializer remains fail-closed before mutation for prior data, network and resource drift',()=>{
 for(const change of [f=>f.dirs.get('/manager-install-proof').names.push('existing'),f=>f.setNetwork(['lo','eth0']),f=>f.kernel['/sys/fs/cgroup/memory.max']='67108865',f=>f.kernel['/sys/fs/cgroup/pids.max']='17',f=>f.kernel['/sys/fs/cgroup/cpu.max']='10001 100000']){
 const f=fixture({initializer:true});change(f);assert.throws(()=>f.boot.initializeVolume());assert.equal(f.operations.some(v=>['chmod','chown','open','write'].includes(v[0])),false);}
});
test('portable no-SQL compose preserves fixed resources and isolates only redundant deploy pids',()=>{
 const a=plan(),b=plan('pids_limit_only'),c=JSON.parse(a.json),d=JSON.parse(b.json);assert.equal(c.services.installer.env_file,undefined);assert.equal(c.networks,undefined);assert.equal(a.composeProjectName,'shrigma-native-preflight-a1b2c3d4e5f6');
 for(const s of [c.services.installer,c.services.prepare_volume]){assert.equal(s.network_mode,'none');assert.equal(s.read_only,true);assert.equal(s.restart,'no');assert.equal(s.init,true);assert.deepEqual(s.cap_drop,['ALL']);assert.deepEqual(s.security_opt,['no-new-privileges:true']);assert.equal(s.ports,undefined);assert.equal(s.environment?.PGPASSWORD,undefined);}
 assert.deepEqual(c.services.prepare_volume.cap_add,['CHOWN']);assert.equal(c.services.installer.mem_limit,'256m');assert.equal(c.services.installer.memswap_limit,'256m');assert.equal(c.services.installer.pids_limit,32);assert.equal(c.services.installer.cpus,.25);assert.equal(c.services.prepare_volume.mem_limit,'64m');assert.equal(c.services.prepare_volume.memswap_limit,'64m');assert.equal(c.services.prepare_volume.pids_limit,16);assert.equal(c.services.prepare_volume.cpus,.1);
 assert.equal(c.services.installer.deploy.resources.limits.pids,32);assert.equal(d.services.installer.deploy.resources.limits.pids,undefined);assert.equal(d.services.installer.pids_limit,32);assert.equal(d.services.prepare_volume.pids_limit,16);
 assert.equal(a.status.bundleSha256,b.status.bundleSha256);assert.equal(a.status.sourceFiles,8);assert.equal(a.status.noSql,undefined);assert.equal(a.json.includes('${'),false);assert.equal(c.services.installer.env_file,undefined);assert.equal(Buffer.byteLength(a.json)<524288,true);
 for(const s of Object.values(c.services))for(const arg of s.entrypoint)assert.ok(Buffer.byteLength(arg)<98304);
 const parsed=require('node:child_process').execFileSync('/usr/bin/ruby',['-r','yaml','-r','json','-e','STDOUT.write(JSON.generate(YAML.safe_load(STDIN.read)))'],{input:a.json,env:{PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:5000,maxBuffer:1048576});assert.deepEqual(JSON.parse(parsed),c);
});
test('new initializer entrypoint executes fixed metadata-only transfer in VM',()=>{const f=execute(plan(),true);assert.equal(f.proc.exitCode,undefined);assert.equal(f.files.size,0);assert.equal(f.dirs.get('/manager-install-proof').mode,0o700);assert.equal(f.dirs.get('/manager-install-proof').uid,1000);});
test('runtime VM stages eight pinned sources then proves fsync and local health without loading PG or executor',()=>{
 const p=plan(),f=execute(p);assert.equal(f.proc.exitCode,undefined);assert.equal(f.files.size,9);assert.deepEqual(f.operations.filter(v=>v[0]==='http-listen'),[['http-listen',8098,'127.0.0.1']]);assert.equal(Object.keys(f.proc.env).some(k=>k.startsWith('PG')),false);
 const loaded=f.operations.filter(v=>v[0]==='require').map(v=>v[1]);assert.equal(loaded.some(v=>v==='pg'||v.endsWith('run-install.cjs')||v.endsWith('supervisor.cjs')),false);assert.ok(loaded.includes('/app/node_modules/pg/package.json'));
 for(const file of f.files.values())assert.equal(file.bytes.toString('utf8').includes('SYNTHETIC_ONLY'),false);
 const proof='/manager-install-proof/native-preflight.json';assert.equal(f.files.get(proof).mode,0o600);assert.equal(JSON.parse(f.files.get(proof).bytes).proofDurable,true);const writes=f.operations.findIndex(v=>v[0]==='write'&&v[1]===proof),listen=f.operations.findIndex(v=>v[0]==='http-listen');assert.ok(f.operations.slice(writes,listen).filter(v=>v[0]==='sync'&&v[1]===proof).length>=2);assert.ok(f.operations.slice(writes,listen).filter(v=>v[0]==='sync'&&v[1]==='/manager-install-proof').length>=2);
 let code,body;f.health()({method:'GET',url:'/status'},{writeHead(v){code=v;},end(v){body=v;}});assert.equal(code,200);assert.deepEqual(JSON.parse(body),p.status);
 f.setFailSync(true);f.health()({method:'GET',url:'/status'},{writeHead(v){code=v;},end(v){body=v;}});assert.equal(code,503);assert.equal(body,undefined);
});
test('fsync failure never starts health and does not expose synthetic raw exception',()=>{
 const p=plan(),argv=JSON.parse(p.json).services.installer.entrypoint,f=fixture();f.setFailSync(true);f.proc.argv=['node',...argv.slice(5)];vm.runInContext(argv[3],f.context,{timeout:1000});assert.equal(f.proc.exitCode,1);assert.equal(f.health(),undefined);assert.equal(f.operations.some(v=>v[0]==='http-listen'),false);assert.equal(f.operations.filter(v=>v[0]==='stderr').some(v=>v[1].includes('RAW_CANARY')),false);
});
test('builder rejects ambiguous profile, suffix and unknown options before generating a plan',()=>{
 for(const opt of [{suffix:'a1b2c3d4e5f6',runtimeRoot:RUNTIME,pidsProfile:'auto'},{suffix:'bad',runtimeRoot:RUNTIME},{suffix:'a1b2c3d4e5f6',runtimeRoot:RUNTIME,password:'SYNTHETIC'}])assert.throws(()=>buildPreflight(opt),e=>e.message==='NATIVE_PREFLIGHT_PLAN_REFUSED');
});
