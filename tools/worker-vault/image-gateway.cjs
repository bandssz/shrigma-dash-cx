'use strict';
// Isolated image proof only: no production volume, network, or credential.
const fs=require('node:fs'),crypto=require('node:crypto'),http=require('node:http'),{spawn}=require('node:child_process'),a=require('node:assert/strict');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex'),host='gerencial.shrigma.com.br',origin='https://'+host,token=crypto.randomBytes(24).toString('base64url'),password=crypto.randomBytes(32).toString('base64url');
const m=JSON.parse(fs.readFileSync('/app/native-backend/manifest.json')),manifest=sha(fs.readFileSync('/app/native-backend/manifest.json'));
Object.assign(process.env,{SHRIGMA_PROCESS_ROLE:'api',DASHBOARD_SHOPIFY_PAID_FACTS_FILE:'/run/secrets/crm-shopify-paid-facts.json',DASHBOARD_SIMPLE_READ_LOGIN:'enabled',DASHBOARD_MODE:'operational',DASHBOARD_UPSTREAM_PROFILE:'production',DASHBOARD_MANAGER_HOST:host,DASHBOARD_AREA_HOSTS:JSON.stringify({growth:'crm.shrigma.com.br',organico:'organico.shrigma.com.br',influs:'influs.shrigma.com.br'}),DASHBOARD_EMAIL_DOMAINS:'["oaristocrata.com","shrigma.com.br","fishermans.com.br"]',DASHBOARD_ADMIN_EMAIL:'felipebandeira@oaristocrata.com',DASHBOARD_BOOTSTRAP_SHA256:sha(token),DASHBOARD_ENCRYPTION_KEY:crypto.randomBytes(32).toString('hex'),DASHBOARD_UPSTREAMS:'{}',DASHBOARD_UPSTREAM_HOSTS:'[]',HOST:'127.0.0.1',PORT:'8080'});
fs.writeFileSync('/dashboard-data/runtime-pack.json',fs.readFileSync('/app/runtime-pack.json'),{flag:'wx',mode:0o600});
const api=spawn(process.execPath,['--no-warnings','/app/prepared-worker/command.cjs','api'],{env:{...process.env},stdio:['ignore','pipe','pipe']});
api.stdout.on('data',()=>{});api.stderr.on('data',()=>{});
let stopping=false,stage='starting',responseStatus;
async function stop(code){if(stopping)return;stopping=true;api.kill('SIGTERM');await new Promise(r=>api.exitCode===null?api.once('close',r):r());process.exitCode=code||api.exitCode||0;}
process.once('SIGTERM',()=>stop(0));process.once('SIGINT',()=>stop(0));
function request(url,{method='GET',body,cookie,csrf}={}){return new Promise((resolve,reject)=>{const q=http.request({host:'127.0.0.1',port:8080,path:url,method,agent:false,headers:{Host:host,Origin:origin,Accept:'application/json',...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{})}},r=>{let s='';r.on('data',c=>s+=c);r.on('end',()=>{let value;try{value=JSON.parse(s);}catch{value=null;}responseStatus=r.statusCode;resolve({status:r.statusCode,value,cookie:r.headers['set-cookie']?.[0]});});});q.on('error',reject);q.setTimeout(15000,()=>q.destroy(Error('timeout')));q.end(body?JSON.stringify(body):undefined);});}
(async()=>{
 let healthy=false;for(let n=0;n<100;n++){if(api.exitCode!==null)throw Error('API_EXIT');try{healthy=(await request('/healthz')).status===200;}catch{}if(healthy)break;await new Promise(r=>setTimeout(r,100));}a.equal(healthy,true);
 stage='wa-profile-route';const deniedWa=await request('/api/whatsapp-campaigns?brand=invalid');a.equal(deniedWa.status,403);
 stage='before-owner';const cli=require('/app/native-backend/runtime/native-worker-vault-cli.cjs'),dbPath=require('/app/bootstrap.cjs').DB_FILE;
 await a.rejects(cli.request(dbPath,{action:'status'}),/WV_ORIGINAL_OWNER/);
 stage='bootstrap-owner';a.equal((await request('/auth/bootstrap/complete',{method:'POST',body:{email:process.env.DASHBOARD_ADMIN_EMAIL,token,password}})).status,200);
 stage='login';const login=await request('/auth/login',{method:'POST',body:{email:process.env.DASHBOARD_ADMIN_EMAIL,password}});a.equal(login.status,200);
 const cookie=login.cookie.split(';')[0],csrf=login.value.csrf;
 const {PATH}=require('/app/native-backend/runtime/native-whatsapp-operator.cjs'),{ORIGINAL}=require('/app/native-backend/runtime/native-whatsapp-connection.cjs');
 stage='legacy-meta';for(const brand of['aristo','fish'])a.equal((await request(PATH,{method:'POST',cookie,csrf,body:{action:'bind-original-read',brand,token:'SYNTHETIC_META_TOKEN_NEVER_REAL_123456',original:ORIGINAL,expectedRevision:0}})).status,200);
 stage='legacy-pg';a.equal((await request('/auth/native-database-settings',{method:'POST',cookie,csrf,body:{action:'bind',username:'synthetic_pg_owner',password:'Synthetic-PG-Only-Password-2026!',privateNetwork:true}})).status,200);
 const status=await cli.request(dbPath,{action:'status'});a.equal(status.manifest,manifest);a.equal(status.linked,false);
 fs.writeFileSync('/tmp/c15-image-ready.json',JSON.stringify({manifest,revision:m.sourceRevision,ready:true})+'\n',{mode:0o600,flag:'wx'});
 console.log(JSON.stringify({ready:true,syntheticIdentity:true}));
})().catch(e=>{console.error(JSON.stringify({ok:false,stage,responseStatus,actualStatus:Number.isFinite(e.actual)?e.actual:undefined,errorCode:['ECONNRESET','ECONNREFUSED','ERR_ASSERTION'].includes(e.code)?e.code:undefined,code:'C15_ISOLATED_API_PROOF_FAILED'}));stop(1);});
