const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const CEILING=180000;
function login(fetch){
 const source=fs.readFileSync(require.resolve('../panel-entry.js'),'utf8'),
  s=source.slice(source.indexOf(' async function readIdentity('),source.indexOf(" document.getElementById('entry-logout')")),
  timers=new Map();
 let id=0;
 const ctx=vm.createContext({fetch,AbortController,Promise,Error,ACCESS_WAIT_MS:CEILING,
  setTimeout:(fn,ms)=>{timers.set(++id,{fn,ms});return id;},clearTimeout:i=>timers.delete(i)});
 vm.runInContext(s,ctx);
 const controller=new AbortController();
 return {controller,timers,run:()=>ctx.readIdentity('https://synthetic.invalid','synthetic-key',controller)};
}
test('the entry ceiling matches the published source', ()=>{
 const source=fs.readFileSync(require.resolve('../panel-entry.js'),'utf8');
 assert.match(source,/const ACCESS_WAIT_MS=180000;/);
});
test('the ceiling releases a fetch that never honors abort',async()=>{
 const x=login(()=>new Promise(()=>{})),p=x.run();
 const deadline=[...x.timers.values()].find(t=>t.ms===CEILING);
 assert.ok(deadline,'deadline timer uses the declared ceiling');
 deadline.fn();
 await assert.rejects(p,/ACCESS_TIMEOUT/);
 assert.equal(x.timers.size,0);
 assert.equal(x.controller.signal.aborted,true);
});
test('the ceiling also covers a stalled JSON body',async()=>{
 const x=login(async()=>({ok:true,status:200,json:()=>new Promise(()=>{})})),p=x.run();
 await Promise.resolve();
 [...x.timers.values()].find(t=>t.ms===CEILING).fn();
 await assert.rejects(p,/ACCESS_TIMEOUT/);
 assert.equal(x.timers.size,0);
});
test('an operator giving up aborts the request and opens no session',async()=>{
 let seen=null;
 const x=login((url,init)=>{seen=init.signal;return new Promise((_,reject)=>{init.signal.addEventListener('abort',()=>reject(Object.assign(Error('aborted'),{name:'AbortError'})));});});
 const p=x.run();
 await Promise.resolve();
 x.controller.abort();
 await assert.rejects(p,/aborted/);
 assert.equal(seen.aborted,true);
 assert.equal(x.timers.size,0,'giving up clears the deadline too');
});
test('denial stays denial and a valid identity clears every timer',async()=>{
 const x=login(async()=>({ok:false,status:403}));
 await assert.rejects(x.run(),/ACCESS_DENIED/);
 assert.equal(x.timers.size,0);
 const y=login(async()=>({ok:true,status:200,json:async()=>({allowedPanels:['cx']})}));
 assert.deepEqual(await y.run(),{allowedPanels:['cx']});
 assert.equal(y.timers.size,0);
});
test('an unavailable server is not treated as a denial',async()=>{
 const x=login(async()=>({ok:false,status:502}));
 await assert.rejects(x.run(),/UNAVAILABLE/);
 assert.equal(x.timers.size,0);
});
