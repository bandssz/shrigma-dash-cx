'use strict';
const a=require('node:assert/strict');
function observe(page){
 let compare,mail;const errors=[],comparison=new Promise(resolve=>compare=resolve),snapshot=new Promise(resolve=>mail=resolve);
 page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{const u=new URL(r.url());if(u.pathname==='/api/crm-restricted/compras'&&u.searchParams.get('action')==='compare-home')compare(r);if(u.pathname==='/api/crm-read'&&u.searchParams.get('action')==='cache_growth')mail(r);});
 return {comparison,snapshot,errors};
}
async function prove({page,brand,observed,required=false}){
 await page.waitForFunction(()=>document.getElementById('crm-home-layout')||[...document.querySelectorAll('#home-metrics .metric-value')].some(n=>n.textContent.trim()&&!['—','…'].includes(n.textContent.trim())),null,{timeout:90000});
 if(!await page.locator('#crm-home-layout').count()){a.equal(required,false,'DEFAULT_HOME_FRAME_REQUIRED');return {legacy:true};}
 const frame=await(await page.locator('#crm-home-layout').elementHandle()).contentFrame();a(frame);
 await frame.waitForFunction(()=>document.querySelectorAll('#metrics .metric').length===4&&!document.getElementById('apply').disabled,null,{timeout:90000});
 a.equal(await page.locator('#issue-open').isVisible(),true);a.equal(await frame.locator('#issue-header-actions').isVisible(),false);a.equal(await frame.locator('#brand').inputValue(),brand);a.equal(await page.locator('#brand').inputValue(),brand);a.equal(await frame.locator('#notice').isVisible(),false);a.equal(await page.locator('#error').isVisible(),false);a.deepEqual(observed.errors,[]);
 const response=await observed.comparison,snapshot=await observed.snapshot;a.equal(response.status(),200);a.equal(snapshot.status(),200);const facts=await response.json(),mail=await snapshot.json();a.equal(facts.brand,brand);a.equal(mail.brand,brand);a.deepEqual(mail.brands,[brand]);const request=new URL(response.url());if(!facts.period.fallback){a.equal(facts.calendar.ini,request.searchParams.get('ini'));a.equal(facts.calendar.fim,request.searchParams.get('fim'));}else a.match(await frame.locator('#period').textContent(),/última janela disponível/);a.equal(new URL(response.url()).searchParams.get('brand'),brand);
 const expected=await frame.evaluate(({facts,mail})=>{const format=new Intl.NumberFormat('pt-BR'),day=v=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(v)),summary=window.ShrigmaCrmHome.summarize({crm_diario:mail.crm_diario,crm_fontes:mail.crm_fontes},facts.brand,day(facts.period.from),day(Date.parse(facts.period.until)-1)),number=n=>n===null||n===undefined?'—':format.format(n),cents=BigInt(facts.totals.revenueCents??0),symbol=new Intl.NumberFormat('pt-BR',{style:'currency',currency:facts.currency}).formatToParts(0).find(x=>x.type==='currency').value;
  return [number(summary.sent??summary.knownSent??null),'—',number(facts.totals.orders),facts.totals.revenueCents==null?'—':symbol+' '+(cents/100n).toLocaleString('pt-BR')+','+(cents%100n).toString().padStart(2,'0')];
 },{facts,mail});
 const actual=await frame.locator('#metrics .metric .h1').allTextContents();a.deepEqual(actual,expected);
 a.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false);a.equal(await frame.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false);
 return {defaultLayout:true,brand,orders:facts.totals.orders,revenueCents:facts.totals.revenueCents,calendar:facts.calendar,sourceCompared:true,crossBrandData:false};
}
module.exports={observe,prove};
