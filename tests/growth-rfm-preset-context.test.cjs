'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../growth.html'),'utf8');
function functionSource(name){
 const start=source.indexOf('function '+name+'(');assert.notEqual(start,-1);const open=source.indexOf('{',start);let depth=0,quote='',escape=false;
 for(let i=open;i<source.length;i++){const c=source[i];if(quote){if(escape)escape=false;else if(c==='\\')escape=true;else if(c===quote)quote='';continue;}if(c==='\''||c==='"'||c==='`'){quote=c;continue;}if(c==='{')depth++;else if(c==='}'&&--depth===0)return source.slice(start,i+1);}
 throw Error('UNTERMINATED_FUNCTION');
}
function harness(){
 let resolveSync,calls=0,scrolled=0,mounted;
 const context={API:{},MARCA:'fish',SEC:'base',CRM_AUDIENCE_VIEW:null,CRM_SEGMENT_VIEW:{contextStatus:()=>({brand:context.MARCA}),startPreset:async()=>{calls++;return 'started';}},
  renderPublicCreation(){},renderSegmentos:()=>new Promise(resolve=>{resolveSync=resolve;}),contextoSegmentos:()=>({brand:context.MARCA,key:context.key,caps:{endpoint:context.endpoint}}),
  mesmoContextoSegmentos:(a,b)=>a.brand===b.brand&&a.key===b.key&&JSON.stringify(a.caps)===JSON.stringify(b.caps),key:'actor-one',endpoint:'https://fixture.invalid/segments',
  GAudience:{mount(options){mounted=options;return {update:()=>({total:0})};}},GCE:{catalogs:()=>[]},
  $(selector){return selector==='#area-arvore'?{}:{textContent:'',scrollIntoView(){scrolled++;}};}};
 vm.createContext(context);vm.runInContext(functionSource('catalogosPublicos'),context);vm.runInContext(functionSource('renderPublicos'),context);context.renderPublicos();
 return {context,callback:()=>mounted.onCreateRfm,release:()=>resolveSync(),calls:()=>calls,scrolled:()=>scrolled};
}
test('RFM card rechecks brand, key and endpoint after the segment editor await',async()=>{
 for(const drift of ['brand','key','endpoint']){const h=harness(),pending=h.callback()({brand:'fish',tag:'campeao',name:'Campeões'});if(drift==='brand')h.context.MARCA='aristo';else if(drift==='key')h.context.key='actor-two';else h.context.endpoint='https://other.invalid/segments';h.release();assert.equal(await pending,false,drift);assert.equal(h.calls(),0,drift);assert.equal(h.scrolled(),0,drift);}
 const h=harness(),pending=h.callback()({brand:'fish',tag:'campeao',name:'Campeões'});h.release();assert.equal(await pending,'started');assert.equal(h.calls(),1);assert.equal(h.scrolled(),1);
});
