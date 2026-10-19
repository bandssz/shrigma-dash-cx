'use strict';
const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const runtime=process.env.DASHBOARD_ACCESS_TEST_RUNTIME||path.resolve(__dirname,'../services/dashboard-operational'),pins=require('./crm-ui-independent-boundaries.fixture.json');
const read=p=>fs.readFileSync(path.join(runtime,p),'utf8'),sha=v=>crypto.createHash('sha256').update(v).digest('hex');
for(const[p,hash]of Object.entries(pins.unchanged))test('installed751 contract remains unchanged: '+p,()=>a.equal(sha(read(p)),hash));
test('the complete installed campaign form/handlers retain only list integration and notice presentation changes',()=>{
 let s=read('public/crm-preview/drafts.js');
 const undo=(after,before)=>{a(s.includes(after));s=s.replace(after,before);};
 undo('audienceSaved,campaignSelected=()=>{},campaignRecords=null,availability','audienceSaved,campaignSelected=()=>{},availability');
 undo("function renderDraftList(){if(typeof campaignRecords==='function'){campaignRecords(records);el('campaign-drafts').className='d-none';el('campaign-drafts').replaceChildren();return;}",'function renderDraftList(){');
 undo('return Object.freeze({load,openCampaign:id=>{if(!catalog||dirty||busy||pending||!records.some(c=>c.id===id))return;return openCampaign(id);},hasUnsaved:','return Object.freeze({load,hasUnsaved:');
 undo("function notice(id,text,kind='info'){const list=id==='campaign-draft-status'||id==='audience-draft-status',quiet=list&&kind==='info'&&['Crie e salve rascunhos da marca.','Crie, edite e arquive públicos. As versões anteriores ficam preservadas.'].includes(text);el(id).className=quiet?'d-none':list&&kind==='info'?'form-hint mb-3':'alert alert-'+kind;el(id).textContent=quiet?'':text;}","function notice(id,text,kind='info'){el(id).className='alert alert-'+kind;el(id).textContent=text;}");
 a.equal(sha(s),pins.drafts);
});
test('authentication changes only admit the authorized last-count cache',()=>{
 let s=read('auth.cjs');
 const start=s.indexOf(" const audienceCountCache=simpleReadMode?require('./audience-last-count.cjs').create("),end=s.indexOf('\n return Object.freeze',start);a(start>0&&end>start);
 s=s.slice(0,start)+s.slice(end+1);a(s.includes('return Object.freeze({...(audienceCountCache?{audienceCountCache}:{}),...(simpleAccounts?'));
 s=s.replace('return Object.freeze({...(audienceCountCache?{audienceCountCache}:{}),...(simpleAccounts?','return Object.freeze({...(simpleAccounts?');a.equal(sha(s),pins.auth);
});
test('original source reader is unchanged except storing/returning the confirmed aggregate',()=>{
 let s=read('simple-dashboard-read.cjs');
 const store="if(saved&&checked.body.source_confirmed===true&&auth.audienceCountCache)try{auth.audienceCountCache.put({context,brand,request:body,checked,sourceId:crypto.createHash('sha256').update(credential).digest('hex')});}catch{}";
 a(s.includes(store));s=s.replace(store,'');
 const line="    if(checked.status===200&&decision.action==='segmentos_listar'&&auth.audienceCountCache)try{const last=auth.audienceCountCache.read({context,brand,catalog:payload.catalog,segments:payload.segments,sourceId:crypto.createHash('sha256').update(credential).digest('hex')});if(last.rows.length)payload.last_counts=last;}catch{}\n";
 a(s.includes(line));s=s.replace(line,'');a.equal(sha(s),pins.reader);
});
