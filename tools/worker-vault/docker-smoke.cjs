'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process'),a=require('node:assert/strict');
const image=process.argv[2],source=process.cwd();a.match(image||'',/^[a-z0-9:._/-]+$/);
const local=process.env.C15_LOCAL_DOCKER==='1',docker=local?'/Applications/Docker.app/Contents/Resources/bin/docker':'docker',prefix=local?['--config',path.resolve(source,'../../../docker-local-config'),'--host','unix:///Users/felipebandeiragoncalves/.docker/run/docker.sock']:[];
const name='c15-proof-'+Date.now(),run=(args,allowFailure=false)=>{const r=spawnSync(docker,[...prefix,...args],{encoding:'utf8',timeout:30000,maxBuffer:1024*1024});if(r.status!==0&&!allowFailure)throw Error('DOCKER_PROOF_STEP');return r;};
(async()=>{
 try{
  run(['run','--detach','--name',name,'--pull=never','--platform','linux/amd64','--network','none','--read-only','--user','1000:1000','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','768m','--pids-limit','128','--tmpfs','/tmp:rw,noexec,nosuid,mode=1777,size=256m','--tmpfs','/dashboard-data:rw,noexec,nosuid,mode=0700,uid=1000,gid=1000,size=64m','--mount','type=bind,src='+source+',dst=/source,readonly','--entrypoint','node',image,'/source/tools/worker-vault/image-gateway.cjs']);
  let ready=false;for(let n=0;n<60;n++){const r=run(['exec','--user','1000',name,'node','-e',"process.exit(require('fs').existsSync('/tmp/c15-image-ready.json')?0:1)"],true);if(r.status===0){ready=true;break;}await new Promise(r=>setTimeout(r,250));}a.equal(ready,true);
  const proof=run(['exec','--user','1000',name,'node','/source/tools/worker-vault/private-parent-smoke.cjs']);const result=JSON.parse(proof.stdout.trim().split(/\r?\n/).at(-1));a.equal(result.ok,true);
  run(['stop','--time','15',name]);const exit=run(['inspect','--format','{{.State.ExitCode}}',name]);a.equal(Number(exit.stdout),0);
  console.log(JSON.stringify({...result,actualApiGracefulStop:true}));
 }catch(e){const log=run(['logs',name],true);const lines=(log.stdout+log.stderr).trim().split(/\r?\n/).map(s=>{try{const v=JSON.parse(s);return{ok:v.ok,stage:v.stage,code:v.code,responseStatus:v.responseStatus,actualStatus:v.actualStatus,errorCode:v.errorCode};}catch{return null;}}).filter(Boolean);console.error(JSON.stringify({ok:false,stages:lines}));throw e;}finally{run(['rm','--force',name],true);}
})().catch(()=>{console.error(JSON.stringify({ok:false,code:'C15_DOCKER_PROOF_UNCONFIRMED'}));process.exitCode=1;});
