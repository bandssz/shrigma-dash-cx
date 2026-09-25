'use strict';
// Apply to a fresh export only. The live header auth, role query, credentials,
// routes, CORS and retention are intentionally outside this patch.
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const sha=s=>createHash('sha256').update(s).digest('hex');
const PREVIOUS_BUNDLE_SHA='c6f4e3f8e9d8013bcfdbf5bfe76d52364c4909d881e1dd2b3bcf125f71301f38';
const GUARDS={Entrada:'3ad42c501371e5e24547808f321ea1c5be2e1162d97314b40906857d0a9271a4',Despacha:'a680bcf3ab8dd3821bb6556fd1a1a6e103796f00656e57f188354b08a4693330','Recibo erro PG':'3a6827fecafac115a845089eee29394481a364e20af694a31d990818b23f4b17'};
const WRAPPERS={Iniciar:['\nconst verified=','0364a2fe60f0516d54374b4eac6b3757ab9aed681d2e7c6643ad14af767142e5'],Retomar:['\nconst source=','cd5f3d290fd4921191af6c02b1b152c6459dc7e195bb39fef84fa9cf494106cd']};
const OLD_FIELDS="const allowed=['k','acao','brand','id','definition','expected_version','idempotency_key','confirm','audience_review_id'];";
const OLD_ACTIONS='provider=["catalog","list","get","update","schedule","cancel","review"]';
const OLD_ERRORS='known=["AUDIENCE_REVIEW_REQUIRED"';
const ERRORS=['RECOVERY_UNAVAILABLE','RECOVERY_ALREADY_CLAIMED','RECOVERY_INVALID'];
function replaceOnce(s,from,to){if(s.split(from).length!==2)throw Error('CAMPAIGN_PATCH_ANCHOR_CHANGED');return s.replace(from,to);}
function patchWorkflow(fresh,{expectedVersionId}={}){
 if(fresh?.id!=='tHER2Ecq2VHcBHOQ'||!expectedVersionId||fresh.versionId!==expectedVersionId||fresh.activeVersionId!==expectedVersionId||!Array.isArray(fresh.nodes))throw Error('CAMPAIGN_PATCH_VERSION_CHANGED');
 const workflow=JSON.parse(JSON.stringify(fresh)),changes=[];
 const get=name=>{const a=workflow.nodes.filter(n=>n.name===name&&n.type==='n8n-nodes-base.code');if(a.length!==1||typeof a[0].parameters?.jsCode!=='string')throw Error('CAMPAIGN_PATCH_NODE_CHANGED');return a[0];};
 const put=(name,code)=>{get(name).parameters.jsCode=code;changes.push({node:name,field:'parameters.jsCode'});};
 for(const [name,hash] of Object.entries(GUARDS))if(sha(get(name).parameters.jsCode)!==hash)throw Error('CAMPAIGN_PATCH_SOURCE_CHANGED');
 const bundle=fs.readFileSync(path.join(__dirname,'campaign-runtime.bundle.js'),'utf8');
 if(!bundle.includes('source_operation_id')||sha(bundle)===PREVIOUS_BUNDLE_SHA)throw Error('CAMPAIGN_PATCH_BUNDLE_UNAVAILABLE');
 for(const [name,[marker,hash]] of Object.entries(WRAPPERS)){
  const code=get(name).parameters.jsCode,index=code.indexOf(marker);
  if(index<0||sha(code.slice(0,index))!==PREVIOUS_BUNDLE_SHA||sha(code.slice(index))!==hash)throw Error('CAMPAIGN_PATCH_BUNDLE_OR_WRAPPER_CHANGED');
  put(name,bundle+code.slice(index));
 }
 let entry=replaceOnce(get('Entrada').parameters.jsCode,OLD_FIELDS,OLD_FIELDS.replace("'audience_review_id'","'audience_review_id','source_operation_id'"));
 entry=replaceOnce(entry,"'campanha_agendar','campanha_cancelar']","'campanha_agendar','campanha_cancelar','campanha_recuperar']");put('Entrada',entry);
 put('Despacha',replaceOnce(get('Despacha').parameters.jsCode,OLD_ACTIONS,OLD_ACTIONS.replace('"review"','"review","recovery_inspect","recover"')));
 put('Recibo erro PG',replaceOnce(get('Recibo erro PG').parameters.jsCode,OLD_ERRORS,'known=['+ERRORS.map(s=>JSON.stringify(s)).join(',')+',"AUDIENCE_REVIEW_REQUIRED"'));
 return {workflow,changes,previousBundleSha256:PREVIOUS_BUNDLE_SHA,bundleSha256:sha(bundle)};
}
module.exports={patchWorkflow,PREVIOUS_BUNDLE_SHA};
