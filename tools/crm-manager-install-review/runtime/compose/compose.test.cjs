'use strict';
// Kernel and filesystem fixtures only; never runs Docker, PG, HTTP or a child
// installation. Ruby's safe YAML parser receives this public JSON as stdin.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const B=require('./build-compose.cjs');
const BOOT=fs.readFileSync(path.join(__dirname,'bootstrap.cjs'),'utf8');
function synthetic({initializer=false}={}){
 const operations=[],dirs=new Map([['/manager-install-proof',{uid:initializer?0:1000,gid:initializer?0:1000,mode:initializer?0o755:0o700,names:[]}],['/review',{uid:1000,gid:1000,mode:0o700,names:[]}]]),files=new Map(),descriptors=new Map();let next=1;
 const proc={platform:'linux',versions:{node:'22.0.0'},getuid:()=>initializer?0:1000,getgid:()=>initializer?0:1000,execArgv:[initializer?'--max-old-space-size=16':'--max-old-space-size=96'],env:initializer?{}:{PGPASSWORD:'SYNTHETIC_RAM_ONLY_CANARY'},exitCode:undefined,argv:[]};
 const cap=initializer?'0000000000000001':'0000000000000000';
 const kernel={
  '/proc/self/status':'CapEff:\t'+cap+'\nCapPrm:\t'+cap+'\nCapBnd:\t'+cap+'\nNoNewPrivs:\t1\n',
  '/proc/self/mountinfo':'1 0 0:1 / / ro,relatime - overlay overlay ro\n2 1 8:1 /new-volume /manager-install-proof rw,relatime - ext4 /dev/vda1 rw\n'+(initializer?'':'3 1 0:3 / /review rw,nosuid,nodev,noexec - tmpfs tmpfs rw,size=65536k,uid=1000,gid=1000,mode=700\n'),
  '/sys/fs/cgroup/cpu.max':initializer?'10000 100000':'25000 100000',
  '/sys/fs/cgroup/memory.max':initializer?'67108864':'268435456',
  '/sys/fs/cgroup/pids.max':initializer?'16':'32'
 };
 let network=['lo'];
 const fakeFs={
  constants:fs.constants,
  readFileSync(p){operations.push(['read',p]);if(!Object.hasOwn(kernel,p))throw Error('UNEXPECTED_FIXTURE_READ');return kernel[p];},
  lstatSync(p){operations.push(['stat',p]);const d=dirs.get(p);if(!d)throw Error('UNEXPECTED_FIXTURE_STAT');return{...d,isDirectory:()=>true,isSymbolicLink:()=>false};},
  readdirSync(p){operations.push(['list',p]);if(p==='/sys/class/net')return [...network];if(!dirs.has(p))throw Error('UNEXPECTED_FIXTURE_LIST');return [...dirs.get(p).names];},
  chmodSync(p,mode){operations.push(['chmod',p,mode]);if(dirs.has(p))dirs.get(p).mode=mode;else if(files.has(p))files.get(p).mode=mode;else throw Error('UNEXPECTED_FIXTURE_CHMOD');},
  chownSync(p,uid,gid){operations.push(['chown',p,uid,gid]);if(!dirs.has(p))throw Error('UNEXPECTED_FIXTURE_CHOWN');Object.assign(dirs.get(p),{uid,gid});},
  mkdirSync(p,{mode}){operations.push(['mkdir',p]);if(dirs.has(p))throw Error('DUPLICATE_FIXTURE_DIR');dirs.set(p,{uid:1000,gid:1000,mode,names:[]});dirs.get(path.dirname(p)).names.push(path.basename(p));},
  openSync(p,flags,mode){operations.push(['open',p,flags]);assert.equal(Boolean(flags&fs.constants.O_EXCL),true);assert.equal(Boolean(flags&fs.constants.O_NOFOLLOW),true);if(files.has(p))throw Error('DUPLICATE_FIXTURE_FILE');files.set(p,{mode,bytes:Buffer.alloc(0)});dirs.get(path.dirname(p)).names.push(path.basename(p));const fd=next++;descriptors.set(fd,p);return fd;},
  writeFileSync(fd,bytes){operations.push(['write',descriptors.get(fd)]);files.get(descriptors.get(fd)).bytes=Buffer.from(bytes);},
  fsyncSync(fd){operations.push(['sync',descriptors.get(fd)]);},
  closeSync(fd){operations.push(['close',descriptors.get(fd)]);descriptors.delete(fd);}
 };
 let supervisorCalls=0;
 const context={module:{exports:{}},Buffer,process:proc,require(name){if(name==='node:fs')return fakeFs;if(name==='node:crypto')return crypto;if(name==='/app/node_modules/pg/package.json')return{version:'8.13.1'};if(name==='/review/supervisor/supervisor.cjs')return{startCli(args,env){supervisorCalls++;assert.deepEqual(Array.from(args),['install']);delete env.PGPASSWORD;return{syntheticServer:true};}};throw Error('UNEXPECTED_FIXTURE_REQUIRE');}};
 vm.createContext(context);vm.runInContext('(function(module,exports,require){'+BOOT+'\n})(module,module.exports,require)',context,{timeout:1000});assert.equal(operations.length,0);
 return{boot:context.module.exports,context,proc,fakeFs,dirs,files,kernel,operations,setNetwork:v=>{network=v;},supervisorCalls:()=>supervisorCalls};
}
function bundleFromPlan(plan){const command=JSON.parse(plan.json).services.installer.entrypoint;return JSON.parse(Buffer.from(command.slice(5).join(''),'base64').toString('utf8'));}
test('Compose JSON parses as JSON and safe YAML; image, limits, isolation and empty-env policy are exact',()=>{
 const plan=B.buildCompose({suffix:'a1b2c3d4e5f6'}),compose=JSON.parse(plan.json),i=compose.services.installer,v=compose.services.prepare_volume;
 assert.equal(plan.projectName,'dashboard-image-20260930');assert.equal(compose['x-shrigma-install-review'].projectName,plan.projectName);assert.equal(plan.createDotEnv,true);assert.equal(plan.environmentEmpty,true);assert.equal(plan.json.includes('${'),false);
 assert.equal(i.image,B.IMAGE);assert.equal(v.image,B.IMAGE);assert.equal(i.user,'1000:1000');assert.equal(v.user,'0:0');assert.equal(i.read_only,true);assert.deepEqual(i.cap_drop,['ALL']);assert.deepEqual(v.cap_add,['CHOWN']);assert.equal(v.network_mode,'none');assert.equal(Object.hasOwn(v,'env_file'),false);assert.equal(Object.hasOwn(v,'environment'),false);
 assert.equal(i.cpus,0.25);assert.equal(i.mem_limit,'256m');assert.equal(i.memswap_limit,'256m');assert.equal(i.pids_limit,32);assert.equal(v.cpus,0.1);assert.equal(v.mem_limit,'64m');assert.equal(v.memswap_limit,'64m');assert.equal(v.entrypoint[1],'--max-old-space-size=16');assert.equal(v.pids_limit,16);assert.equal(i.deploy.replicas,1);assert.equal(v.deploy.replicas,1);assert.equal(i.deploy.resources.limits.pids,32);assert.equal(v.deploy.resources.limits.pids,16);assert.equal(i.deploy.resources.limits.memory,'256M');assert.equal(v.deploy.resources.limits.memory,'64M');assert.equal(i.deploy.restart_policy.condition,'none');assert.equal(v.deploy.restart_policy.condition,'none');assert.equal(i.restart,'no');assert.equal(v.restart,'no');assert.deepEqual(i.env_file,['.env']);
 assert.equal(i.depends_on.prepare_volume.condition,'service_completed_successfully');assert.deepEqual(i.networks,['easypanel']);assert.equal(compose.networks.easypanel.external,true);assert.equal(Object.keys(compose.volumes).length,1);assert.equal(Object.hasOwn(i,'ports'),false);assert.equal(Object.hasOwn(i,'domains'),false);assert.equal(i.healthcheck.test.at(-1),'install');
 assert.equal(i.entrypoint.every(v=>Buffer.byteLength(v)<98304),true);assert.equal(i.entrypoint.slice(5).every(v=>v.length<=24576),true);
 const parsed=require('node:child_process').execFileSync('/usr/bin/ruby',['-r','yaml','-r','json','-e','STDOUT.write(JSON.generate(YAML.safe_load(STDIN.read)))'],{input:plan.json,env:{PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:5000,maxBuffer:1048576});assert.deepEqual(JSON.parse(parsed),compose);
});
test('initializer admits only empty NEW root-owned volume; chmod private precedes chown and creates no file',()=>{
 const f=synthetic({initializer:true});assert.equal(f.boot.initializeVolume(),true);
 assert.deepEqual(f.operations.filter(v=>['chmod','chown','write','open'].includes(v[0])),[['chmod','/manager-install-proof',0o700],['chown','/manager-install-proof',1000,1000]]);assert.equal(f.files.size,0);assert.equal(f.dirs.get('/manager-install-proof').names.length,0);
});
test('initializer rejects network, secrets, existing file, ownership, mode or unbounded limits before modifying volume',()=>{
 const cases=[f=>f.setNetwork(['lo','eth0']),f=>{f.proc.env.PGPASSWORD='SYNTHETIC_RAM_ONLY_CANARY';},f=>{f.proc.execArgv=['--max-old-space-size=8'];},f=>{f.dirs.get('/manager-install-proof').names=['existing'];},f=>{f.dirs.get('/manager-install-proof').uid=1000;},f=>{f.dirs.get('/manager-install-proof').mode=0o777;},f=>{f.kernel['/sys/fs/cgroup/memory.max']='max';},f=>{f.kernel['/sys/fs/cgroup/memory.max']='67108865';},f=>{f.kernel['/sys/fs/cgroup/cpu.max']='20000 100000';},f=>{f.kernel['/sys/fs/cgroup/pids.max']='17';}];
 for(const alter of cases){const f=synthetic({initializer:true});alter(f);assert.throws(()=>f.boot.initializeVolume(),e=>e.message==='MANAGER_INSTALL_BOOTSTRAP_REFUSED');assert.equal(f.operations.some(v=>['chmod','chown','write','open'].includes(v[0])),false);}
});
test('runtime guards refuse RW root, extra capabilities, SSH mount, wrong UID or unbounded/excess resources',()=>{
 const cases=[f=>{f.kernel['/proc/self/mountinfo']=f.kernel['/proc/self/mountinfo'].replace('/ / ro,','/ / rw,');},f=>{f.kernel['/proc/self/status']=f.kernel['/proc/self/status'].replace(/0000000000000000/g,'0000000000000001');},f=>{f.kernel['/proc/self/mountinfo']+='4 1 8:1 /ssh /root/.ssh ro - ext4 /dev/vda1 ro\n';},f=>{f.proc.getuid=()=>0;},f=>{f.kernel['/sys/fs/cgroup/cpu.max']='max 100000';},f=>{f.kernel['/sys/fs/cgroup/memory.max']='268435457';},f=>{f.kernel['/sys/fs/cgroup/pids.max']='33';},f=>{f.kernel['/proc/self/mountinfo']=f.kernel['/proc/self/mountinfo'].replace('size=65536k','size=65537k');},f=>{f.dirs.get('/manager-install-proof').names=['previous-proof'];}];
 for(const alter of cases){const f=synthetic();alter(f);assert.throws(()=>f.boot.guardRuntime(),e=>e.message==='MANAGER_INSTALL_BOOTSTRAP_REFUSED');assert.equal(f.files.size,0);assert.equal(f.supervisorCalls(),0);}
});
test('bootstrap verifies all public source pins, stages read-only files and starts supervisor once without extra parent',()=>{
 const plan=B.buildCompose({suffix:'a1b2c3d4e5f6'}),bundle=bundleFromPlan(plan),f=synthetic();assert.equal(f.boot.bootstrap(bundle).syntheticServer,true);assert.equal(f.supervisorCalls(),1);assert.equal(f.files.size,8);
 for(const file of f.files.values()){assert.equal(file.mode,0o444);assert.equal(file.bytes.toString('utf8').includes('SYNTHETIC_RAM_ONLY_CANARY'),false);}
 for(const name of ['/review','/review/sql','/review/supervisor'])assert.equal(f.dirs.get(name).mode,0o555);assert.equal(Object.hasOwn(f.proc.env,'PGPASSWORD'),false);assert.equal(f.dirs.get('/manager-install-proof').names.length,0);
});
test('tampered pin, source, filename or duplicate payload rejects before any source write and clears administrative env',()=>{
 const original=bundleFromPlan(B.buildCompose({suffix:'a1b2c3d4e5f6'}));
 for(const alter of [b=>{b.files[0].sha256='f'.repeat(64);},b=>{b.files[0].base64=Buffer.from('SYNTHETIC_RAM_ONLY_CANARY').toString('base64');},b=>{b.files[0].name='../.env';},b=>{b.files[1]=b.files[0];}]){
  const f=synthetic(),bundle=JSON.parse(JSON.stringify(original));alter(bundle);assert.equal(f.boot.bootstrap(bundle),null);assert.equal(f.files.size,0);assert.equal(f.supervisorCalls(),0);assert.equal(Object.hasOwn(f.proc.env,'PGPASSWORD'),false);assert.equal(f.proc.exitCode,1);
 }
});
test('chunked entrypoint loader executes under VM filesystem guards and does not exceed individual argument bound',()=>{
 const plan=B.buildCompose({suffix:'a1b2c3d4e5f6'}),argv=JSON.parse(plan.json).services.installer.entrypoint,f=synthetic();f.proc.argv=['/usr/local/bin/node',...argv.slice(5)];
 const originalRequire=f.context.require;f.context.require=name=>name==='node:vm'?{Script:class{constructor(s){this.source=s;}runInThisContext(){return vm.runInContext(this.source,f.context,{timeout:1000});}}}:originalRequire(name);
 vm.runInContext(argv[3],f.context,{timeout:1000});assert.equal(f.supervisorCalls(),1);assert.equal(f.files.size,8);
});
