'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const source=fs.readFileSync(path.join(__dirname,'public/entry.compiled.js'),'utf8');
const operationKey='123e4567-e89b-42d3-a456-426614174000';
const tick=()=>new Promise(resolve=>setImmediate(resolve));

function harness({feature=true,fish=null,aristo=null,failJournal=false}={}){
 const origin='https://crm.shrigma.test',calls=[],messages=[],listeners={};
 const journals={fish,aristo};
 const nodes=new Map();let iframe=null;
 function node(tag='div'){
  const n={tagName:tag.toUpperCase(),id:'',hidden:false,disabled:false,value:'',textContent:'',style:{},dataset:{},children:[],handlers:{},
   addEventListener(type,handler){this.handlers[type]=handler;},setAttribute(){},removeAttribute(){},focus(){},remove(){this.removed=true;},
   append(...items){this.children.push(...items);},prepend(item){this.children.unshift(item);},replaceChildren(...items){this.children=items;},
   querySelector(selector){return selector==='#entry-audience-status'?this.children.find(x=>x.id==='entry-audience-status'&&!x.removed)||null:null;},
   querySelectorAll(){return[];}};
  if(tag==='iframe'){
   n.contentWindow={location:{pathname:'/growth.html'},postMessage(message){messages.push(message);}};
   n.contentDocument={head:{},body:{dataset:{panel:'growth'},classList:{value:false,toggle(_name,value){this.value=value;}}},getElementById:id=>id==='dashboard-operational-readonly'?{}:null};
   iframe=n;
  }
  return n;
 }
 const element=id=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);};
 const session={authenticated:true,user:{id:'synthetic-manager-id',email:'manager@shrigma.test',role:'manager',areas:['growth'],permissions:{growth:{read:true,edit:true}}},
  csrf:'synthetic-csrf',uiKey:'ui-'+'a'.repeat(64),features:{audienceDraft:feature}};
 const fetch=async(url,options={})=>{
  const address=String(url),parsed=new URL(address,origin);calls.push({path:parsed.pathname,query:parsed.searchParams,method:options.method||'GET',csrf:options.headers?.get?.('X-CSRF-Token')||null});
  let body={},status=200;
  if(parsed.pathname==='/auth/session')body=session;
  else if(parsed.pathname==='/auth/audience-draft'){
   if(failJournal)status=503;
   body={operation:journals[parsed.searchParams.get('brand')]};
  }else if(parsed.pathname==='/api/segments'&&parsed.searchParams.get('acao')==='segmentos_listar'){
   const brand=parsed.searchParams.get('brand');body={segments:[],catalog:{brand,current:true},capabilities:{draft:true,send:false}};
  }else if(parsed.pathname==='/api/segments'&&parsed.searchParams.get('acao')==='segmento_operacao'){
   const brand=parsed.searchParams.get('brand');
   journals[brand]={operationKey,action:'segmento_criar',phase:'succeeded',receiptStatus:201,segmentId:operationKey,segmentVersion:1};
   body={segment:{id:operationKey},transport_supported:false};
  }else assert.fail('unexpected '+address);
  return new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
 };
 const document={body:{dataset:{accessPanel:'growth'}},getElementById:element,createElement:node};
 const window={addEventListener(type,handler){listeners[type]=handler;},localStorage:{removeItem(){}},sessionStorage:{removeItem(){}}};
 const location={origin,href:origin+'/',pathname:'/',search:'',hash:''};
 vm.runInNewContext(source,{window,document,fetch,location,history:{replaceState(){}},URL,URLSearchParams,Headers,AbortController,Response,setTimeout,clearTimeout,console});
 return {calls,messages,listeners,nodes,journals,session,iframe:()=>iframe,async ready(){await tick();const current=iframe;assert.ok(current);await listeners.message({origin,source:current.contentWindow,data:{type:'shrigma:ready',panel:'growth'}});return current;},notice(){return element('entry-frame').querySelector('#entry-audience-status');}};
}

test('CRM audience controls open only after both CSRF-protected journals and test catalogues are read',async()=>{
 const x=harness();const frame=await x.ready();
 assert.deepEqual(Array.from(x.messages.at(-1).permission.caps),['draft']);
 assert.equal(frame.contentDocument.body.classList.value,true);
 assert.equal(x.notice(),null);
 const diary=x.calls.filter(call=>call.path==='/auth/audience-draft');
 assert.equal(diary.length,2);assert.ok(diary.every(call=>call.csrf==='synthetic-csrf'));
 assert.equal(x.calls.filter(call=>call.path==='/api/segments'&&call.query.get('acao')==='segmentos_listar').length,2);
 assert.equal(x.calls.filter(call=>call.method==='POST').length,0);
});

test('fresh browser with unresolved journal shows only exact receipt lookup, never a new POST',async()=>{
 const x=harness({fish:{operationKey,action:'segmento_criar',phase:'uncertain'}});const first=await x.ready();
 assert.deepEqual(Array.from(x.messages.at(-1).permission.caps),[]);
 assert.equal(first.contentDocument.body.classList.value,false);
 assert.equal(x.calls.filter(call=>call.query.get('acao')==='segmentos_listar').length,0);
 const button=x.notice().children.find(child=>child.tagName==='BUTTON');assert.ok(button);
 await button.handlers.click();await tick();
 const receipt=x.calls.find(call=>call.query.get('acao')==='segmento_operacao');
 assert.equal(receipt.query.get('brand'),'fish');assert.equal(receipt.query.get('idempotency_key'),operationKey);assert.equal(receipt.csrf,'synthetic-csrf');
 const second=await x.ready();assert.notEqual(second,first);
 assert.deepEqual(Array.from(x.messages.at(-1).permission.caps),['draft']);
 assert.equal(second.contentDocument.body.classList.value,true);
 assert.equal(x.calls.filter(call=>call.method==='POST').length,0);
});

test('no feature or failed durable read keeps the editor closed',async()=>{
 const disabled=harness({feature:false});const first=await disabled.ready();
 assert.deepEqual(Array.from(disabled.messages.at(-1).permission.caps),[]);
 assert.equal(first.contentDocument.body.classList.value,false);
 assert.equal(disabled.calls.filter(call=>call.path==='/auth/audience-draft').length,0);
 const unavailable=harness({failJournal:true});const second=await unavailable.ready();
 assert.deepEqual(Array.from(unavailable.messages.at(-1).permission.caps),[]);
 assert.equal(second.contentDocument.body.classList.value,false);
 assert.match(unavailable.notice().children[0].textContent,/aguarda confirmação/);
 assert.equal(unavailable.calls.filter(call=>call.method==='POST').length,0);
});
