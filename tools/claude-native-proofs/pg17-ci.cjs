'use strict';
// Candidate CI only. Import exposes pure guards; native work requires opt-in.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const IMAGE='postgres:17.10@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317';
const IMAGE_ID='sha256:1edc8e87e53194e0cc8006c4e9df9b626c6c72cb43ad3385f0f34af7922065b1';
const LABEL='com.shrigma.claude-native-pg17';
const FIXTURES=Object.freeze({
 audience:Object.freeze({file:'tests/claude-audience-read-pg16-postgres.cjs',flag:'CRM_AUDIENCE_TEST_ISOLATED',mode:'script'}),
 templates:Object.freeze({file:'tests/claude-template-read-pg16-postgres.cjs',flag:'CRM_TEMPLATE_TEST_ISOLATED',mode:'script'}),
 recovery:Object.freeze({file:'tests/claude-pending-recovery-pg16-postgres.cjs',flag:'CRM_PENDING_RECOVERY_TEST_ISOLATED',mode:'test'}),
 installer:Object.freeze({file:'tests/claude-pending-recovery-install-pg16-postgres.cjs',flag:'CRM_PENDING_RECOVERY_TEST_ISOLATED',mode:'test'}),
 gateway:Object.freeze({file:'tests/crm-campaign-gateway-postgres.cjs',flag:'CRM_CAMPAIGN_GATEWAY_TEST_ISOLATED',mode:'test'})
});
function fail(){throw Error('CLAUDE_NATIVE_PG17_CI_REFUSED');}
function fixture(caseId){if(typeof caseId!=='string'||!Object.hasOwn(FIXTURES,caseId))fail();return FIXTURES[caseId];}
function context(env){
 if(env.CLAUDE_NATIVE_PG17_CI!=='1'||!Object.hasOwn(FIXTURES,env.CLAUDE_PG17_CASE)||!/^[a-f0-9]{64}$/.test(env.CLAUDE_PG17_CONTAINER_ID||''))fail();
 const owner=env.CLAUDE_PG17_OWNER;if(!new RegExp('^[1-9][0-9]*-[1-9][0-9]*-'+env.CLAUDE_PG17_CASE+'$').test(owner||''))fail();
 return Object.freeze({caseId:env.CLAUDE_PG17_CASE,id:env.CLAUDE_PG17_CONTAINER_ID,owner});
}
function verifyContainer(v,c){
 const h=v?.HostConfig,k=v?.Config,p=h?.PortBindings?.['5432/tcp'],n=v?.NetworkSettings?.Networks;
 if(v?.Id!==c.id||v.Image!==IMAGE_ID||k?.Image!==IMAGE||k.Labels?.[LABEL]!==c.owner||!v.State?.Running||v.State.OOMKilled||v.State.Dead||h?.Memory!==536870912||h.MemorySwap!==536870912||h.NanoCpus!==1000000000||h.PidsLimit!==128||h.Privileged!==false||!Array.isArray(p)||p.length!==1||p[0].HostIp!=='127.0.0.1'||p[0].HostPort!=='55440'||Object.keys(h.PortBindings).length!==1||!n||Object.keys(n).length!==1||Object.keys(n).some(x=>['host','easypanel','none'].includes(x))||Object.values(n).some(x=>!/^[a-f0-9]{64}$/.test(x.NetworkID||'')))fail();
 const env=k.Env||[];if(!env.includes('POSTGRES_DB=listmonk')||!env.includes('POSTGRES_HOST_AUTH_METHOD=trust')||env.some(x=>/^(POSTGRES_PASSWORD|POSTGRES_PASSWORD_FILE|PGPASSWORD)=/.test(x)))fail();
 return true;
}
function verifyDatabase(r){if(!r||r.version!=='170010'||r.db!=='listmonk'||r.who!=='postgres'||r.session!=='postgres'||r.port!==5432||r.readonly!=='on'||r.tables!==0)fail();return true;}
function workerEnvironment(caseId,pgDirectory,guard){
 const f=fixture(caseId);if(!path.isAbsolute(pgDirectory)||!path.isAbsolute(guard))fail();
 return Object.freeze({PATH:'/usr/bin:/bin',LANG:'C.UTF-8',TZ:'UTC',NODE_PATH:path.dirname(pgDirectory),PG_MODULE:pgDirectory,TEST_DATABASE_URL:'postgresql://postgres@127.0.0.1:55440/listmonk',[f.flag]:'1',CRM_PG_EXPECTED_VERSION_NUM:'170010',CLAUDE_PG17_NETWORK_GUARD:'1'});
}
function dockerOutput(r){if(r.status!==0||typeof r.stdout!=='string')fail();return r.stdout.trim();}
let dockerConfig;
function docker(args){if(!dockerConfig)fail();return dockerOutput(spawnSync('/usr/bin/docker',['--config',dockerConfig,'--host','unix:///var/run/docker.sock',...args],{env:{PATH:'/usr/bin:/bin',LANG:'C'},encoding:'utf8',maxBuffer:262144,timeout:30000}));}
function inspect(id){try{const v=JSON.parse(docker(['container','inspect',id]));if(!Array.isArray(v)||v.length!==1)fail();return v[0];}catch{fail();}}
function ownedVolume(v,c){
 if(v?.Id!==c.id||v.Image!==IMAGE_ID||v.Config?.Labels?.[LABEL]!==c.owner||!Array.isArray(v.Mounts)||v.Mounts.length!==1)fail();
 const m=v.Mounts[0];if(m.Type!=='volume'||m.Destination!=='/var/lib/postgresql/data'||!/^[a-f0-9]{64}$/.test(m.Name||'')||m.RW!==true)fail();return m.Name;
}
function cleanup(c){
 // GHA generated this exact ID; only its explicitly labelled service is removed.
 const volume=ownedVolume(inspect(c.id),c);
 docker(['rm','--force','--volumes',c.id]);
 const left=docker(['container','ls','--all','--no-trunc','--filter','id='+c.id,'--format','{{.ID}}']);if(left!==''||docker(['volume','ls','--filter','name='+volume,'--format','{{.Name}}'])!=='')fail();
 return Object.freeze({schema:'shrigma-claude-pg17-cleanup-v1',removed:true,ownDataVolumeRemoved:true});
}
async function native(c){
 const container=inspect(c.id);verifyContainer(container,c);ownedVolume(container,c);
 const root=path.resolve(__dirname,'../..'),pgDirectory=path.join(root,'services/crm-manager-provisioner/node_modules/pg'),guard=path.join(__dirname,'pg17-network-guard.cjs');
 const pkg=JSON.parse(fs.readFileSync(path.join(pgDirectory,'package.json'),'utf8'));if(pkg.version!=='8.13.1')fail();
 require('./pg17-network-guard.cjs').install();
 const {Client}=require(pgDirectory),db=new Client({connectionString:'postgresql://postgres@127.0.0.1:55440/listmonk',connectionTimeoutMillis:3000,query_timeout:5000});
 try{await db.connect();await db.query('BEGIN READ ONLY');verifyDatabase((await db.query("SELECT current_setting('server_version_num') version,current_database() db,current_user who,session_user session,inet_server_port() port,current_setting('transaction_read_only') readonly,(SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r') tables")).rows[0]);await db.query('ROLLBACK');}finally{await db.end().catch(()=>{});}
 const f=fixture(c.caseId),file=path.join(root,f.file),s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||fs.realpathSync(file)!==file)fail();
 const args=['--max-old-space-size=128','--require',guard];if(f.mode==='test')args.push('--test','--test-timeout=120000');args.push(file);
 const result=spawnSync(process.execPath,args,{cwd:root,env:workerEnvironment(c.caseId,pgDirectory,guard),stdio:'inherit',timeout:150000});if(result.status!==0)fail();
 return Object.freeze({schema:'shrigma-claude-pg17-fixture-v1',fixture:c.caseId,serverVersion:'170010',freshDatabaseVerified:true,ownServiceVerified:true,externalNetworkAllowed:false,productionSQLExecuted:false});
}
module.exports=Object.freeze({IMAGE,IMAGE_ID,LABEL,FIXTURES,fixture,context,verifyContainer,verifyDatabase,workerEnvironment,dockerOutput,ownedVolume});
if(require.main===module){(async()=>{try{if(process.platform!=='linux'||process.versions.node.split('.')[0]!=='22'||process.argv.length!==3||!['--native','--cleanup'].includes(process.argv[2]))fail();const c=context(process.env);dockerConfig=fs.mkdtempSync(path.join(os.tmpdir(),'shrigma-claude-pg17-docker-'));fs.chmodSync(dockerConfig,0o700);const result=process.argv[2]==='--cleanup'?cleanup(c):await native(c);process.stdout.write(JSON.stringify(result)+'\n');}catch{process.stderr.write('CLAUDE_NATIVE_PG17_CI_REFUSED\n');process.exitCode=1;}finally{if(dockerConfig){try{fs.rmSync(dockerConfig,{recursive:true,force:false});}catch{process.stderr.write('CLAUDE_NATIVE_PG17_CLEANUP_REFUSED\n');process.exitCode=1;}}}})();}
