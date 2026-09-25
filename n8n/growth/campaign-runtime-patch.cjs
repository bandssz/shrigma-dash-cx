'use strict';
// Apply to a fresh export only. The live header auth, role query, credentials,
// routes, CORS and retention are intentionally outside this patch.
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const sha=s=>createHash('sha256').update(s).digest('hex');
const PREVIOUS_BUNDLE_SHA='ee54c2513b8a1cf3b09ef183da4f38ab8b6f69947028f443119d8fd84ac6d5bf';
const GUARDS={Entrada:'212b1b32e05050c90f73678c3cb315a1c80f2cf4fcd3259774228155fc4b191b',Despacha:'a7b27ada605e908399fd4820b27176d472b3288804254efa034937decc51d05a','Recibo erro PG':'a12ea42c36f745a96809a50844d1ee421f401a7a7e0458f78fcda4d4ddeb7cd7'};
const WRAPPERS={Iniciar:['\nconst verified=','0364a2fe60f0516d54374b4eac6b3757ab9aed681d2e7c6643ad14af767142e5'],Retomar:['\nconst source=','cd5f3d290fd4921191af6c02b1b152c6459dc7e195bb39fef84fa9cf494106cd']};
const OLD_FIELDS="const allowed=['k','acao','brand','id','definition','expected_version','idempotency_key','confirm'];";
const OLD_ACTIONS='provider=["catalog","list","get","update","schedule","cancel"]';
const OLD_ERRORS='known=["CAMPAIGN_RECEIPT_MISMATCH"';
const ERRORS=['AUDIENCE_REVIEW_REQUIRED','AUDIENCE_STALE','AUDIENCE_CHANGED','AUDIENCE_EMPTY','AUDIENCE_DISABLED'];
function replaceOnce(s,from,to){if(s.split(from).length!==2)throw Error('CAMPAIGN_PATCH_ANCHOR_CHANGED');return s.replace(from,to);}
function patchWorkflow(fresh,{expectedVersionId}={}){
 if(fresh?.id!=='tHER2Ecq2VHcBHOQ'||!expectedVersionId||fresh.versionId!==expectedVersionId||fresh.activeVersionId!==expectedVersionId||!Array.isArray(fresh.nodes))throw Error('CAMPAIGN_PATCH_VERSION_CHANGED');
 const workflow=JSON.parse(JSON.stringify(fresh)),changes=[];
 const get=name=>{const a=workflow.nodes.filter(n=>n.name===name&&n.type==='n8n-nodes-base.code');if(a.length!==1||typeof a[0].parameters?.jsCode!=='string')throw Error('CAMPAIGN_PATCH_NODE_CHANGED');return a[0];};
 const put=(name,code)=>{get(name).parameters.jsCode=code;changes.push({node:name,field:'parameters.jsCode'});};
 for(const [name,hash] of Object.entries(GUARDS))if(sha(get(name).parameters.jsCode)!==hash)throw Error('CAMPAIGN_PATCH_SOURCE_CHANGED');
 const bundle=fs.readFileSync(path.join(__dirname,'campaign-runtime.bundle.js'),'utf8');
 if(!bundle.includes('audience_review_id')||sha(bundle)===PREVIOUS_BUNDLE_SHA)throw Error('CAMPAIGN_PATCH_BUNDLE_UNAVAILABLE');
 for(const [name,[marker,hash]] of Object.entries(WRAPPERS)){
  const code=get(name).parameters.jsCode,index=code.indexOf(marker);
  if(index<0||sha(code.slice(0,index))!==PREVIOUS_BUNDLE_SHA||sha(code.slice(index))!==hash)throw Error('CAMPAIGN_PATCH_BUNDLE_OR_WRAPPER_CHANGED');
  put(name,bundle+code.slice(index));
 }
 put('Entrada',replaceOnce(get('Entrada').parameters.jsCode,OLD_FIELDS,OLD_FIELDS.replace("'confirm'","'confirm','audience_review_id'")));
 put('Despacha',replaceOnce(get('Despacha').parameters.jsCode,OLD_ACTIONS,OLD_ACTIONS.replace('"cancel"','"cancel","review"')));
 put('Recibo erro PG',replaceOnce(get('Recibo erro PG').parameters.jsCode,OLD_ERRORS,'known=['+ERRORS.map(s=>JSON.stringify(s)).join(',')+',"CAMPAIGN_RECEIPT_MISMATCH"'));
 return {workflow,changes,previousBundleSha256:PREVIOUS_BUNDLE_SHA,bundleSha256:sha(bundle)};
}
module.exports={patchWorkflow,PREVIOUS_BUNDLE_SHA};
