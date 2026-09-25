'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{patchWorkflow,FLAGS}=require('../n8n/growth/campaign-capabilities-patch.cjs');
const endpoint='https://workflow.example.test/webhook/campaign-fixture';
const original={templates:{draft:true,read_content:true},workflows:{editor:true},write_key_required:true,endpoints:{templates:'https://workflow.example.test/webhook/template-fixture'}};
const fixture=()=>({versionId:'fresh',nodes:[{name:'Consulta payload',parameters:{query:"SELECT jsonb_build_object('other',1,'capabilities', (CASE WHEN '{{ scope }}' IN ('growth','todos') THEN '"+JSON.stringify(original)+"'::json ELSE NULL END),'after',2) AS resultado"}},{name:'Other',parameters:{query:'unchanged'}}],connections:{unchanged:true},settings:{unchanged:true}});
test('capability publication preserves the shared SQL arity, scope and every existing contract',()=>{
 const f=fixture(),r=patchWorkflow(f,{expectedVersionId:'fresh',endpoint}),q=r.workflow.nodes[0].parameters.query;
 const c=JSON.parse(q.match(/THEN '(.*?)'::json/)[1]);assert.deepEqual(c.campaigns,FLAGS);assert.equal(c.endpoints.campaigns,endpoint);
 for(const k of ['templates','workflows','write_key_required'])assert.deepEqual(c[k],original[k]);assert.equal(c.endpoints.templates,original.endpoints.templates);
 assert.equal(q.replace(/THEN '.*?'::json/,"THEN 'JSON'::json"),f.nodes[0].parameters.query.replace(/THEN '.*?'::json/,"THEN 'JSON'::json"));
 assert.deepEqual(r.workflow.nodes[1],f.nodes[1]);assert.deepEqual(r.workflow.connections,f.connections);assert.deepEqual(r.workflow.settings,f.settings);
 assert.equal(r.changes.length,1);assert.deepEqual(patchWorkflow(r.workflow,{expectedVersionId:'fresh',endpoint}).changes,[]);
});
test('stale versions, changed scope/contracts and URLs carrying credentials are refused',()=>{
 assert.throws(()=>patchWorkflow(fixture(),{expectedVersionId:'stale',endpoint}));
 for(const endpoint of ['http://workflow.test/webhook/campaign','https://user:password@workflow.test/webhook/campaign','https://workflow.test/webhook/campaign?k=secret'])assert.throws(()=>patchWorkflow(fixture(),{expectedVersionId:'fresh',endpoint}));
 const f=fixture();f.nodes[0].parameters.query=f.nodes[0].parameters.query.replace("'growth','todos'","'cx','todos'");assert.throws(()=>patchWorkflow(f,{expectedVersionId:'fresh',endpoint}));
 const r=patchWorkflow(fixture(),{expectedVersionId:'fresh',endpoint});assert.throws(()=>patchWorkflow(r.workflow,{expectedVersionId:'fresh',endpoint:endpoint+'-different'}));
});
test('cutover upgrades only the exact legacy campaign contract and preserves unrelated capabilities',()=>{
 const f=patchWorkflow(fixture(),{expectedVersionId:'fresh',endpoint}).workflow;
 const old={...FLAGS};delete old.audience_review;
 f.nodes[0].parameters.query=f.nodes[0].parameters.query.replace(JSON.stringify(FLAGS),JSON.stringify(old));
 const r=patchWorkflow(f,{expectedVersionId:'fresh',endpoint});assert.equal(r.changes.length,1);assert.ok(r.workflow.nodes[0].parameters.query.includes('"audience_review":"listmonk-6.1-regular-v1"'));
 const changed=structuredClone(f);changed.nodes[0].parameters.query=changed.nodes[0].parameters.query.replace(JSON.stringify(old),JSON.stringify({...old,schedule:false}));assert.throws(()=>patchWorkflow(changed,{expectedVersionId:'fresh',endpoint}),/contract differs/);
 const unknown=structuredClone(f);unknown.nodes[0].parameters.query=unknown.nodes[0].parameters.query.replace(JSON.stringify(old),JSON.stringify({...old,audience_review:'unrecognized'}));assert.throws(()=>patchWorkflow(unknown,{expectedVersionId:'fresh',endpoint}),/contract differs/);
});
