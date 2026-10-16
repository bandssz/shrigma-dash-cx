'use strict';
// Immutable HTML sidecars. Caller owns the SAME transaction as the TEST job
// and compatibility marker. This module never starts transport or enrolls users.
const {createHash}=require('node:crypto');
const CONTRACT='journey-html-test-v1',PIECE=/^d_piece_[a-f0-9]{32}$/;
const sha=s=>createHash('sha256').update(s).digest('hex');
const hash=x=>sha(JSON.stringify(x));
const fail=code=>{throw Object.assign(Error(code),{code,status:409});};
const exact=(o,keys)=>!!o&&Object.getPrototypeOf(o)===Object.prototype&&Object.keys(o).sort().join(',')===keys.sort().join(',');
const noTokens=s=>typeof s==='string'&&!s.includes('{{')&&!s.includes('\0');
function createSnapshots({db,getModelPiece}={}){
 if(!db?.prepare||!db.exec||typeof getModelPiece!=='function')fail('TEST_HTML_SNAPSHOT_CONFIG');
 db.exec('CREATE TABLE IF NOT EXISTS journey_internal_html_snapshot_v1(request_id TEXT NOT NULL REFERENCES journey_internal_test_v1(request_id),step_id TEXT NOT NULL,ordinal INTEGER NOT NULL,payload_json TEXT NOT NULL,payload_sha256 TEXT NOT NULL,PRIMARY KEY(request_id,step_id),UNIQUE(request_id,ordinal))');
 function prepare(context,{brand,draft,models}){
  const enabled=draft.steps.filter(s=>s.enabled);
  if(!Array.isArray(models)||!enabled.length||enabled.length>20||models.length!==enabled.length||models.some(m=>!exact(m,['stepId','pieceId','version'])||typeof m.stepId!=='string'||!PIECE.test(m.pieceId||'')||!Number.isSafeInteger(m.version)||m.version<1)||new Set(models.map(m=>m.stepId)).size!==models.length)fail('TEST_HTML_MODELS_REQUIRED');
  const snapshots=enabled.map(step=>{
   const ref=models.find(m=>m.stepId===step.id);if(!ref||step.channel!=='email')fail('TEST_HTML_MODELS_REQUIRED');
   const p=getModelPiece(context,brand,ref.pieceId,ref.version);
   if(!p||p.id!==ref.pieceId||p.brand!==brand||p.version!==ref.version||!noTokens(p.html)||!p.html.trim()||Buffer.byteLength(p.html)>200000||!noTokens(p.subject)||!noTokens(step.subject)||!step.subject.startsWith('[TESTE] ')||step.subject.length>220||/[\r\n]/.test(step.subject)||!noTokens(step.text)||!step.text.trim()||step.text.length>5000)fail('TEST_HTML_MODEL_CONTENT_REFUSED');
   return {contract:CONTRACT,brand,draftId:draft.id,draftRevision:draft.revision,draftSha256:hash(draft),stepId:step.id,pieceId:p.id,pieceVersion:p.version,modelSubject:p.subject,subject:step.subject,text:step.text,textOrigin:'journey-step',html:p.html,htmlSha256:sha(p.html),textSha256:sha(step.text)};
  });
  if(snapshots.some(p=>Buffer.byteLength(JSON.stringify(p))>250000)||Buffer.byteLength(JSON.stringify(snapshots))>1000000)fail('TEST_HTML_MODELS_TOO_LARGE');
  return snapshots;
 }
 function append(requestId,snapshots){
  if(!db.isTransaction)fail('TEST_HTML_TRANSACTION_REQUIRED');
  const put=db.prepare('INSERT INTO journey_internal_html_snapshot_v1 VALUES(?,?,?,?,?)');
  snapshots.forEach((p,i)=>{const text=JSON.stringify(p);put.run(requestId,p.stepId,i,text,sha(text));});
 }
 function read(requestId,draft){
  const enabled=draft.steps.filter(s=>s.enabled),rows=db.prepare('SELECT * FROM journey_internal_html_snapshot_v1 WHERE request_id=? ORDER BY ordinal').all(requestId);
  if(!enabled.length||rows.length!==enabled.length||rows.length>20)fail('TEST_HTML_SNAPSHOT_INVALID');
  return rows.map((r,i)=>{
   if(r.ordinal!==i||typeof r.payload_json!=='string'||Buffer.byteLength(r.payload_json)>250000||sha(r.payload_json)!==r.payload_sha256)fail('TEST_HTML_SNAPSHOT_INVALID');
   let p;try{p=JSON.parse(r.payload_json);}catch{fail('TEST_HTML_SNAPSHOT_INVALID');}
   const step=enabled[i];
   if(!exact(p,['contract','brand','draftId','draftRevision','draftSha256','stepId','pieceId','pieceVersion','modelSubject','subject','text','textOrigin','html','htmlSha256','textSha256'])||p.contract!==CONTRACT||p.brand!==draft.brand||p.draftId!==draft.id||p.draftRevision!==draft.revision||p.draftSha256!==hash(draft)||p.stepId!==step.id||r.step_id!==step.id||!PIECE.test(p.pieceId||'')||!Number.isSafeInteger(p.pieceVersion)||p.pieceVersion<1||p.subject!==step.subject||p.text!==step.text||p.textOrigin!=='journey-step'||!noTokens(p.html)||!p.html.trim()||Buffer.byteLength(p.html)>200000||sha(p.html)!==p.htmlSha256||!noTokens(p.text)||sha(p.text)!==p.textSha256||!noTokens(p.subject)||!noTokens(p.modelSubject))fail('TEST_HTML_SNAPSHOT_INVALID');
   return p;
  });
 }
 const references=snapshots=>snapshots.map(p=>({stepId:p.stepId,pieceId:p.pieceId,version:p.pieceVersion}));
 return Object.freeze({prepare,append,read,references});
}
module.exports={createSnapshots,CONTRACT,hash};
