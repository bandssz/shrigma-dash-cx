'use strict';
// Public inert builder: no env, filesystem, client, timer or Docker on import.
const crypto=require('node:crypto');
const PROJECT='dashboard-image-20260930';
const IMAGE='ghcr.io/bandssz/shrigma-dash-operational-canary@sha256:5ca20e4ea134b7a1a139b80c74a65573a4386d9584fcac40aeedaeb9cf8fe815';
const PINS=Object.freeze({
 'activation.cjs':'9a3459983b415661e2665e8c3f6de1ae4fa6aa712ae012ebd3344da09e180a83',
 'sources.cjs':'9c216b9e651c52e142babb3c069493b4f8329cdc0320eadef37be99bd13a1de8',
 'runtime.cjs':'0fde24c3837f50847f7ec282427318389d83e6ce3321a98b4ef6679b30751331',
 'journal.cjs':'bbd69749e555c850fc620bf60aa9f6f226668511e1ee9b9aca7a482d852f7466',
 'cli.cjs':'abeb28eacbf4daf6692becb5c4caeefaad5bd32d2c42be97dd04cb026e5143c9',
 'read-proof.cjs':'4404e1ccd52cda9a9dccf6bdc648178f06659a5b9bc1ea64bc6fbe8652b52e65',
 'source-pins.cjs':'e4c9171752be502cc1101bb0e5edd055901d58d0402b7e24a8da59e3ef645d72',
 'supervisor.cjs':'b48c0ea980c23f2b343383e7fbfe0392707b8418a3005e4fec694bcfaacb87b0',
 'health.cjs':'d6a058b1beadb3b6ea24a154f6d9238ad90ad017906a4de51fcbdaa8e01462ed'
});
const MAX_INITIALIZER_ARG_BYTES=98304;
function fail(){throw Error('READ_RUNTIME_COMPOSE_PROPOSAL_REFUSED');}
function exact(v,keys){if(!v||Object.getPrototypeOf(v)!==Object.prototype||Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k)))fail();}
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
function validateSources(sources){exact(sources,Object.keys(PINS));for(const [name,pin]of Object.entries(PINS))if(typeof sources[name]!=='string'||hash(sources[name])!==pin)fail();return sources;}
function buildInitializer(sources){
 validateSources(sources);const bundle=Object.keys(PINS).map(name=>({name,base64:Buffer.from(sources[name],'utf8').toString('base64'),sha256:PINS[name]}));
 const code=`'use strict';const fs=require('node:fs'),crypto=require('node:crypto');const pins=${JSON.stringify(PINS)},bundle=${JSON.stringify(bundle)};let ledgerFd;
try{
 if(process.getuid()!==0||process.getgid()!==0||JSON.stringify(fs.readdirSync('/sys/class/net').sort())!==JSON.stringify(['lo'])||process.env.PG_ADMIN_PASSWORD!==undefined||process.env.READ_SERVICE_SCRAM!==undefined)throw 0;
 const dirs=['/source-volume','/runtime-proof'];
 const checked=dirs.map(p=>{const s=fs.lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||s.gid!==0||(s.mode&0o7777)!==0o755||fs.realpathSync(p)!==p||fs.readdirSync(p).length)throw 0;return s;});
 if(checked[0].dev===checked[1].dev&&checked[0].ino===checked[1].ino)throw 0;
 if(bundle.length!==9||JSON.stringify(bundle.map(x=>x.name))!==JSON.stringify(Object.keys(pins)))throw 0;
 let bytes=0;const decoded=bundle.map(x=>{if(Object.keys(x).length!==3||typeof x.base64!=='string'||x.sha256!==pins[x.name])throw 0;const b=Buffer.from(x.base64,'base64');if(b.toString('base64')!==x.base64||b.length<1||b.length>20000||(bytes+=b.length)>65536||crypto.createHash('sha256').update(b).digest('hex')!==x.sha256)throw 0;return {name:x.name,bytes:b};});
 // Both fresh empty mounts and every source are admitted BEFORE any write.
 // Keep this FD before ownership changes: UID0 with only CHOWN has no DAC override.
 ledgerFd=fs.openSync('/runtime-proof',fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
 for(const x of decoded){const file='/source-volume/'+x.name;const fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o444);try{fs.writeFileSync(fd,x.bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
 if(JSON.stringify(fs.readdirSync('/source-volume').sort())!==JSON.stringify(Object.keys(pins).sort()))throw 0;
 for(const x of decoded){const file='/source-volume/'+x.name,s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.uid!==0||s.gid!==0||s.nlink!==1||(s.mode&0o7777)!==0o444||s.size!==x.bytes.length||crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==pins[x.name])throw 0;}
 if(fs.readdirSync('/runtime-proof').length)throw 0;
 fs.chmodSync('/source-volume',0o555);fs.chmodSync('/runtime-proof',0o700);fs.chownSync('/runtime-proof',1000,1000);
 for(const [p,uid,gid,mode]of [['/source-volume',0,0,0o555],['/runtime-proof',1000,1000,0o700]]){const s=fs.lstatSync(p);if(s.uid!==uid||s.gid!==gid||(s.mode&0o7777)!==mode)throw 0;}
 const sourceFd=fs.openSync('/source-volume',fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(sourceFd);}finally{fs.closeSync(sourceFd);}
 fs.fsyncSync(ledgerFd);
}catch{process.stderr.write('READ_PUBLIC_VOLUME_INITIALIZER_REFUSED\\n');process.exitCode=1;}finally{if(ledgerFd!==undefined){try{fs.closeSync(ledgerFd);}catch{process.stderr.write('READ_PUBLIC_VOLUME_INITIALIZER_REFUSED\\n');process.exitCode=1;}}}`;
 if(Buffer.byteLength(code)>MAX_INITIALIZER_ARG_BYTES||code.includes('$'))fail();return code;
}
function buildCompose(input){
 exact(input,['suffix','sources']);if(typeof input.suffix!=='string'||!/^[0-9a-f]{12}$/.test(input.suffix))fail();const sources=validateSources(input.sources),suffix=input.suffix;
 const serviceName='mgr-stage-'+suffix,host=serviceName+'.tazdb8.easypanel.host',ledger='shrigma-read-stage-'+suffix;
 const aliases=[PROJECT+'_'+serviceName+'-gateway',PROJECT+'_'+serviceName+'_gateway'];if(aliases.some(a=>Buffer.byteLength(a)>63))fail();
 const labels={'com.shrigma.read-runtime-plan':suffix,'com.shrigma.read-runtime-purpose':'read-stage-isolated-review'};
 const initialize=buildInitializer(sources),mount={type:'volume',source:'ledger',target:'/runtime-proof',volume:{nocopy:true}},sourceInit={type:'volume',source:'source',target:'/source-volume',volume:{nocopy:true}},sourceRuntime={type:'volume',source:'source',target:'/review',read_only:true,volume:{nocopy:true}};
 const init={image:IMAGE,user:'0:0',read_only:true,cap_drop:['ALL'],cap_add:['CHOWN'],security_opt:['no-new-privileges:true'],network_mode:'none',healthcheck:{disable:true},restart:'no',cpus:0.1,mem_limit:67108864,memswap_limit:67108864,pids_limit:16,environment:{},entrypoint:['node'],command:['--max-old-space-size=16','-e',initialize],volumes:[sourceInit,mount],labels};
 const gateway={image:IMAGE,user:'1000:1000',read_only:true,cap_drop:['ALL'],security_opt:['no-new-privileges:true'],init:true,restart:'no',cpus:0.35,mem_limit:335544320,memswap_limit:335544320,pids_limit:64,environment:{NODE_PATH:'/app/node_modules'},env_file:['.env'],entrypoint:['timeout','-s','KILL','600'],command:['node','--max-old-space-size=96','/review/supervisor.cjs'],depends_on:{'init-volumes':{condition:'service_completed_successfully'}},volumes:[sourceRuntime,mount],tmpfs:['/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777'],networks:{easypanel:{aliases}},healthcheck:{test:['CMD','node','/review/health.cjs'],interval:'5s',timeout:'2s',retries:2},labels,deploy:{replicas:1,restart_policy:{condition:'none'},resources:{limits:{cpus:'0.35',memory:'320m',pids:64}}}};
 return {schema:'shrigma-read-runtime-compose-proposal-v1',inertProposal:true,deployability:'prepared_not_deployed',sourceTransport:'new-public-source-volume-read-only',projectName:PROJECT,serviceName,env:'',createDotEnv:true,sourcePins:PINS,image:IMAGE,initializerArgumentBytes:Buffer.byteLength(initialize),domain:{host,https:true,port:8099,composeService:'gateway',readOnlyStatusPath:'/status'},compose:{services:{'init-volumes':init,gateway},volumes:{source:{name:'shrigma-read-source-'+suffix,labels},ledger:{name:ledger,labels}},networks:{easypanel:{external:true,name:'easypanel'}}},limitations:{deployApproved:false,mutationActionsApproved:[],privateEnvConfigured:false,composeConfigValidationCompleted:false,actualSourceMountReadOnlyVerified:false,actualInitializerOCICompleted:false,inlineConfigsAvoidedForRootReadOnlyCompatibility:true,sharedNetworkIsFullIsolation:false,initializerOnlyAcceptsTwoNewEmptyVolumes:true,existingLedgerReconciliationNeedsSeparateReviewedPlan:true}};
}
module.exports=Object.freeze({buildCompose,buildInitializer,validateSources,PINS,PROJECT,IMAGE,MAX_INITIALIZER_ARG_BYTES});
