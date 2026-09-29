'use strict';
const F=require('./ab-audience-material-read-fixture.cjs'),R=require('../n8n/growth/ab-audience-review.cjs'),I=require('../n8n/growth/ab-audience-admission-inspect.cjs'),D=require('../n8n/growth/ab-audience-admission-contract.cjs'),API=require('../n8n/growth/ab-audience-admission-api.cjs');
async function setup(db){
 const x=await F.setup(db);await db.exec(F.read('n8n/growth/ab-audience-review.sql'));
 await db.query("UPDATE shrigma_panel_permission_v1 SET caps='[\"draft\",\"validate\",\"read_content\"]' WHERE principal_id IN('manager','other')");
 const reviewStore=R.createAudienceReview({transaction:x.transaction,timeoutMs:10000}),store=I.createAdmissionInspection({transaction:x.transaction,timeoutMs:10000}),api=API.createAdmissionInspectionAPI({store});let sequence=71000;
 const review=async(p,key='synthetic-manager-key')=>reviewStore.execute({key,request:{acao:R.ACTIONS.review,brand:p.protocol.brand,test_id:p.protocol.test_id,expected_version:p.saved.experiment.version,expected_scope_hash:p.saved.scope_hash,operation_id:F.uuid(++sequence)}});
 const prepared=async(brand='fish',minimum=1)=>{const audience=await x.bindBoth(brand),protocol=await x.protocol(brand,minimum),inspection=await x.inspect(protocol),saved=await x.prepare(protocol,inspection._body.intent);if(saved._http!==201)throw Error('FIXTURE_PREPARE_UNCONFIRMED');const p={audience,protocol,saved:saved._body};const r=await review(p);if(r._http!==201)throw Error('FIXTURE_REVIEW_UNCONFIRMED');return {...p,review:r._body.review};};
 const request=p=>({acao:D.ACTION,brand:p.protocol.brand,test_id:p.protocol.test_id,expected_version:p.saved.experiment.version,expected_scope_hash:p.saved.scope_hash,review_id:p.review.review_id});
 const call=(r,key='synthetic-manager-key',options={})=>api.handle({method:'GET',request:{headers:{Authorization:'Bearer '+key},query:r}},options);
 const inspectAdmission=(p,key,options)=>call(request(p),key,options);
 const audienceCall=p=>x.api.handle({method:'POST',request:{headers:{Authorization:'Bearer synthetic-manager-key'},body:p}});
 const snapshot=async()=>{const rows={};for(const table of ['campaigns','crm_ab_experiment_v2','crm_ab_arm_v2','crm_ab_member_v2','crm_audience_v2.ab_scope','crm_audience_v2.ab_request','crm_audience_v2.ab_review','crm_audience_v2.ab_review_request'])rows[table]=(await db.query('SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),\'[]\'::jsonb) data FROM '+table+' t')).rows[0].data;return rows;};
 return {...x,reviewStore,admissionStore:store,admissionAPI:api,prepared,review,admissionRequest:request,admissionCall:call,inspectAdmission,audienceCall,snapshot};
}
module.exports={setup,read:F.read,uuid:F.uuid};
