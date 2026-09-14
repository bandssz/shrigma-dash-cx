const test=require('node:test'),assert=require('node:assert/strict');
const S=require('../growth-ses.js');
const coverage=(marca='fish',piece='pedido-pago')=>({marca,flow:'transacional',piece,starts_at:'2026-09-14T14:22:35Z',ends_at:null,state:'partial'});
const row=(more={})=>({dia:'2026-09-14',marca:'fish',flow:'transacional',piece:'pedido-pago',...Object.fromEntries(S.fields.map(k=>[k,0])),aceitos:10,enviados_ses:9,entregues:8,falhas:1,hard:1,sem_confirmacao_final:1,...more});
const api=(rows=[row()],cov=[coverage()])=>({crm_email_ses:{schema_version:1,generated_at:'2026-09-14T14:30:00Z',rows,coverage:cov}});
const model=(a=api(),brand='todas',ini='2026-09-14',fim='2026-09-14')=>S.model(a,brand,ini,fim,Date.parse('2026-09-14T14:35:00Z'));
test('missing, malformed or unsupported payload is unavailable',()=>{
 for(const p of [undefined,null,{},[],{schema_version:1,rows:[],coverage:[]},{schema_version:2,rows:[],coverage:[],generated_at:'2026-09-14T14:30:00Z'}])assert.equal(model({crm_email_ses:p}),null);
});
test('brand and send date filters apply together; later callbacks stay in original cohort',()=>{
 const m=model(api([row(),row({dia:'2026-09-15',aceitos:100}),row({marca:'aristo',aceitos:200}),row({ultimo_evento_em:'2026-09-16T19:00:00Z'})],[coverage(),coverage('aristo')]),'fish');
 assert.equal(m.rows.length,1);assert.equal(m.totals.aceitos,20);assert.equal(m.totals.entregues,16);assert.equal(m.coverage.length,1);assert.equal(m.stale,false);
});
test('period before measurement and empty measured cohorts are unknown, never a zero-delivery claim',()=>{
 assert.equal(model(api(),'todas','2026-09-13','2026-09-13').totals.entregues,null);
 assert.equal(model(api([])).totals.aceitos,null);
 assert.equal(model(api([row({piece:'unmeasured'})])).rows.length,0);
 assert.equal(model(api([row({dia:'2026-09-13'})]),'todas','2026-09-13','2026-09-14').rows.length,0);
});
test('null, blank, booleans and invalid counts propagate unknown without poisoning other metrics',()=>{
 for(const v of [null,undefined,'',false,true,'3',NaN,Infinity,-1,1.2]){
  const m=model(api([row(),row({entregues:v})]));assert.equal(m.totals.entregues,null);assert.equal(m.totals.aceitos,20);
 }
 assert.equal(model(api([row({aceitos:Number.MAX_SAFE_INTEGER}),row()])).totals.aceitos,null);
});
test('overlapping coverage intervals do not duplicate rows; Brasília date used for intervals',()=>{
 const c=coverage();c.starts_at='2026-09-15T01:00:00Z';
 const m=model(api([row()],[c,c]));assert.equal(m.totals.aceitos,10);assert.equal(m.rows.length,1);
});
test('closed intervals exclude later cohorts and stale payload gets a warning',()=>{
 const c=coverage();c.ends_at='2026-09-15T14:00:00Z';
 assert.equal(model(api([row({dia:'2026-09-16'})],[c]),'todas','2026-09-16','2026-09-16').totals.aceitos,null);
 assert.equal(S.model(api(),'todas','2026-09-14','2026-09-14',Date.parse('2026-09-14T15:00:00Z')).stale,true);
});
test('render hides for WhatsApp, escapes labels, and differentiates missing from measured zero',()=>{
 const el={hidden:false,innerHTML:''},ui={el:()=>el,esc:v=>String(v??'').replaceAll('<','&lt;').replaceAll('>','&gt;'),nf:v=>v===null?'—':String(v),timestamp:v=>String(v),period:(a,b)=>a+' a '+b};
 S.render(api(),'todas','2026-09-14','2026-09-14','whatsapp',ui);assert.equal(el.hidden,true);
 const r=row({piece:'<img src=x>',entregues:0}),c=coverage('fish',r.piece);
 S.render(api([r],[c]),'todas','2026-09-14','2026-09-14','email',ui);
 assert.equal(el.hidden,false);assert(!el.innerHTML.includes('<img'));assert.match(el.innerHTML,/&lt;img/);assert.match(el.innerHTML,/Cobertura parcial/);assert.match(el.innerHTML,/<strong>0<\/strong>/);
 S.render({},'todas','2026-09-14','2026-09-14','email',ui);assert.match(el.innerHTML,/indisponíveis/);assert(!el.innerHTML.includes('<strong>0'));
});
