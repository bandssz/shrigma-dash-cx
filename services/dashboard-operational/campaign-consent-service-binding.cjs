'use strict';
// Original owner credential and source identity, without a synthetic session.
// Reading local custody and verifying the original identity cannot grant caps.
const fail=code=>{throw Object.assign(Error(code),{code});};
function createServiceBinding({local,verify,principal}){
 if(![local,verify,principal].every(f=>typeof f==='function'))throw Error('CONSENT_BINDING_CONFIG');
 return async brand=>{
  if(!['aristo','fish'].includes(brand))fail('CONSENT_BINDING_SCOPE');
  const before=local(brand);let proof;
  try{proof=await verify({bearer:before.credential,owner:before.owner});}catch{fail('CONSENT_IDENTITY_UNCONFIRMED');}
  const after=local(brand);
  if(proof.owner!==before.owner||before.principal!==null&&principal(proof.principalId)!==before.principal||before.snapshot!==after.snapshot||before.credential!==after.credential||before.owner!==after.owner)fail('CONSENT_ACCESS_CHANGED');
  return Object.freeze({credential:after.credential,snapshot:after.snapshot});
 };
}
module.exports={createServiceBinding};
