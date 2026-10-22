'use strict';
// Prospective accepted form requests; deliberately separate from historical origin.
const A=require('./segment-audience-contract.js'),H=require('./segment-audience-review.cjs');
const FIELD='signup.recorded_origin';
const SEMANTICS=Object.freeze({contract:'crm-recorded-origin-exists-v1',identity:'native subscriber id and UUID',positive:'accepted form receipt in the pinned producer scope since coverage_started_at',negative:'no receipt in this exact scope; no assertion about historical signup origin',consent:'native consent is always rechecked at selection'});
function sourceHash(brand){return brand==='aristo'?H.digest({semantics:SEMANTICS,brand,field:FIELD}):null;}
function provenance(origin){return H.digest({contract:SEMANTICS.contract,brand:origin.brand,origin:origin.key,scope_id:origin.scope_id,producer_id:origin.producer_id,producer_revision:origin.producer_revision,coverage_started_at:origin.coverage_started_at});}
function validOrigins(rows,brand){return A.recordedOriginsValid(rows,brand)&&rows.every(o=>o.provenance_hash===provenance(o));}
function sourceReady(brand,value,catalog){
 if(!validOrigins(catalog?.recorded_origins??[],brand))return false;
 const f=catalog?.fields?.filter(x=>x?.key===FIELD),o=catalog?.recorded_origins?.filter(x=>x?.key===value);
 return brand==='aristo'&&f?.length===1&&f[0].available===true&&f[0].source_hash===sourceHash(brand)&&o?.length===1&&o[0].available===true;
}
module.exports={FIELD,SEMANTICS,sourceHash,provenance,validOrigins,sourceReady};
