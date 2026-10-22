'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const packagedInputs=path.resolve(__dirname,'../../../../inputs'),inputs=fs.existsSync(packagedInputs+'/INPUTS.json')?packagedInputs:path.resolve(__dirname,'../..'),Client=require(inputs+'/growth-segment-client.js');
const moduleBox={exports:{}};vm.runInThisContext('(function(require,module,exports){'+fs.readFileSync(path.resolve(__dirname,'../../growth-segment-ui.js'),'utf8')+'\n})')(name=>require(inputs+'/'+name.replace(/^\.\//,'')),moduleBox,moduleBox.exports);const UI=moduleBox.exports;
const clone=x=>JSON.parse(JSON.stringify(x)),id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
function segment(n=1,brand='fish',archived=false){const name='Público '+brand+' '+n;return {id:id(n),brand,name,definition:{schema_version:Client.VERSION,brand,name,rule:{op:'in_list',list_id:brand==='fish'?11:21}},version:3,archived,created_at:'2026-10-01T12:00:00Z',updated_at:'2026-10-07T12:00:00Z',updated_by:'synthetic'};}
const api={capabilities:{segments:{contract_version:Client.VERSION,brands:['fish','aristo'],read:true,save:true,operation:true,count:false},endpoints:{segments:'https://synthetic.invalid/segments'}}};
function fixture(initial=[segment(),segment(2,'fish',true)]){
 const store=new Map(),rows=new Map(initial.map(s=>[s.id,clone(s)])),receipts=new Map(),calls=[],control={};const storage={getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v)},locks={request:async(k,options,fn)=>fn({name:k})};
 const fetch=async(url,init)=>{const query=Object.fromEntries(new URL(url).searchParams),body=init.method==='POST'?JSON.parse(init.body):query;calls.push({method:init.method,body:clone(body)});const reply=(status,b)=>({status,json:async()=>clone(b)});
  if(body.acao==='segmentos_listar'){if(control.failList)return reply(503,{error:'UNAVAILABLE'});const offset=Number(body.offset),limit=Number(body.limit);return reply(200,{segments:clone(control.staleRows??[...rows.values()]).filter(s=>s.brand===body.brand).slice(offset,offset+limit),offset,limit,capabilities:{draft:control.draft!==false,count:false,send:false},catalog:{brand:body.brand,current:true,lists:[{id:body.brand==='fish'?11:21,brand:body.brand,name:'Lista '+body.brand,available:true}]}});}
  if(body.acao==='segmento_obter'){const s=rows.get(body.id);return reply(200,{segment:control.foreignOpen?segment(1,'aristo'):s});}
  if(body.acao==='segmento_arquivar'){
   if(control.wait)await control.wait;
   if(control.refuse)return reply(409,{error:'SEGMENT_VERSION_CONFLICT',current_version:4});
   const before=rows.get(body.id);assert.equal(body.brand,before.brand);assert.equal(body.expected_version,before.version);const s={...clone(before),version:before.version+1,archived:true};rows.set(s.id,s);const receipt={segment:s,transport_supported:false};receipts.set(body.idempotency_key,receipt);
   if(control.failAfterArchive)control.failList=true;
   if(control.timeout)throw Error('synthetic timeout');
   if(control.badReceipt)return reply(200,{segment:{...s,brand:'aristo'},transport_supported:false});
   return reply(200,receipt);
  }
  if(body.acao==='segmento_operacao')return reply(200,receipts.get(body.idempotency_key));
  throw Error('Unexpected synthetic request '+body.acao);
 };
 return {storage,store,rows,receipts,calls,control,fetch,locks};
}
const decode=s=>s.replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
class Node{constructor(tag,attrs,element){this.tag=tag;this.attrs=attrs;this.element=element;this.dataset={};for(const [k,v]of Object.entries(attrs))if(k.startsWith('data-'))this.dataset[k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=v;this.disabled=Object.hasOwn(attrs,'disabled');this.value=attrs.value??'';this.textContent='';this.isConnected=true;}matches(s){const tag=s.match(/^\w+/)?.[0];if(tag&&tag!==this.tag)return false;if(s.startsWith('#'))return this.attrs.id===s.slice(1);for(const m of s.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g))if(!Object.hasOwn(this.attrs,m[1])||m[2]!==undefined&&this.attrs[m[1]]!==m[2])return false;return true;}closest(s){return this.matches(s)?this:null;}focus(){this.element.ownerDocument.activeElement=this;}setSelectionRange(a,b){this.selectionStart=a;this.selectionEnd=b;}showModal(){this.open=true;}}
function element(){const e={ownerDocument:{activeElement:null,body:{}},nodes:[],handlers:{},html:'',addEventListener(type,fn){(this.handlers[type]??=[]).push(fn);},contains(n){return this.nodes.includes(n);},querySelectorAll(s){return this.nodes.filter(n=>n.matches(s));},querySelector(s){return this.querySelectorAll(s)[0]??null;},get innerHTML(){return this.html;},set innerHTML(v){for(const n of this.nodes)n.isConnected=false;this.html=v;this.nodes=[];for(const m of v.matchAll(/<(button|input|select|fieldset|dialog|p|h3|aside)\b([^>]*)>/g)){const attrs={};for(const a of m[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g))attrs[a[1]]=decode(a[2]??'');this.nodes.push(new Node(m[1],attrs,this));}},get textContent(){return decode(this.html.replace(/<[^>]*>/g,' '));}};return e;}
function boot(f=fixture(),options={}){const e=element();let token='synthetic';const ui=UI.create({element:e,key:()=>token,storage:f.storage,fetch:f.fetch,locks:options.locks===false?null:f.locks,identity:async v=>crypto.createHash('sha256').update(v).digest('hex')});const q=s=>e.querySelector(s);
 const event=(type,node)=>{for(const fn of e.handlers[type]??[])fn({target:node});};
 return {f,ui,e,q,setToken:v=>token=v,async sync(a=api,brand='fish'){return ui.sync({api:clone(a),brand});},async click(action,n){const b=q('[data-gs="'+action+'"]'+(n?'[data-id="'+id(n)+'"]':''));assert(b,'missing '+action);if(!b.disabled){b.focus();event('click',b);}await idle(ui);},async force(action){const b=new Node('button',{'data-gs':action},e);e.nodes.push(b);event('click',b);await idle(ui);},input(value){const n=q('[data-gs-name]');n.value=value;n.selectionStart=2;event('input',n);},saved(){return JSON.parse(f.storage.getItem(UI.SLOT+'fish'));}};
}
async function idle(ui){for(let i=0;i<100;i++){await new Promise(r=>setImmediate(r));if(!ui.contextStatus().busy)return;}assert.fail('Synthetic UI stayed busy');}
const aside=x=>x.e.html.split('<aside class="gs-saved-list">')[1]?.split('</aside>')[0]??'',posts=x=>x.f.calls.filter(c=>c.method==='POST');
module.exports={boot,fixture,segment,id,api,clone,aside,posts,Client,UI,idle};
