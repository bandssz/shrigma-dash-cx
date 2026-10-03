'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const file=path.join(__dirname,'native-writer.test.cjs');
test('native proof import is inert with forbidden environment/transport/files',()=>{
 const m={exports:{}},proc=new Proxy({}, {get(){throw Error('FORBIDDEN_PROCESS_ACCESS');}}),requireStub=name=>{if(name==='node:fs')return{readFileSync(){throw Error('FORBIDDEN_FILE_READ');}};if(['node:assert/strict','node:path','node:crypto'].includes(name))return require(name);throw Error('FORBIDDEN_DEPENDENCY');};
 vm.runInNewContext(fs.readFileSync(file,'utf8'),{module:m,exports:m.exports,require:requireStub,process:proc},{timeout:1000});assert.equal(typeof m.exports.proveNativeWriter,'function');assert.equal(m.exports.PROFILE,'07ebbf98472f2d693a35e8bb7151e966692e2b90af921c64807041b44c067040');
});
test('native client metadata/identity pins fail closed before transport and without relying on PG environment',async()=>{
 const N=require('./native-writer.test.cjs'),config=N.clientConfig(),client={connectionParameters:{...config}};assert.equal(N.checkParameters(client),undefined);
 for(const change of[{host:'remote.invalid'},{port:5432},{database:'listmonk'},{user:'other'},{password:''},{ssl:true},{application_name:'foreign'},{options:''}])assert.throws(()=>N.checkParameters({connectionParameters:{...config,...change}}),e=>e.message==='NATIVE_WRITER_PROOF_REFUSED');
 const good={db:'crm_manager_writer_fixture',role:'postgres',session:'postgres',major:17,port:5432,app:'shrigma-manager-writer-native-fixture',cluster:'shrigma-native-writer-disposable-only'};
 await N.identity({query:async()=>({rows:[good]})});for(const change of[{db:'listmonk'},{session:'foreign'},{major:16},{port:5440},{cluster:'production'}])await assert.rejects(N.identity({query:async()=>({rows:[{...good,...change}]})}));
});
test('CI proposal parses as safe YAML and Bash only; resources/destination/trap/source pins are closed',()=>{
 const {execFileSync}=require('node:child_process'),script=path.join(__dirname,'run-native-writer-proof.sh');execFileSync('/bin/bash',['-n',script],{env:{PATH:'/usr/bin:/bin'},timeout:5000});
 const plan=fs.readFileSync(path.join(__dirname,'ci-job-proposal.yml'),'utf8'),r=execFileSync('/usr/bin/ruby',['-r','yaml','-r','json','-e','STDOUT.write(JSON.generate(YAML.safe_load(STDIN.read)))'],{input:plan,env:{PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:5000,maxBuffer:65536});const job=JSON.parse(r)['native-postgres17-writer-component-proof'];assert.equal(job.permissions.contents,'read');assert.equal(job['timeout-minutes'],8);assert.equal(job.steps.at(-1).run,'bash tools/crm-manager-writer-review/native/run-native-writer-proof.sh');assert.equal(Object.values(job.steps.at(-1).env).some(v=>String(v).includes('secrets.')),false);
 const raw=fs.readFileSync(script,'utf8');assert.match(raw,/--publish 127\.0\.0\.1:5440:5432/);assert.match(raw,/--cpus 1 --memory 512m --memory-swap 512m --pids-limit 128/);assert.match(raw,/--host unix:\/\/\/var\/run\/docker\.sock/);assert.match(raw,/rm --force "\$WRITER_NATIVE_CONTAINER_ID"/);assert.doesNotMatch(raw,/docker[^\n]*logs|PGPASSWORD|DATABASE_URL|DOCKER_HOST/);
});
