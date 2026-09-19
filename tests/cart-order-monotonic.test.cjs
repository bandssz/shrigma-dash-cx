'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {patchOrderResolution}=require('../n8n/growth/cart-order-monotonic-patch.cjs');
const query="UPDATE subscribers s SET attribs=coalesce(s.attribs,'{}') || jsonb_build_object('last_order_at', $4::text) FROM alvo a\n  WHERE s.id = a.id";
const fixture=()=>({id:'fixture',versionId:'fresh-fixture',settings:{unchanged:true},nodes:[{name:'Resolve carrinho (PG)',type:'n8n-nodes-base.postgres',parameters:{query,options:{queryReplacement:'trusted binding'}},credentials:{postgres:{id:'fixture-reference'}}},{name:'Other',parameters:{unchanged:true}}],connections:{unchanged:true}});
test('patch changes only the recognized timestamp assignment and preserves graph/credentials/settings',()=>{
 const source=fixture(),out=patchOrderResolution(source,{expectedVersion:source.versionId});assert.equal(source.nodes[0].parameters.query,query);
 const restored=structuredClone(out);restored.nodes[0].parameters.query=query;assert.deepEqual(restored,source);
 assert.match(out.nodes[0].parameters.query,/CART_ORDER_MONOTONIC_V1/);assert.match(out.nodes[0].parameters.query,/THEN s\.attribs->\$2->>'last_order_at' ELSE \$4::text END/);
});
test('reapplying the exact patch does not change the workflow',()=>{const f=fixture(),a=patchOrderResolution(f,{expectedVersion:f.versionId});assert.deepEqual(patchOrderResolution(a,{expectedVersion:a.versionId}),a);});
test('stale version, missing node and changed SQL stop before mutation',()=>{
 const f=fixture();for(const opt of [{},{expectedVersion:'old'}])assert.throws(()=>patchOrderResolution(f,opt));
 const changed=fixture();changed.nodes[0].parameters.query='SELECT 1';assert.throws(()=>patchOrderResolution(changed,{expectedVersion:changed.versionId}),/drift/);
 const marked=fixture();marked.nodes[0].parameters.query='-- CART_ORDER_MONOTONIC_V1\nSELECT 1';assert.throws(()=>patchOrderResolution(marked,{expectedVersion:marked.versionId}),/drift/);
});
