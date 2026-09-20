const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../growth.html'),'utf8');
function clock(code=source,hidden=false){
 const start=code.includes('// Automatic refresh only')?code.indexOf('// Automatic refresh only'):code.lastIndexOf('carregar();\nsetInterval(carregar,');
 assert(start>=0);const block=code.slice(start,code.indexOf('</script>',start));
 let now=0,reads=0,renders=0;const timers=[],events={},document={hidden,addEventListener:(name,fn)=>events[name]=fn};
 const ctx=vm.createContext({document,Date:{now:()=>now},REFRESH_SEG:60,API:{fixture:125},MARCA:'fish',CANAL:'email',PER:{ini:'2026-09-14',fim:'2026-09-20'},exportMeta:()=>{},
  carregar:()=>{reads++;},GC:{render:()=>{renders++;return {workflows:[]};}},GFU:{render:()=>renders++},setInterval:(fn,ms)=>timers.push({fn,ms})});
 vm.runInContext(block,ctx);
 return {document,counts:()=>({reads,renders}),advance(ms){const end=now+ms;for(now+=30000;now<=end;now+=30000)for(const t of timers)if(now%t.ms===0)t.fn();now=end;},show(){document.hidden=false;events.visibilitychange?.();},hide(){document.hidden=true;events.visibilitychange?.();}};
}
test('one hidden hour generates no automatic read or control rerender; returning refreshes once',()=>{
 const c=clock();assert.equal(c.counts().reads,1);c.hide();c.advance(3600000);assert.deepEqual(c.counts(),{reads:1,renders:0});c.show();assert.equal(c.counts().reads,2);c.show();assert.equal(c.counts().reads,2);
});
test('visible refresh cadence stays at 60 seconds and control render at 30 seconds',()=>{
 const c=clock();c.advance(3600000);assert.deepEqual(c.counts(),{reads:61,renders:240});
});
test('a page opened hidden waits for visibility; a brief hide does not create an extra request',()=>{
 const c=clock(source,true);assert.equal(c.counts().reads,0);c.show();assert.equal(c.counts().reads,1);c.hide();c.advance(30000);c.show();assert.equal(c.counts().reads,1);c.advance(30000);assert.equal(c.counts().reads,2);
});
