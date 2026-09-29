'use strict';
const F=require('./ab-audience-prepare-fixture.cjs'),R=require('../n8n/growth/ab-audience-review.cjs'),API=require('../n8n/growth/ab-audience-review-api.cjs');
async function setup(db){
 const x=await F.setup(db);await db.exec(F.read('n8n/growth/ab-audience-review.sql'));
 await db.query("UPDATE shrigma_panel_permission_v1 SET caps='[\"draft\",\"validate\",\"read_content\"]' WHERE principal_id IN('manager','other')");
 const store=R.createAudienceReview({transaction:x.transaction,timeoutMs:10000}),api=API.createAudienceReviewAPI({store});let seq=20000;
 const call=(request,key='synthetic-manager-key')=>api.handle({method:request.acao===R.ACTIONS.review?'POST':'GET',request:{headers:{Authorization:'Bearer '+key},[request.acao===R.ACTIONS.review?'body':'query']:request}});
 const prepared=async(brand='fish',minimum=1)=>{const audience=await x.bindBoth(brand),protocol=await x.protocol(brand,minimum),inspection=await x.inspect(protocol),saved=await x.prepare(protocol,inspection._body.intent);if(saved._http!==201)throw Error('FIXTURE_PREPARE_UNCONFIRMED');return {audience,protocol,saved:saved._body};};
 const request=(p,operation_id=F.uuid(++seq))=>({acao:R.ACTIONS.review,brand:p.protocol.brand,test_id:p.protocol.test_id,expected_version:p.saved.experiment.version,expected_scope_hash:p.saved.scope_hash,operation_id});
 const review=(p,op)=>call(request(p,op));
 const latest=p=>call({acao:R.ACTIONS.get,brand:p.protocol.brand,test_id:p.protocol.test_id});
 const operation=(brand,id,key)=>call({acao:R.ACTIONS.operation,brand,operation_id:id},key);
 const audienceCall=p=>x.api.handle({method:'POST',request:{headers:{Authorization:'Bearer synthetic-manager-key'},body:p}});
 return {...x,audienceCall,reviewStore:store,reviewAPI:api,reviewCall:call,prepared,reviewRequest:request,review,latest,reviewOperation:operation};
}
module.exports={setup,uuid:F.uuid,read:F.read};
