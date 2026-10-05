'use strict';
// Inert public source-only proof; only --oci with opt-in may use own CI Docker.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const C=require('./build-compose.cjs'),P=require('./oci-preflight.cjs'),E=require('../../crm-manager-read-credential-custody/easypanel-plan.cjs'),R=require('../../crm-manager-read-credential-custody/remote-operator.cjs'),G=require('../../crm-manager-read-credential-custody/public-postcondition.cjs');
const BUILDER_SHA='0be6f7b41433eab086a4a9f1fb5bf4e49cc611f9d257d7c9dfc27067571a00ea';
const PREVIOUS_OCI_SHA='d4936fc711ef8b1d3155ad415f4e38fc9d216dc7195f71d380870eda37a61fcd';
const IMAGE=C.IMAGE,FAIL='READ_BOOTSTRAP_HANDOFF_REFUSED',PURPOSE='read-stage-isolated-review';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex'),copy=v=>JSON.parse(JSON.stringify(v));
function fail(){throw Error(FAIL);}
function same(a,b){if(JSON.stringify(a)!==JSON.stringify(b))fail();}
function sources(){if(sha(fs.readFileSync(path.join(__dirname,'build-compose.cjs')))!==BUILDER_SHA||sha(fs.readFileSync(path.join(__dirname,'oci-preflight.cjs')))!==PREVIOUS_OCI_SHA||Object.keys(C.PINS).length!==9)fail();return Object.fromEntries(Object.entries(C.PINS).map(([name,pin])=>{const p=path.join(__dirname,'../runtime',name),s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)fail();const b=fs.readFileSync(p);if(sha(b)!==pin)fail();return[name,b.toString('utf8')];}));}
function intent(){return{schema:'crm-manager-read-runtime-intent-v1',operationId:crypto.randomUUID(),credentialIntentId:crypto.randomUUID(),action:'stage',fromPhase:'empty'};}
function buildHandoff(input){
 const remote=R.assertRemotePlan(input.remotePlan);if(remote.mode!=='execute')fail();const p=remote.descriptor,e=E.buildEasypanelInputs({remotePlan:remote});
 same(e.target,{projectName:p.projectName,serviceName:p.serviceName});same(e.createPublicBootstrap.input.domains,[]);if(e.createPublicBootstrap.input.env!==''||e.image!==IMAGE)fail();
 const b=JSON.parse(e.createPublicBootstrap.input.source.content),x=JSON.parse(e.updatePrivateSource.input.content),gateway=copy(p.compose.services.gateway);delete gateway.depends_on;
 same(b,{services:{'init-volumes':p.compose.services['init-volumes']},volumes:p.compose.volumes});
 same(x,{services:{gateway},volumes:{source:{external:true,name:p.compose.volumes.source.name},ledger:{external:true,name:p.compose.volumes.ledger.name}},networks:p.compose.networks});
 if(e.bootstrapContentSha256!==sha(JSON.stringify(b))||e.executionContentSha256!==sha(JSON.stringify(x)))fail();
 // CI uses the EXACT public HTTP observer command; only its network is isolated.
 const publicProbe=G.buildPublicPostcondition({remotePlan:remote}),publicContent=JSON.stringify(publicProbe.compose);if(e.updatePublicProbe.input.content!==publicContent||e.publicProbeContentSha256!==sha(publicContent))fail();const ci=copy(publicProbe.compose),g=ci.services.gateway;
 delete g.networks;g.network_mode='none';delete ci.networks;
 return{remotePlan:remote,plan:p,easypanel:e,bootstrap:b,execution:ci,publicProbe};
}
function own(labels,suffix,project){return P.owned(labels,suffix,project);}
function listed(raw,expected){if(typeof raw!=='string'||raw.length>128)fail();const n=raw===''?[]:raw.split('\n');if(n.length>1||n.some(x=>x!==expected))fail();return n.length===1;}
function optIn(){if(process.platform!=='linux'||process.versions.node.split('.')[0]!=='22'||process.env.READ_BOOTSTRAP_HANDOFF_OCI!=='1'||!fs.statSync('/var/run/docker.sock').isSocket())fail();for(const n of Object.keys(process.env))if(n.startsWith('PG')||n==='READ_SERVICE_SCRAM'||n.startsWith('READ_ACTIVATION_'))fail();}
function runOci(){
 optIn();const suffix=crypto.randomBytes(6).toString('hex'),project='read-handoff-oci-'+suffix,h=buildHandoff({remotePlan:R.buildStagePlan({suffix,sources:sources(),intent:intent(),domainId:crypto.randomUUID()})}),plan=h.plan;
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'read-handoff-oci-'));fs.chmodSync(temporary,0o700);const config=path.join(temporary,'docker-config');fs.mkdirSync(config,{mode:0o700});
 const bootstrapFile=path.join(temporary,'bootstrap.json'),executionFile=path.join(temporary,'execution.json');fs.writeFileSync(bootstrapFile,JSON.stringify(h.bootstrap),{mode:0o600,flag:'wx'});fs.writeFileSync(executionFile,JSON.stringify(h.execution),{mode:0o600,flag:'wx'});
 const {spawnSync}=require('node:child_process');const docker=(args,timeout=30000)=>{const r=spawnSync('/usr/bin/docker',['--config',config,'--host','unix:///var/run/docker.sock',...args],{env:{PATH:'/usr/bin:/bin',LANG:'C'},encoding:'utf8',maxBuffer:262144,timeout});if(r.status!==0||typeof r.stdout!=='string')fail();return r.stdout.trim();};
 const parse=x=>{try{return JSON.parse(x);}catch{fail();}},inspect=id=>parse(docker(['container','inspect',id]))[0],cc=(f,a)=>docker(['compose','--project-name',project,'--file',f,...a]);
 const containerExists=id=>listed(docker(['container','ls','--all','--no-trunc','--filter','id='+id,'--format','{{.ID}}']),id),volumeExists=n=>listed(docker(['volume','ls','--filter','name='+n,'--format','{{.Name}}']),n);
 const volumeNames=Object.values(plan.compose.volumes).map(v=>v.name),ids={};let attempted=false,complete=false,phase='admission',cleanupOk=true;
 function capture(file,kind){const id=cc(file,['ps','--all','--quiet',kind]);if(!id)return;if(!/^[a-f0-9]{64}$/.test(id))fail();if(!own(inspect(id).Config?.Labels,suffix,project))fail();if(ids[kind]&&ids[kind]!==id)fail();ids[kind]=id;}
 function publicContainer(v){const g=h.execution.services.gateway;if(JSON.stringify(v.Config?.Entrypoint)!==JSON.stringify(g.entrypoint)||JSON.stringify(v.Config?.Cmd)!==JSON.stringify(g.command))fail();const normalized=copy(v),previous=P.preflightCompose(plan).services.gateway;normalized.Config.Entrypoint=previous.entrypoint;normalized.Config.Cmd=previous.command;return P.assertContainer(normalized,'gateway',plan,project);}
 function observePublic(){const host=h.remotePlan.descriptor.domain.host,code="'use strict';const http=require('node:http');let left=20;function get(){const req=http.get({hostname:'127.0.0.1',port:8099,path:'/status',headers:{Host:"+JSON.stringify(host)+"}},res=>{let body='';res.setEncoding('utf8');res.on('data',x=>{body+=x;if(Buffer.byteLength(body)>4096){req.destroy();process.exitCode=1;}});res.on('end',()=>{if(res.statusCode!==200){process.exitCode=1;return;}process.stdout.write(body);});});req.setTimeout(1000,()=>req.destroy());req.on('error',()=>{if(--left>0)setTimeout(get,100);else process.exitCode=1;});}get();";const raw=docker(['exec','--user','1000:1000',ids.gateway,'node','--max-old-space-size=16','-e',code],15000);return G.acceptPostcondition(raw,h.remotePlan);}
 function volumeAdmission(){for(const n of volumeNames){if(!volumeExists(n))fail();const v=parse(docker(['volume','inspect',n]))[0];if(v.Name!==n||!own(v.Labels,suffix,project))fail();}}
 try{
  for(const n of volumeNames)if(volumeExists(n))fail();if(cc(bootstrapFile,['ps','--all','--quiet'])||cc(executionFile,['ps','--all','--quiet']))fail();
  phase='image';docker(['pull','--quiet',IMAGE],180000);P.assertImage(parse(docker(['image','inspect',IMAGE]))[0]);
  phase='parse-bootstrap';const nb=parse(cc(bootstrapFile,['config','--format','json']));if(Object.keys(nb.services).join(',')!=='init-volumes'||Object.keys(nb.networks||{}).length)fail();
  phase='create-bootstrap';attempted=true;cc(bootstrapFile,['create','--no-build','--pull','never']);capture(bootstrapFile,'init-volumes');if(Object.keys(ids).join(',')!=='init-volumes')fail();
  let v=inspect(ids['init-volumes']);P.assertContainer(v,'init-volumes',plan,project);if(v.State.Status!=='created')fail();volumeAdmission();
  phase='run-bootstrap';docker(['start',ids['init-volumes']]);if(docker(['wait',ids['init-volumes']],45000)!=='0')fail();v=inspect(ids['init-volumes']);P.assertContainer(v,'init-volumes',plan,project);if(v.State.Status!=='exited'||v.State.ExitCode!==0||!v.State.FinishedAt||v.State.FinishedAt.startsWith('0001-'))fail();
  // Removing only this stopped initializer MUST retain both named volumes.
  phase='handoff';if(!own(v.Config.Labels,suffix,project))fail();docker(['rm',ids['init-volumes']]);if(containerExists(ids['init-volumes']))fail();volumeAdmission();
  const nx=parse(cc(executionFile,['config','--format','json']));if(Object.keys(nx.services).join(',')!=='gateway'||Object.keys(nx.networks||{}).length)fail();
  for(const key of ['source','ledger'])if(nx.volumes[key].external!==true||nx.volumes[key].name!==h.execution.volumes[key].name)fail();
  phase='create-external-gateway';cc(executionFile,['create','--no-build','--pull','never']);capture(executionFile,'gateway');if(!ids.gateway||ids.gateway===ids['init-volumes'])fail();
  v=inspect(ids.gateway);publicContainer(v);if(v.State.Status!=='created')fail();volumeAdmission();
  phase='run-external-probe';docker(['start',ids.gateway]);observePublic();v=inspect(ids.gateway);publicContainer(v);if(v.State.Status!=='running'||!v.State.Running)fail();
  phase='public-stop';docker(['stop','--time','5',ids.gateway],15000);v=inspect(ids.gateway);publicContainer(v);if(v.State.Running||v.State.Status!=='exited')fail();volumeAdmission();
  phase='public-reenable';docker(['start',ids.gateway]);observePublic();v=inspect(ids.gateway);publicContainer(v);if(v.State.Status!=='running'||!v.State.Running)fail();
  docker(['stop','--time','5',ids.gateway],15000);v=inspect(ids.gateway);publicContainer(v);if(v.State.Running||v.State.Status!=='exited')fail();
  complete=true;return Object.freeze({schema:'shrigma-read-bootstrap-external-handoff-oci-v1',publicBootstrapOnly:true,initializerExitCode:0,initializerRemovedBeforeGateway:true,externalVolumesRetained:true,publicProbeVerifiedTwice:true,publicReenableOnly:true,sourceFilesVerified:9,sourceReadOnlyVerified:true,ledgerEmptyAndPrivateVerified:true,uid1000Verified:true,networkNoneVerified:true,resourcePolicyVerified:true,applicationStarted:false,postgresConnected:false,privateEnvironmentUsed:false,domainRouteProved:false});
 }catch{throw Error(FAIL);}finally{
  if(attempted){
   for(const [file,kind]of[[bootstrapFile,'init-volumes'],[executionFile,'gateway']]){try{capture(file,kind);}catch{cleanupOk=false;}}
   for(const id of Object.values(ids)){try{if(containerExists(id)){if(!own(inspect(id).Config?.Labels,suffix,project))fail();docker(['rm','--force','--volumes',id]);if(containerExists(id))cleanupOk=false;}}catch{cleanupOk=false;}}
   for(const n of volumeNames){try{if(volumeExists(n)){const v=parse(docker(['volume','inspect',n]))[0];if(!own(v.Labels,suffix,project))fail();docker(['volume','rm',n]);if(volumeExists(n))cleanupOk=false;}}catch{cleanupOk=false;}}
  }
  try{fs.rmSync(temporary,{recursive:true,force:true});}catch{cleanupOk=false;}
  if(!cleanupOk||!complete){process.stderr.write(JSON.stringify({schema:'shrigma-read-bootstrap-handoff-refusal-v1',phase:['admission','image','parse-bootstrap','create-bootstrap','run-bootstrap','handoff','create-external-gateway','run-external-probe','public-stop','public-reenable'].includes(phase)?phase:'admission',cleanup:cleanupOk?'verified':'refused'})+'\n');if(!cleanupOk)throw Error(FAIL);}
 }
}
module.exports=Object.freeze({buildHandoff,listed,runOci,sources});
if(require.main===module){try{if(process.argv.length!==3||process.argv[2]!=='--oci')fail();process.stdout.write(JSON.stringify(runOci())+'\n');}catch{process.stderr.write(FAIL+'\n');process.exitCode=1;}}
