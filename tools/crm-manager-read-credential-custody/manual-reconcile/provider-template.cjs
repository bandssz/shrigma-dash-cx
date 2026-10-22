'use strict';
// Pinned same-process provider. No I/O, env, key or network on OFF/import.
const CONFIG=Object.freeze({enabled:false});
function refuse(){throw Error('READ_RECONCILE_PROVIDER_REFUSED');}
function exact(v,ks,hidden=[]){if(!v||Object.getPrototypeOf(v)!==Object.prototype||Reflect.ownKeys(v).length!==ks.length)refuse();for(const k of ks){const d=Object.getOwnPropertyDescriptor(v,k);if(!d||!Object.hasOwn(d,'value')||d.enumerable===hidden.includes(k))refuse();}}
function createProviders(c=CONFIG,deps={}){
 exact(c,c?.enabled===true?['enabled','readonlyApproved','coreFile','coreSha256','plan','observationFile','observationSha256','snapshotFile','snapshotSha256','custodyDirectory','privateKeyFile','binding','vectors','postconditionsDirectory']:['enabled']);if(typeof c.enabled!=='boolean')refuse();if(!c.enabled)return Object.freeze({bindScopes:()=>refuse(),admission:()=>refuse(),observeStatus:()=>refuse(),getRetainedVerifier:()=>refuse()});if(c.readonlyApproved!==true)refuse();
 exact(deps,['now','transport'].filter(k=>Object.hasOwn(deps,k)));
 const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');if(typeof c.coreFile!=='string'||path.resolve(c.coreFile)!==c.coreFile||! /^[a-f0-9]{64}$/.test(c.coreSha256))refuse();const core=fs.lstatSync(c.coreFile),bytes=fs.readFileSync(c.coreFile);if(!core.isFile()||core.isSymbolicLink()||core.nlink!==1||core.uid!==process.getuid()||(core.mode&0o7777)!==0o600||crypto.createHash('sha256').update(bytes).digest('hex')!==c.coreSha256)refuse();
 const H=require(c.coreFile),x=H.plans(c.plan),now=deps.now||Date.now;if(typeof now!=='function')refuse();
 exact(c.binding,['schema','planSha256','mode','scopesSha256']);if(c.binding.schema!=='crm-manager-read-driver-scope-binding-v1'||c.binding.mode!=='reconcile'||c.binding.planSha256!==x.reconcile.planSha256||! /^[a-f0-9]{64}$/.test(c.binding.scopesSha256))refuse();
 exact(c.vectors,['queries','mutations']);if(!Array.isArray(c.vectors.queries)||c.vectors.queries.length!==7||!Array.isArray(c.vectors.mutations)||c.vectors.mutations.length!==13||[...c.vectors.queries,...c.vectors.mutations].some(h=>typeof h!=='string'||! /^[a-f0-9]{64}$/.test(h)))refuse();
 const ds=fs.lstatSync(c.postconditionsDirectory);if(path.resolve(c.postconditionsDirectory)!==c.postconditionsDirectory||fs.realpathSync(c.postconditionsDirectory)!==c.postconditionsDirectory||!ds.isDirectory()||ds.isSymbolicLink()||ds.uid!==process.getuid()||(ds.mode&0o7777)!==0o700||fs.readdirSync(c.postconditionsDirectory).length!==0)refuse();
 const readObservation=()=>H.json(H.readPinned(c.observationFile,c.observationSha256,16384));
 // Validate the original observation on construction, but a fresh receipt is
 // produced only at admission, after R has freshly contained the parent.
 const observed=readObservation();x.P.acceptPostcondition(JSON.stringify(observed.projection),x.observer);H.quiescence(observed.priorQuiescence,x.stage);H.quiescence(observed.observerQuiescence,x.observer);
 const reader=x.S.createStatusReader({enabled:true,plan:x.reconcile},deps.transport);let bound=false,next=1,busy=false;
 function bindScopes(q){
  if(bound)refuse();exact(q,['schema','planSha256','mode','scopesSha256','allowedQueries','allowedMutations'],['allowedQueries','allowedMutations']);for(const k of Object.keys(c.binding))if(q[k]!==c.binding[k])refuse();
  for(const[k,hs]of[['allowedQueries',c.vectors.queries],['allowedMutations',c.vectors.mutations]])if(!Array.isArray(q[k])||q[k].length!==hs.length||q[k].some((v,i)=>H.hash(H.canonical(v))!==hs[i]))refuse();
  if(H.hash(H.canonical({queries:q.allowedQueries,mutations:q.allowedMutations}))!==c.binding.scopesSha256)refuse();bound=true;return Object.freeze({...c.binding});
 }
 function getRetainedVerifier(q){exact(q,['schema','planSha256','credentialIntentId']);if(q.schema!=='crm-manager-read-driver-retained-verifier-request-v1'||q.planSha256!==x.reconcile.planSha256||q.credentialIntentId!==x.stage.intent.credentialIntentId)refuse();const key=x.O.loadPrivateKey(c.privateKeyFile);return x.O.openExisting({directory:c.custodyDirectory,intent:x.stage.intent,privateKey:key}).verifier;}
 function admission(q){if(!bound)refuse();exact(q,['schema','planSha256','mode']);if(q.schema!=='crm-manager-read-stage-admission-request-v1'||q.planSha256!==x.reconcile.planSha256||q.mode!=='reconcile')refuse();return H.admission(readObservation(),H.json(H.readPinned(c.snapshotFile,c.snapshotSha256,16384)),x,now());}
 async function observeStatus(q){if(!bound)refuse();if(q?.schema!=='crm-manager-read-public-postcondition-request-v1')return reader.observe(q);if(busy||next>2)refuse();busy=true;try{const projection=x.P.acceptPostcondition(await reader.observe(q),x.reconcile);H.retain(path.join(c.postconditionsDirectory,'public-postcondition-'+next+'.json'),projection);next++;return JSON.stringify(projection);}finally{busy=false;}}
 return Object.freeze({bindScopes,admission,observeStatus,getRetainedVerifier});
}
function buildSource(config){
 const fs=require('node:fs'),vm=require('node:vm'),marker='const CONFIG=Object.freeze({enabled:false});',tail='module.exports=Object.freeze({createProviders,buildSource});',source=fs.readFileSync(__filename,'utf8').trimEnd();if(!source.includes(marker)||!source.endsWith(tail))refuse();const rendered=source.slice(0,-tail.length).replace(marker,'const CONFIG=Object.freeze('+JSON.stringify(config)+');')+'module.exports=Object.freeze({createProviders});\n';new vm.Script(rendered);return rendered;
}
module.exports=Object.freeze({createProviders,buildSource});
