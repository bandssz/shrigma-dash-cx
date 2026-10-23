'use strict';
const {test}=require('node:test'),a=require('node:assert/strict'),{requireRenderedTest,createDirect}=require((process.env.DASHBOARD_ACCESS_TEST_RUNTIME||require('node:path').resolve(__dirname,'../services/dashboard-operational'))+'/simple-crm-native-internal.cjs');
test('TEST refuses Go control actions in every field, including trim delimiters and comments',()=>{
 for(const field of ['subject','html','text'])for(const control of ['if .Subscriber','range .Items','with .Order','else','end','define "x"','block "x" .','template "x" .','break','continue'])for(const action of ['{{ '+control+' }}','{{- '+control+' -}}','{{ /* before */ '+control+' }}'])a.throws(()=>requireRenderedTest({[field]:action}),e=>e.status===400&&e.code==='CAMPAIGN_TEST_UNRENDERED_CONTROL');
 a.throws(()=>requireRenderedTest({html:'<p>{{ if .Subscriber'}),e=>e.code==='CAMPAIGN_TEST_UNRENDERED_CONTROL');
});
test('native Listmonk outputs and controls mentioned inside Go strings/comments remain opaque',()=>{
 for(const value of ['{{ .Subscriber.FirstName }}','{{ TrackLink "https://example.invalid/if" }}','{{ UnsubscribeURL }}','{{ printf "%s" "{{ if .Order }}" }}','{{ printf `%s` `{{ end }}` }}','{{ /* if .Order }} end */ }}','{{ index .Subscriber.Attribs "range" }}','{{- printf "with" -}}','plain if/range/with/end'])a.doesNotThrow(()=>requireRenderedTest({subject:value,html:value,text:value}));
});
test('the native TEST refuses controls after authorization and before any provider read or write',async()=>{
 for(const brand of ['aristo','fish']){
  let authorizations=0,calls=0;const adapter=createDirect({authorize:()=>{authorizations++;return {permissions:{growth:{edit:true}}};},admitted:()=>true,credentials:{},fetchImpl:async()=>{calls++;a.fail('provider must remain untouched');}});
  await a.rejects(adapter.handle({},'POST',{acao:'campanha_teste',brand,id:700,recipient:'felipebandeira+codex@oaristocrata.com',definition:{html:'{{ if .Order }}paid{{ end }}'}}),e=>e.code==='CAMPAIGN_TEST_UNRENDERED_CONTROL');a.equal(authorizations,1);a.equal(calls,0);
 }
});
test('an unauthorized actor cannot use control validation as a provider or content oracle',async()=>{
 let calls=0;const adapter=createDirect({authorize:()=>{throw Object.assign(Error('PRODUCT_WRITE_DENIED'),{code:'PRODUCT_WRITE_DENIED'});},admitted:()=>true,credentials:{},fetchImpl:async()=>calls++});await a.rejects(adapter.handle({},'POST',{acao:'campanha_teste',brand:'fish',id:700,recipient:'felipebandeira+codex@oaristocrata.com',definition:{html:'{{ if }}'}}),{code:'PRODUCT_WRITE_DENIED'});a.equal(calls,0);
});
