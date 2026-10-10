"use strict";
// Inert SOURCE. It cannot authenticate a human, issue grants, connect or execute.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const ASSETS=Object.freeze({
  "sql/CLAIM.original.sql": "33d1fc3981402d468f86660222ce02116576db0193e7edf8c10cbc233b65df5f",
  "sql/CLAIM.proposed.sql": "413405c54e3ad1c10b586c027494fa3be3e26cddc469d670762acea4adc8a709",
  "sql/GUARD.original.sql": "85647e4e1e7c6c009a2caad4cee8ad9505d4dd232de488f617c6c8f4cd4c3122",
  "sql/GUARD.proposed.sql": "5fed102b61c871678eb2b14eee73f81d764bdbce066128b378c16c2f5a7442c8",
  "sql/OBJECTS.install.sql": "cac58221689ee10702352846f91070bd29c6ba0a3ebfeb4297e4be37314394f0",
  "sql/OPERATION.atomic.sql.in": "a3244fce4ef6cb71e9d2fe060b04193a94ea635a5b973d632323f6946fc1b805",
  "sql/RECOVER.original.sql": "0c38364a5a351f61349fe4c6aef25dbf3ac90c3896a09da1f7eb871d69b7959a",
  "sql/RECOVER.proposed.sql": "d9a428584dcf5f3284062f17bcc7bea4117b27cec7bf33c6db98c5f7f03bae12",
  "sql/dispose.post.sql": "650e510ba225c1b28a39d32379c04fcfe52fed91999eff5938f71d0713c4d5ec",
  "sql/dispose.stage.sql": "22a6ec151001aba519be5bda6c3669369bfc5c6711e5d82b0d2c2ede29c30856",
  "sql/install.post.sql": "86424aac129f35d73fc6122848e8af0e11182a339186afa438913b6ca3a58c8d",
  "sql/install.stage.sql": "ef7eb7346dd2d886840ca5306d7906f9fa5103c151529e1cdbe6a2bf217c75aa",
  "sql/resume.post.sql": "b47c4e14f119a7874cf3ecd34dc3b13338195204d9015ced1d50bff80ccedb63",
  "sql/resume.stage.sql": "673bc69ca69971adb541621e75615e1f58766091a9d1c78753a9d0155b4d29a0",
  "sql/snapshot.before-install.sql": "2a0678b973d7959870cbf8074457713e7b82dfdb070d70a1667ebde47c8c73c6",
  "sql/snapshot.private-read.sql": "5af07faae7467eb9f816c18c0cbbe77af6a7d1dda13545ddc43736c9ef794e03",
  "PUBLIC-FUNCTION-PINS.before.json": "5d4180fc8c67466c817888cc6133fc35dbdad7eb93e6b34ea3132962c548a124",
  "PUBLIC-FUNCTION-PINS.after.json": "672a7f2cd538471a4aa351b9d9363ff93f07afa4bf81fcbbd0f49cbd055716da",
  "FUNCTION-PINS.json": "57746b731f0d7b516c8f3a244ff60bb537c97d980d1d3cad66935ef20dd2f63b",
  "files/tools/listmonk-regular-build/overlay/listmonk/cmd/manager_store_regular.go": "93993d366d94d5b2855295e51894b98263f3d49a18cab9f035e7146d3366bd5d"
});
const PURPOSE='crm.fish174.permanent-exclusion-and-fish-resume';
const HELD='0d8c77b2-18e7-474f-b9b7-bbfc733bac2f';
const FIXED=Object.freeze({runtimeSha256:'4cd321fbdfd9a163f7c5ea2e1ba71029140e00a468d421908de8d0211d1e42cb',querySha256:'772efe8e05331fb201ed24cb08bb97a4625a49811d96622c2148342ce54c6700',kernelSha256:'7d9e4cd7fd4e3c6f9967386c5ca7b1410e755690fac3a77149d8d032d2c4e8b4'});
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
function fail(c){throw Object.assign(new Error(c),{code:c});}
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v)&&v!=='00000000-0000-0000-0000-000000000000';
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function keys(v,n){if(!v||Array.isArray(v)||Object.getPrototypeOf(v)!==Object.prototype||Object.keys(v).sort().join('|')!==[...n].sort().join('|'))fail('PERMANENT_EXCLUSION_INPUT_REFUSED');}
function load(n){let b;try{const p=path.join(__dirname,n);if(fs.lstatSync(p).isSymbolicLink())fail('PERMANENT_EXCLUSION_SOURCE_DRIFT');b=fs.readFileSync(p);}catch{fail('PERMANENT_EXCLUSION_SOURCE_DRIFT');}if(sha(b)!==ASSETS[n])fail('PERMANENT_EXCLUSION_SOURCE_DRIFT');return b.toString('utf8');}
function one(s,a,b){if(s.split(a).length!==2)fail('PERMANENT_EXCLUSION_ANCHOR_REFUSED');return s.replace(a,()=>b);}
function frozen(v){if(v&&typeof v==='object'){Object.values(v).forEach(frozen);Object.freeze(v);}return v;}
const lit=v=>"'"+JSON.stringify(v).replaceAll("'","''")+"'";
function prepare(input){
 keys(input,['stage','campaignId','operationId','candidate','privateReferences']);
 if(!['install','dispose','resume'].includes(input.stage)||![171,174].includes(input.campaignId)||input.stage!=='resume'&&input.campaignId!==174||!uuid(input.operationId))fail('PERMANENT_EXCLUSION_SCOPE_REFUSED');
 keys(input.candidate,['workerSha256','runtimeSha256','querySha256','kernelSha256','imageSha256']);
 for(const[n,h]of Object.entries(FIXED))if(input.candidate[n]!==h)fail('PERMANENT_EXCLUSION_IDENTITY_REFUSED');
 if(!hash(input.candidate.workerSha256)||!hash(input.candidate.imageSha256))fail('PERMANENT_EXCLUSION_IDENTITY_REFUSED');
 if(input.stage==='resume'&&input.candidate.workerSha256==='4abc9b3bac58ede5a922479ba703486248ca5218a84e263a03af56a47e0860bb')fail('PERMANENT_EXCLUSION_OLD_BINARY_REFUSED');
 keys(input.privateReferences,['admission','snapshot','quiescence','binding','disposition','identity']);
 for(const v of Object.values(input.privateReferences)){keys(v,['reference','sha256']);if(!uuid(v.reference)||!hash(v.sha256))fail('PERMANENT_EXCLUSION_REFERENCE_REFUSED');}
 const plan={schema:'fish-permanent-exclusion-plan-v1',purpose:PURPOSE,stage:input.stage,campaignId:input.campaignId,operationId:input.operationId,candidate:{...input.candidate},privateReferences:structuredClone(input.privateReferences),scope:{heldCampaignId:174,heldDispatchId:HELD,decision:'permanent_no_resend'},sourcePins:{...ASSETS},statementTimeoutMs:5000,lockTimeoutMs:500,originalExecutionAvailable:false};
 const before=load(input.stage==='install'?'sql/snapshot.before-install.sql':'sql/snapshot.private-read.sql').trim();
 const after=load('sql/snapshot.private-read.sql').trim();
 if(!before.endsWith(';')||!after.endsWith(';'))fail('PERMANENT_EXCLUSION_SOURCE_DRIFT');
 let core=load('sql/OPERATION.atomic.sql.in');core=one(core,'__PLAN__',lit(plan));core=one(core,'__PINS__',lit(JSON.parse(load(input.stage==='install'?'PUBLIC-FUNCTION-PINS.before.json':'PUBLIC-FUNCTION-PINS.after.json'))));
 core=one(core,'__BEFORE_SNAPSHOT__',before.slice(0,-1));core=one(core,'__AFTER_SNAPSHOT__',after.slice(0,-1));
 core=one(core,'__FIXED_STAGE__',load('sql/'+input.stage+'.stage.sql'));
 let post=load('sql/'+input.stage+'.post.sql');if(input.stage==='install')post=one(post,'__AFTER_PINS__',lit(JSON.parse(load('PUBLIC-FUNCTION-PINS.after.json')))+'::jsonb');
 core=one(core,'__FIXED_POSTCHECK__',post);
 if(/__[A-Z_]+__/.test(core))fail('PERMANENT_EXCLUSION_ANCHOR_REFUSED');
 return frozen({schema:'fish-permanent-exclusion-prepared-v1',plan,planSha256:sha(JSON.stringify(plan)),atomicSha256:sha(core),sourcePins:{...ASSETS},snapshotReadSQL:before,postSnapshotReadSQL:after,statements:['BEGIN ISOLATION LEVEL READ COMMITTED;',"SET LOCAL statement_timeout='5s';","SET LOCAL lock_timeout='500ms';","SET LOCAL idle_in_transaction_session_timeout='10s';","SET LOCAL search_path=pg_catalog;","SELECT pg_catalog.set_config('shrigma.private_permanent_exclusion_envelope',$1::text,true) IS NOT NULL AS private_envelope_bound;",core,"SELECT pg_catalog.set_config('shrigma.private_permanent_exclusion_envelope','',true) IS NOT NULL AS private_envelope_cleared;",'COMMIT;'],executeOriginalAvailable:false,authorizesProcessing:false,operational:false});
}
function executeOriginal(){fail('PERMANENT_EXCLUSION_ORIGINAL_EXECUTION_NOT_ADMITTED');}
module.exports=Object.freeze({prepare,executeOriginal,ASSETS,FIXED,HELD,PURPOSE});
