'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{patchWorkflow,POLICY}=require('../n8n/growth/journey-graph-capabilities.cjs');
const endpoint='https://n8n.example.invalid/webhook/synthetic-graph-drafts';
const caps={api_version:'1',write_key_required:true,templates:{draft:true,submit_email:true},campaigns:{save:true,recovery:'keep'},endpoints:{templates:'https://n8n.example.invalid/webhook/synthetic-templates',campaigns:'https://n8n.example.invalid/webhook/synthetic-campaigns'}};
const anchor="'capabilities', (CASE WHEN '{{ $('Busca painel').first().json.efetivo }}' IN ('growth','todos') THEN ";
const query=c=>'SELECT jsonb_build_object(\'cx\',cx_payload,'+anchor+"'"+JSON.stringify(c).replaceAll("'","''")+"'::jsonb ELSE NULL END), 'organico',organic_payload)";
const base=(c=caps)=>({id:'helper',versionId:'version-a',activeVersionId:'version-a',active:true,nodes:[{name:'Consulta payload',parameters:{query:query(c)},credentials:{postgres:{id:'synthetic',name:'Reference'}}},{name:'Other',parameters:{query:'SELECT other_payload'}}],connections:{unchanged:true},settings:{unchanged:true}});
const patch=(w,enabled=true,e=endpoint)=>patchWorkflow(w,{expectedVersionId:'version-a',enabled,endpoint:e});
const read=w=>JSON.parse(w.nodes[0].parameters.query.match(/THEN '((?:[^']|'')+)'::jsonb/)[1].replaceAll("''","'"));
test('announces only the two Growth paths, preserves unrelated contracts and original input, and safely disables',()=>{
 const original=base(),out=patch(original);assert.equal(out.changes.length,1);assert.deepEqual(read(out.workflow),{...caps,endpoints:{...caps.endpoints,journey_graph:endpoint},journeys:{graph_drafts:POLICY}});
 const expected=JSON.parse(JSON.stringify(original));expected.nodes[0].parameters.query=out.workflow.nodes[0].parameters.query;assert.deepEqual(out.workflow,expected);assert.deepEqual(original,base());
 assert.equal(patch(out.workflow).changes.length,0);assert.deepEqual(patch(out.workflow,false).workflow,original);assert.equal(patch(original,false).changes.length,0);
 const withOther=base({...caps,journeys:{legacy:true}});assert.deepEqual(patch(patch(withOther).workflow,false).workflow,withOther);
});
test('refuses stale export, broadened/non-Growth scope, duplicate anchor, malformed contract or endpoint collision',()=>{
 assert.throws(()=>patchWorkflow(base(),{expectedVersionId:'old',enabled:true,endpoint}));assert.throws(()=>patchWorkflow(base(),{expectedVersionId:'version-a',endpoint}));
 for(const change of [q=>q.replace("('growth','todos')","('cx','todos')"),q=>q.replace(' THEN ',' OR true THEN '),q=>q+';'+q]){const w=base();w.nodes[0].parameters.query=change(w.nodes[0].parameters.query);assert.throws(()=>patch(w));}
 for(const c of [{...caps,journeys:[]},{...caps,journeys:{graph_drafts:'other'}},{...caps,endpoints:{...caps.endpoints,journey_graph:endpoint}},{...caps,write_key_required:false}])assert.throws(()=>patch(base(c)));
 const installed=patch(base()).workflow;assert.throws(()=>patch(installed,true,endpoint+'-other'));assert.throws(()=>patch(installed,false,endpoint+'-other'));
 for(const e of ['http://n8n.example.invalid/webhook/graph-drafts',endpoint+'?k=no',endpoint+'#no','https://user:secret@n8n.example.invalid/webhook/graph-drafts','https://n8n.example.invalid/webhook-test/graph-drafts'])assert.throws(()=>patch(base(),true,e));
});
