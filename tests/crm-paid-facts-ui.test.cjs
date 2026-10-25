'use strict';
const test=require('node:test'),a=require('node:assert/strict'),vm=require('node:vm'),path=require('node:path'),{parseHTML}=require('linkedom');
const {HTML,JS}=require(path.join(process.env.DASHBOARD_ACCESS_TEST_RUNTIME||path.resolve(__dirname,'../services/dashboard-operational'),'crm-paid-facts-ui.cjs'));
async function fixture({broken=false,recovery,terminalError=false}={}){
 const {window,document}=parseHTML(HTML),at=Date.now(),until=new Date(at+10).toISOString(),coverage={days:30,from:new Date(at+10-30*86400000).toISOString(),until,checkedAt:until},old={...coverage,from:new Date(at-31*86400000).toISOString(),until:new Date(at-86400000).toISOString()},calls=[];let posted=false,statusReads=0;
 Object.defineProperty(window.HTMLSelectElement.prototype,'value',{configurable:true,get(){return(this.querySelector('option[selected]')||this.querySelector('option'))?.getAttribute('value')||'';},set(v){for(const o of this.querySelectorAll('option'))o.selected=o.getAttribute('value')===String(v);}});
 const status=c=>({brand:'fish',coverage:c,checkedAt:new Date(at).toISOString(),publics:[]});
 const fetchImpl=async(url,options={})=>{
  if(url==='/auth/session')return new Response(JSON.stringify({csrf:'synthetic-only-csrf'}));
  const command=options.body?JSON.parse(options.body):Object.fromEntries(new URL(url,'https://synthetic.invalid').searchParams);calls.push(command);
  if(command.action==='status'){if(!posted)return new Response(JSON.stringify(status(old)));statusReads++;return new Response(JSON.stringify(recovery?recovery({coverage,old,status,read:statusReads}):status(coverage)));}
  if(command.action==='products')return new Response('[]');
  if(command.action==='count')return new Response(JSON.stringify({confirmed:true,count:25}));
  a.equal(command.action,'backfill');a.equal(command.progress,true);posted=true;
  const first=JSON.stringify({type:'progress',brand:'fish',days:30,from:coverage.from,until,pages:1,orders:25,note:'Concluído'})+'\n',last=JSON.stringify(terminalError?{type:'error',error:'PAID_FACTS_SHOPIFY_UNAVAILABLE'}:{type:'complete',ok:true,brand:'fish',coverage})+'\n',wire=Buffer.from(first+last),chunks=[];
  for(let n=0;n<wire.length;n+=3)chunks.push(wire.subarray(n,n+3));let next=0;
  return{ok:true,headers:new Headers({'content-type':'application/x-ndjson'}),body:{getReader:()=>({read:async()=>{if(broken&&next>=Math.ceil(Buffer.byteLength(first)/3))throw new TypeError('synthetic connection reset');return next<chunks.length?{done:false,value:chunks[next++]}:{done:true};},releaseLock(){}})}};
 };
 vm.runInContext(JS,vm.createContext({document,window,location:{search:'?brand=fish',origin:'https://synthetic.invalid'},URLSearchParams,fetch:fetchImpl,TextDecoder,AbortSignal,AbortController,setTimeout:resolve=>{setImmediate(resolve);return 0;}}));
 const settle=async predicate=>{for(let n=0;n<600;n++){await new Promise(setImmediate);if(predicate())return;}throw Error('PURCHASE_UI_NOT_SETTLED');};
 await settle(()=>calls.some(x=>x.action==='products')&&!document.getElementById('refresh').disabled);
 const click=()=>document.getElementById('refresh').click(),idle=()=>settle(()=>!document.getElementById('refresh').disabled);
 return{document,calls,click,idle,settle,backfillPosts:()=>calls.filter(x=>x.action==='backfill').length};
}
test('purchase update parses fragmented UTF8 progress and counts without an operator step',async()=>{const f=await fixture();f.click();await f.settle(()=>f.document.getElementById('notice').textContent==='Pedidos atualizados.');a.equal(f.document.getElementById('total').textContent,'25 pessoas');a.equal(f.backfillPosts(),1);a.equal(f.calls.filter(x=>x.action==='count').length,1);});
test('connection reset reconciles the same update with GET only; repeated click cannot create another POST',async()=>{const f=await fixture({broken:true,recovery:({coverage,status,read})=>status(read<2?null:coverage)});f.click();f.click();await f.settle(()=>f.document.getElementById('notice').textContent==='Pedidos atualizados.');a.equal(f.backfillPosts(),1);a.equal(f.document.getElementById('total').textContent,'25 pessoas');a(f.calls.filter(x=>x.action==='status').length>=4);});
for(const [name,recovery]of [
 ['null',({status})=>status(null)],
 ['previous cutoff',({status,old})=>status(old)],
 ['wrong brand',({status,coverage})=>({...status(coverage),brand:'aristo'})],
 ['only29days',({status,coverage})=>status({...coverage,days:29,from:new Date(Date.parse(coverage.until)-29*86400000).toISOString()})],
 ['new checkedAt but old until',({status,old,coverage})=>status({...old,checkedAt:coverage.checkedAt})]
])test('uncertain update rejects '+name+' and the next click still reads without another POST',async()=>{const f=await fixture({broken:true,recovery});f.click();await f.settle(()=>f.document.getElementById('refresh').textContent==='Conferir atualização'&&!f.document.getElementById('refresh').disabled);a.match(f.document.getElementById('notice').textContent,/ainda não foi confirmada/);a.equal(f.document.getElementById('total').textContent,'sem fonte');a.equal(f.calls.filter(x=>x.action==='count').length,0);f.click();await f.idle();a.equal(f.backfillPosts(),1);});
test('terminal source failure after headers never claims completion or repeats the POST',async()=>{const f=await fixture({terminalError:true});f.click();await f.settle(()=>/não cobriu/.test(f.document.getElementById('notice').textContent));a.equal(f.backfillPosts(),1);a.equal(f.calls.filter(x=>x.action==='count').length,0);a.equal(f.document.getElementById('total').textContent,'sem fonte');});
