'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {ORIGINAL,RECONCILED,patchCode,patchWorkflow}=require('../n8n/tiktok/canal-reconciliation-patch.cjs');
const current=fs.readFileSync(path.join(__dirname,'../n8n/tiktok/api_sql.js'),'utf8');
const before=patchCode(current,{remove:true});
test('canonical API source contains exact reconciliation block and reversible patch only changes that block',()=>{
 assert.equal(patchCode(before),current);assert.equal(patchCode(current),current);assert.equal(patchCode(before,{remove:true}),before);
 assert.equal(current.replace(RECONCILED,''),before.replace(ORIGINAL,''));
});
test('fresh workflow patch preserves every other node, connection, setting and version',()=>{
 const fresh={versionId:'fresh-1',active:true,name:'fixture',nodes:[{name:'Monta SQL',type:'n8n-nodes-base.code',parameters:{jsCode:before,mode:'runOnceForAllItems'},id:'sql'},{name:'Autorizado?',parameters:{conditions:['fixture']}}],connections:{sql:['next']},settings:{timezone:'America/Sao_Paulo'},activeVersion:{versionId:'fresh-1'}};
 const snapshot=structuredClone(fresh),out=patchWorkflow(fresh,{expectedVersion:'fresh-1'});
 assert.deepEqual(fresh,snapshot);assert.deepEqual(out.changes,[{node:'Monta SQL',field:'jsCode'}]);
 const expected=structuredClone(fresh);expected.nodes[0].parameters.jsCode=current;assert.deepEqual(out.workflow,expected);
 assert.deepEqual(patchWorkflow(out.workflow).changes,[]);assert.deepEqual(patchWorkflow(out.workflow,{remove:true}).workflow,fresh);
});
test('drift, ambiguous anchors and stale versions fail closed',()=>{
 assert.throws(()=>patchCode(before.replace('v.gmv_proprio,','v.other_field,')),/divergiram/);
 assert.throws(()=>patchCode(before+ORIGINAL),/divergiram/);
 assert.throws(()=>patchWorkflow({nodes:[]}),/versionId/);
 assert.throws(()=>patchWorkflow({versionId:'new',nodes:[]},{expectedVersion:'old'}),/mudou/);
 assert.throws(()=>patchWorkflow({versionId:'new',nodes:[]}),/exatamente/);
 assert.throws(()=>patchWorkflow({versionId:'new',nodes:[{name:'Monta SQL'},{name:'Monta SQL'}]}),/exatamente/);
});

test('actual node source honors the same requested window before and after reconciliation',()=>{
 const sql=code=>new vm.Script('(function(){'+code+'})()').runInNewContext({$json:{body:{ini:'2026-09-01',fim:'2026-09-02'}}})[0].json.sql;
 const oldQuery=sql(before),newQuery=sql(current);
 assert.ok(oldQuery.includes("SELECT '2026-09-01'::date AS ini, '2026-09-02'::date AS fim"));
 assert.equal(newQuery.replace(RECONCILED,''),oldQuery.replace(ORIGINAL,''));
});
