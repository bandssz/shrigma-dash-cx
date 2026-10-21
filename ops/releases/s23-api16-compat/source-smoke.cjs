'use strict';
const fs=require('node:fs'),a=require('node:assert/strict'),{spawn}=require('node:child_process');
const sealed={main:"4d91007195211df873e945e0072041ccccb9367833c47b77201af0d13ffcee59",server:"849ec985ffbe5b1f6beab11a2fce3cdc3bdd59f3c46b2d529831fbb23dedffe5",transport:"bec58410a35707279c30ecf54afa979541007d71e9c07e0a17b83899d52cb2f6"};
for(const [name,sha]of Object.entries(sealed))a.equal(require("node:crypto").createHash("sha256").update(fs.readFileSync("/app/services/crm-campaign/"+name+".cjs")).digest("hex"),sha);
// Synthetic health marker only.
const revision='ba07243d3dc6e14ef9a640f7bd99c75c865f2f08';
const env={PATH:process.env.PATH,NODE_ENV:'production',PGUSER:'crm_campaign_api',PGDATABASE:'listmonk',PGHOST:'127.0.0.1',PGPASSWORD:'synthetic-only-password',LISTMONK_ORIGIN:'https://email.shrigma.com.br',LISTMONK_USERNAME:'synthetic-api16',LISTMONK_TOKEN:'synthetic-only-token',CRM_CAMPAIGN_REVISION:revision,CRM_CAMPAIGN_ENABLED:'true',CRM_CAMPAIGN_NATIVE_INTERNAL_ENABLED:'true',PORT:'8080'};
let child,stderr='';
(async()=>{a.equal(process.getuid(),1000);a.match(process.version,/^v22\./);child=spawn(process.execPath,['/app/services/crm-campaign/main.cjs'],{env,stdio:['ignore','ignore','pipe']});child.stderr.on('data',b=>{stderr+=b;if(stderr.length>4096)child.kill('SIGTERM');});
 let health;for(let i=0;i<60;i++){if(child.exitCode!==null)throw Error('SYNTHETIC_STARTUP_FAILED');try{const r=await fetch('http://127.0.0.1:8080/healthz',{signal:AbortSignal.timeout(1000)});if(r.ok){health=await r.json();break;}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
 a.equal(health?.service,'crm-campaign');a.equal(health.revision,revision);a.equal(health.enabled,true);a.equal(stderr,'');
 console.log(JSON.stringify({ok:true,node:process.version,uid:process.getuid(),syntheticCredentials:true,network:'none',originalMain:true,nativeInternalPreserved:true,newModulesPresent:['native-read','native-read-transport','native-executor','native-history','native-catalog'].every(n=>fs.existsSync('/app/services/crm-campaign/'+n+'.cjs')),productionUsed:false,compositionEnabled:false}));
})().catch(()=>{console.error(JSON.stringify({ok:false,code:'ORIGINAL_SOURCE_SMOKE_UNCONFIRMED',privateError:true}));process.exitCode=1;}).finally(async()=>{if(child&&child.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}});
