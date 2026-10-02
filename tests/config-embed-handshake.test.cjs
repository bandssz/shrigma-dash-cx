'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const source=fs.readFileSync(path.join(__dirname,'../config.js'),'utf8');
const origin='https://crm.shrigma.com.br',key='ui-1234567890abcdef';
function harness({parentPath='/',area='growth',entryArea='growth',contains=true,embed=true,script=source,haltAfterReady=false}={}){
 const frame={},messages=[],notices=[],events=[];
 const host={contains:node=>contains&&node===frame};
 const parent={location:{href:origin+parentPath},document:{body:{dataset:{accessPanel:entryArea}},getElementById:id=>id==='entry-frame'?host:null},postMessage:(data,target)=>{messages.push({data,target});if(haltAfterReady)throw Error('BUNDLE_HANDSHAKE_REACHED');}};
 const window={parent,frameElement:frame,addEventListener:(name,listener)=>{if(name==='message')events.push(listener);},dispatchEvent:event=>notices.push(event.type)};
 const gate={remove:()=>notices.push('gate-removed')};
 const document={body:{dataset:{panel:area},classList:{add:name=>notices.push(name)}},querySelector:selector=>selector==='#gate'?gate:null,getElementById:()=>null};
 const context=vm.createContext({window,document,location:{origin,search:embed?'?embed=1':''},URL,URLSearchParams,Event:class{constructor(type){this.type=type;}},localStorage:{getItem:()=>'',removeItem:()=>{},setItem:()=>{throw Error('Credential must remain memory-only');}}});
 try{vm.runInContext(script,context);}catch(error){if(!haltAfterReady||error.message!=='BUNDLE_HANDSHAKE_REACHED')throw error;}
 const dispatch=(override={})=>{for(const listener of events)listener({source:parent,origin,data:{type:'shrigma:read-access',panel:area,key,permission:{caps:['draft'],label:'Synthetic manager'}},...override});};
 const reader=()=>vm.runInContext(`shrigmaChave(${JSON.stringify(area)})`,context);
 return {context,parent,messages,notices,events,dispatch,reader};
}

test('root portal releases the iframe key only for its exact same-origin entry and panel',()=>{
 for(const [area,entryArea] of [['growth','growth'],['growth','todos'],['organico','organico'],['influs','influs']]){
  const h=harness({area,entryArea});
  assert.equal(h.events.length,1);
  assert.equal(h.messages.length,1);
  assert.equal(h.messages[0].data.type,'shrigma:ready');
  assert.equal(h.messages[0].data.panel,area);
  assert.equal(h.messages[0].target,origin);
  assert.equal(h.reader(),'');
  h.dispatch();
  assert.equal(h.reader(),key);
  assert.equal(vm.runInContext(`shrigmaChaveOperador(${JSON.stringify(area)},'draft')`,h.context),key);
  assert.ok(h.notices.includes('gate-removed'));
  assert.ok(h.notices.includes('shrigma:access-ready'));
 }
});

test('root exception rejects a foreign source, origin, panel, entry marker or iframe',()=>{
 for(const [options,override] of [
  [{}, {source:{}}],
  [{}, {origin:'https://wrong.invalid'}],
  [{}, {data:{type:'shrigma:read-access',panel:'organico',key}}],
  [{entryArea:'organico'},{}],
  [{entryArea:'cx'},{}],
  [{contains:false},{}],
  [{parentPath:'/unrelated'},{}]
 ]){
  const h=harness(options);h.dispatch(override);
  assert.equal(h.reader(),'');
  assert.ok(!h.notices.includes('gate-removed'));
  assert.ok(!h.notices.includes('shrigma:access-ready'));
 }
});

test('legacy exact-parent entry still works, while a non-embedded page ignores messages',()=>{
 const legacy=harness({parentPath:'/crm/index.html',entryArea:'unrelated',contains:false});
 legacy.dispatch();assert.equal(legacy.reader(),key);
 const direct=harness({embed:false});assert.equal(direct.events.length,0);direct.dispatch();assert.equal(direct.reader(),'');
});

test('published CRM panel bundle contains the working root handshake',()=>{
 const bundle=fs.readFileSync(path.join(__dirname,'../assets/panels/growth.js'),'utf8');
 const h=harness({script:bundle,haltAfterReady:true});
 assert.equal(h.messages[0]?.data?.type,'shrigma:ready');
 h.dispatch();
 assert.equal(h.reader(),key);
 assert.ok(h.notices.includes('shrigma:access-ready'));
});
