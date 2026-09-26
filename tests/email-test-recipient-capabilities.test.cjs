'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{patchWorkflow,POLICY}=require('../n8n/growth/email-test-recipient-capabilities.cjs');
const caps={api_version:'1',write_key_required:true,templates:{draft:true,submit_email:true},campaigns:{save:true},endpoints:{templates:'https://example.invalid/templates'}};
const fixture=scope=>'SELECT jsonb_build_object(\'cx\',cx_payload,\'capabilities\', (CASE WHEN area IN (\''+scope+'\',\'todos\') THEN \''+JSON.stringify(caps)+"'::jsonb ELSE NULL END), 'organico',organic_payload)";
const base=()=>({versionId:'version-a',nodes:[{name:'Consulta payload',parameters:{query:fixture('growth')}},{name:'Other',parameters:{query:'SELECT other_payload'}}],connections:{unchanged:true},settings:{unchanged:true}});
test('announcement changes only Growth template policy and disabling restores the shared helper exactly',()=>{
 const before=base(),enabled=patchWorkflow(before,{expectedVersionId:'version-a',enabled:true});
 assert.equal(enabled.changes.length,1);assert.ok(enabled.workflow.nodes[0].parameters.query.includes(POLICY));assert.deepEqual(enabled.workflow.nodes[1],before.nodes[1]);assert.deepEqual(enabled.workflow.connections,before.connections);assert.deepEqual(enabled.workflow.settings,before.settings);assert.deepEqual(before,base());
 const removed=patchWorkflow(enabled.workflow,{expectedVersionId:'version-a',enabled:false});assert.deepEqual(removed.workflow,before);
 assert.equal(patchWorkflow(enabled.workflow,{expectedVersionId:'version-a',enabled:true}).changes.length,0);
});
test('stale version, different scope, duplicate anchor or incompatible policy refuses patch',()=>{
 assert.throws(()=>patchWorkflow(base(),{expectedVersionId:'stale',enabled:true}));assert.throws(()=>patchWorkflow(base(),{expectedVersionId:'version-a'}));
 for(const scope of ['cx','organico','influs']){const w=base();w.nodes[0].parameters.query=fixture(scope);assert.throws(()=>patchWorkflow(w,{expectedVersionId:'version-a',enabled:true}));}
 const duplicate=base();duplicate.nodes[0].parameters.query+=';'+fixture('growth');assert.throws(()=>patchWorkflow(duplicate,{expectedVersionId:'version-a',enabled:true}));
 const changed=patchWorkflow(base(),{expectedVersionId:'version-a',enabled:true}).workflow;changed.nodes[0].parameters.query=changed.nodes[0].parameters.query.replace(POLICY,'different-policy');assert.throws(()=>patchWorkflow(changed,{expectedVersionId:'version-a',enabled:false}));
});
