'use strict';
// Root-only isolated PG17 fixture. No client factory, connection ownership, DDL,
// cleanup, credentials, query wrapper or synthetic SQL engine. OFF by default.
// Root installs the existing namespace + schema-v1.sql in its isolated fixture,
// lends two dedicated already connected raw clients, and attests their custody.
// The identities, verifiers and clock in fixtures.cjs are TEST DATA ONLY.
const assert=require('node:assert/strict');
const Store=require('../../../services/dashboard-operational/domain/crm-mvp-controls-persistence/facts/store.cjs');
async function run({enabled=false,clients,admitIsolatedClients,withDomainSessions}={}){
 if(enabled!==true||!Array.isArray(clients)||clients.length!==2||clients[0]===clients[1]||clients.some(c=>!c||typeof c.query!=='function')||typeof admitIsolatedClients!=='function'||!Array.isArray(withDomainSessions)||withDomainSessions.length!==2||withDomainSessions.some(f=>typeof f!=='function'))throw Error('CONTROL_FACTS_PG17_OFF');
 // Private Root admission is mandatory before any SQL or fixture imports.
 const custody=await admitIsolatedClients(clients);
 assert.deepEqual(custody,{isolated:true,existingNamespace:'dashboard_crm_controls',dedicatedClients:true,factsSchemaInstalled:true,production:false});
 const metadata=await Promise.all(clients.map(c=>c.query('SELECT current_setting(\'server_version_num\') AS engine, pg_backend_pid() AS pid')));
 for(const r of metadata){assert.equal(r.command,'SELECT');assert.equal(r.rowCount,1);assert.equal(r.rows.length,1);assert.match(r.rows[0].engine,/^17[0-9]{4}$/);assert(Number.isSafeInteger(r.rows[0].pid));}
 assert.notEqual(metadata[0].rows[0].pid,metadata[1].rows[0].pid);
 const F=require('./fixtures.cjs'),stores=clients.map((c,i)=>Store.create({...F.options(c),withDomainSession:withDomainSessions[i]})),p=await F.prepared(),i=F.batch(p.facts);
 // Fixture must start empty. Never truncate or adapt a previously used schema.
 assert.equal((await stores[0].inspectBatch({brand:i.brand,sourceRef:i.sourceRef,eventRef:i.eventRef})).state,'unknown');
 const first=await stores[0].publish(i);assert.equal(first.durable,true);
 const live=await stores[0].readForEvaluation(p.request,F.decide);assert.equal(live.decision.state,'eligible-for-reservation');assert.equal(live.live.evidence.revision,7);
 assert.deepEqual(await stores[0].publish(i),first);
 assert.equal((await stores[1].readHistorical({brand:'fish',kind:'consent',key:F.C.key('consent',F.consent()),revision:9})).fact.body.consent,'current');
 // Actual trigger enforcement: Root owns the isolated clients and outer cleanup.
 await assert.rejects(clients[0].query('UPDATE dashboard_crm_controls.control_fact_versions_v1 SET body_hash=$1 WHERE brand=$2 AND kind=$3 AND fact_key=$4 AND revision=$5',[F.E,'fish','consent',F.C.key('consent',F.consent()),'9']),e=>e.code==='23514');
 // Two SERIALIZABLE writers, same persisted CAS expectation, no retries.
 const next=(eventRef,consent)=>F.batch([F.fact('consent',F.consent(F.uuid(1),F.H,consent,10),9)],{expectedBrandRevision:7,brandRevision:8,eventRef});
 const raced=await Promise.allSettled([stores[0].publish(next('c'.repeat(64),'current')),stores[1].publish(next('d'.repeat(64),'revoked'))]);
 assert.equal(raced.filter(r=>r.status==='fulfilled').length,1);
 const loser=raced.find(r=>r.status==='rejected').reason;
 assert(loser.code==='CONTROL_FACTS_CAS_REFUSED'||loser.sqlstate==='40001');
 const winner=stores[raced[0].status==='fulfilled'?0:1];
 assert.equal((await winner.readHistorical({brand:'fish',kind:'consent',key:F.C.key('consent',F.consent()),revision:9})).fact.body.consent,'current');
 // A batch with one good expectation and one stale expectation cannot publish.
 const failed=F.batch([F.fact('consent',F.consent(F.uuid(1),F.H,'current',11),10),F.fact('suspension',{suspension:'clear',suspensionRevision:3},1)],{expectedBrandRevision:8,brandRevision:9,eventRef:'e'.repeat(64)});
 await assert.rejects(winner.publish(failed),e=>e.code==='CONTROL_FACTS_CAS_REFUSED');
 assert.equal((await winner.inspectBatch({brand:failed.brand,sourceRef:failed.sourceRef,eventRef:failed.eventRef})).state,'unknown');
 assert.equal((await winner.readHistorical({brand:'fish',kind:'consent',key:F.C.key('consent',F.consent()),revision:11})).state,'unknown');
 // Missing brand/distribution is still unknown, never admitted empty evidence.
 assert.equal((await winner.readHistorical({brand:'aristo',kind:'consent',key:F.C.key('consent',F.consent()),revision:9})).state,'unknown');
 return Object.freeze({executed:true,engine:metadata[0].rows[0].engine,scenarios:4,sourceOnly:true,operational:false,productionAdmitted:false,ownership:'Root',scopes:['native-roundtrip-idempotence-coherent-read','native-immutable-history-trigger','native-two-client-cas','native-rejected-batch-and-brand-isolation']});
}
module.exports=Object.freeze({ENABLED:false,run});
