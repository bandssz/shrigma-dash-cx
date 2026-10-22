'use strict';
// Public source builder only. Import starts no file/environment/network work.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {EXPECTED}=require('./bootstrap.cjs');
const IMAGE='ghcr.io/bandssz/shrigma-dash-operational-canary@sha256:5ca20e4ea134b7a1a139b80c74a65573a4386d9584fcac40aeedaeb9cf8fe815';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function fail(){throw Error('MANAGER_INSTALL_COMPOSE_BUILD_REFUSED');}
function buildCompose({suffix}){
 if(typeof suffix!=='string'||!/^[a-f0-9]{12}$/.test(suffix))fail();
 const files=Object.entries(EXPECTED).map(([name,pin])=>{const bytes=fs.readFileSync(path.join(__dirname,'..',name));if(sha(bytes)!==pin)fail();return{name,sha256:pin,base64:bytes.toString('base64')};});
 const bundle=JSON.stringify({schema:'crm-manager-install-public-bundle-v1',files}),boot=fs.readFileSync(path.join(__dirname,'bootstrap.cjs'));
 const vmLoader='const crypto=require("node:crypto"),vm=require("node:vm");const bytes=Buffer.from('+JSON.stringify(boot.toString('base64'))+',"base64");if(crypto.createHash("sha256").update(bytes).digest("hex")!=='+JSON.stringify(sha(boot))+')throw Error("BOOTSTRAP_REFUSED");const m={exports:{}};new vm.Script("(function(module,exports,require){"+bytes.toString("utf8")+"\\n})").runInThisContext()(m,m.exports,require);';
 const encoded=Buffer.from(bundle).toString('base64'),chunks=encoded.match(/.{1,24576}/g);
 const runnerLoader=vmLoader+'const raw=Buffer.from(process.argv.slice(1).join(""),"base64");if(raw.length>262144||crypto.createHash("sha256").update(raw).digest("hex")!=='+JSON.stringify(sha(bundle))+')throw Error("BUNDLE_REFUSED");m.exports.bootstrap(JSON.parse(raw.toString("utf8")));';
 const initLoader=vmLoader+'try{m.exports.initializeVolume();}catch{process.exitCode=1;}';
 const serviceName='crm-manager-install-v3-'+suffix,volume='manager_proof_v3_'+suffix;
 const common={image:IMAGE,read_only:true,cap_drop:['ALL'],security_opt:['no-new-privileges:true'],restart:'no',init:true};
 const compose={
  'x-shrigma-install-review':{schema:'crm-manager-install-compose-plan-v1',projectName:'dashboard-image-20260930',serviceName,approvalRequired:true,bundleSha256:sha(bundle),bootstrapSha256:sha(boot)},
  services:{
   prepare_volume:{...common,user:'0:0',network_mode:'none',cap_add:['CHOWN'],cpus:0.1,mem_limit:'64m',memswap_limit:'64m',pids_limit:16,deploy:{replicas:1,restart_policy:{condition:'none'},resources:{limits:{cpus:'0.1',memory:'64M',pids:16}}},volumes:[volume+':/manager-install-proof'],entrypoint:['node','--max-old-space-size=16','-e',initLoader],command:[],healthcheck:{disable:true}},
   installer:{...common,user:'1000:1000',cpus:0.25,mem_limit:'256m',memswap_limit:'256m',pids_limit:32,deploy:{replicas:1,restart_policy:{condition:'none'},resources:{limits:{cpus:'0.25',memory:'256M',pids:32}}},depends_on:{prepare_volume:{condition:'service_completed_successfully'}},networks:['easypanel'],env_file:['.env'],environment:{NODE_PATH:'/app/node_modules',NODE_OPTIONS:'--max-old-space-size=96'},volumes:[volume+':/manager-install-proof'],tmpfs:['/review:rw,nosuid,nodev,noexec,size=64m,uid=1000,gid=1000,mode=0700'],entrypoint:['node','--max-old-space-size=96','-e',runnerLoader,'--',...chunks],command:[],healthcheck:{test:['CMD','node','--max-old-space-size=96','/review/supervisor/health.cjs','install'],interval:'15s',timeout:'3s',start_period:'60s',retries:2}}
  },
  volumes:{[volume]:{name:'shrigma-manager-install-proof-v3-'+suffix,labels:{'com.shrigma.purpose':'crm-manager-install-v3','com.shrigma.exclusive-service':serviceName}}},
  networks:{easypanel:{external:true,name:'easypanel'}}
 };
 const json=JSON.stringify(compose,null,2)+'\n';if(json.includes('${')||Buffer.byteLength(json)>524288||[...compose.services.prepare_volume.entrypoint,...compose.services.installer.entrypoint].some(s=>Buffer.byteLength(s)>98304))fail();
 return Object.freeze({projectName:'dashboard-image-20260930',serviceName,createDotEnv:true,environmentEmpty:true,json,bundleSha256:sha(bundle),bootstrapSha256:sha(boot)});
}
module.exports={buildCompose,IMAGE};
if(require.main===module){try{const suffix=process.argv[2];if(process.argv.length!==3)fail();process.stdout.write(buildCompose({suffix}).json);}catch{process.stderr.write('Public Compose plan build refused.\n');process.exitCode=1;}}
