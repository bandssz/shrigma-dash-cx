'use strict';
const a=require('node:assert/strict');
const MINIMUM=600000,WINDOW=30000;
async function awaitWindow({read,now=Date.now,wait=ms=>new Promise(r=>setTimeout(r,ms)),timeoutMs=1800000,revision,onPhase=()=>{}}){
 a.match(revision||'',/^[a-f0-9]{40}$/);const end=now()+timeoutMs;let first=null,planned=null;onPhase('waiting-for-maintenance-notice');
 while(now()<end){
  const rows=await read();a.equal(rows.length,2);const stamp=now();
  for(const r of rows){a.equal(typeof r.active,'boolean');a(Math.abs(Date.parse(r.serverTime)-stamp)<=30000,'MAINTENANCE_CLOCK_UNCONFIRMED');}
  if(rows.every(r=>r.active)){
   const restart=Date.parse(rows[0].restartAt),expires=Date.parse(rows[0].expiresAt);a(Number.isSafeInteger(restart)&&Number.isSafeInteger(expires));a(rows.every(r=>Date.parse(r.restartAt)===restart&&Date.parse(r.expiresAt)===expires),'MAINTENANCE_BRANDS_DIFFER');
   if(first===null){a(restart-stamp>=MINIMUM,'MAINTENANCE_TEN_MINUTES_REQUIRED');a(expires-restart>=180000&&expires-restart<=900000);first=stamp;planned={restart,expires};onPhase('notice-visible-ten-minute-wait',new Date(restart).toISOString());}
   a.equal(restart,planned.restart,'MAINTENANCE_CHANGED');a.equal(expires,planned.expires,'MAINTENANCE_CHANGED');
   if(stamp>=restart){a(stamp-first>=MINIMUM);a(stamp-restart<=WINDOW,'MAINTENANCE_WINDOW_MISSED');const result={schema:'shrigma-maintenance-install-window-v1',ok:true,candidateRevision:revision,brands:2,firstSeenAtUtc:new Date(first).toISOString(),restartAt:new Date(restart).toISOString(),expiresAt:new Date(expires).toISOString(),finishedAtUtc:new Date(stamp).toISOString(),minVisibleMs:stamp-first,businessWrites:0};validateReceipt(result,{revision,now:stamp});return result;}
  }else if(first!==null)throw Error('MAINTENANCE_DISAPPEARED');
  await wait(5000);
 }
 throw Error('MAINTENANCE_NOTICE_TIMEOUT');
}
function validateReceipt(r,{revision,now=Date.now()}){
 a.equal(r?.schema,'shrigma-maintenance-install-window-v1');a.equal(r.ok,true);a.equal(r.candidateRevision,revision);a.equal(r.brands,2);a.equal(r.businessWrites,0);const first=Date.parse(r.firstSeenAtUtc),restart=Date.parse(r.restartAt),expires=Date.parse(r.expiresAt),finished=Date.parse(r.finishedAtUtc);a(Number.isSafeInteger(r.minVisibleMs)&&r.minVisibleMs>=MINIMUM);a.equal(finished-first,r.minVisibleMs);a(finished>=restart&&finished-restart<=WINDOW);a(now>=finished&&now-finished<=WINDOW);a(expires-now>=120000);return true;
}
function validateProgrammedNotice(notice,{revision,window}){
 a.equal(notice?.schema,'shrigma-programmed-maintenance-v1');a.equal(notice.source,'original-owner-maintenance-api-v1');a.equal(notice.saved,true);a.equal(notice.targetRevision,revision);a.equal(notice.audience,'editors');a.equal(notice.restartAt,window.restartAt);a.equal(notice.expiresAt,window.expiresAt);a(Number.isSafeInteger(Date.parse(notice.programmedAtUtc)));a(Date.parse(notice.programmedAtUtc)<=Date.parse(window.firstSeenAtUtc)+30000);return true;
}
async function readProgrammedNotice({revision,window,token,repository,fetchImpl=fetch}){
 a.equal(repository,'bandssz/shrigma-dash-cx');a(typeof token==='string'&&token.length>0);
 const r=await fetchImpl('https://api.github.com/repos/'+repository+'/contents/ops/maintenance-install-window.json?ref=codex%2Fmaintenance-window',{headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},redirect:'error',signal:AbortSignal.timeout(15000)});a.equal(r.status,200);const file=await r.json();a.equal(file.type,'file');a.equal(file.path,'ops/maintenance-install-window.json');a.equal(file.encoding,'base64');a(Number.isSafeInteger(file.size)&&file.size>0&&file.size<=8192);const bytes=Buffer.from(file.content,'base64');a.equal(bytes.length,file.size);a.equal(require('node:crypto').createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex'),file.sha);const notice=JSON.parse(bytes);validateProgrammedNotice(notice,{revision,window});return notice;
}
async function main(){
 const fs=require('node:fs'),bundle=JSON.parse(fs.readFileSync('/run/secrets/qa-accounts','utf8')),account=bundle.accounts.find(x=>x.baseline===true),origin='https://crm.shrigma.com.br';a(account&&account.brands.includes('aristo')&&account.brands.includes('fish'));a(!/^editor-qa-/i.test(account.email));
 const login=await fetch(origin+'/auth/login',{method:'POST',redirect:'error',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email:account.email,password:account.password}),signal:AbortSignal.timeout(15000)});a.equal(login.status,200);const cookie=login.headers.get('set-cookie')?.split(';')[0];a(cookie);const request=async path=>{const r=await fetch(origin+path,{headers:{Cookie:cookie},redirect:'error',signal:AbortSignal.timeout(15000)});a.equal(r.status,200);return r.json();};
 const session=await request('/auth/session');a.equal(session.authenticated,true);a.equal(session.user.email,account.email);a.equal(session.user.role,'manager');a.equal(session.user.permissions.growth.edit,true);
 const read=async()=>{const rows=[];for(const brand of ['aristo','fish'])rows.push(await request('/api/maintenance-notice?'+new URLSearchParams({brand,front:'growth'})));return rows;};
 const result=await awaitWindow({read,revision:process.env.CANDIDATE_REVISION,onPhase:(phase,restartAt)=>console.log(JSON.stringify({phase,...(restartAt?{restartAt}:{})}))});
 const h=await request('/healthz');a.equal(h.nativeBackendManifestSha256,process.env.EXPECT_MANIFEST);fs.writeFileSync('/proof/'+process.env.PROOF_NAME+'-maintenance-window.json',JSON.stringify(result,null,2)+'\n',{mode:0o600,flag:'wx'});console.log(JSON.stringify({ok:true,brands:2,serial:true,businessWrites:0}));
}
if(require.main===module)main().catch(()=>{console.error(JSON.stringify({ok:false,code:'MAINTENANCE_INSTALL_WINDOW_UNCONFIRMED',deployAllowed:false}));process.exitCode=1;});
module.exports={awaitWindow,validateReceipt,validateProgrammedNotice,readProgrammedNotice};
