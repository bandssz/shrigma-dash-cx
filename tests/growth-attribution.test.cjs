const {test}=require('node:test'),assert=require('node:assert/strict'),GA=require('../growth-attribution');
const day='2026-09-15',family='semana-do-cliente-2026',utm={source:'listmonk',medium:'campanha',campaign:'aristo-semana-cliente',content:'cta',term:''};
test('strict last click is the default and non-direct credit requires an explicit selection',()=>{
 const f=fixture(),strict=f.crm_attribution.daily.find(r=>r.grain==='total');
 f.crm_attribution.daily.push({...strict,model:'last_non_direct',receita:900,pedidos:9});
 assert.equal(GA.DEFAULT_MODEL,'last_click');assert.equal(GA.model(f),'last_click');
 GA.project(f);assert.equal(GA.sum(GA.rows(f,'aristo',day,day,'total')).receita,100);
 GA.project(f,'last_non_direct');assert.equal(GA.sum(GA.rows(f,'aristo',day,day,'total')).receita,900);
 GA.project(f,'invalid');assert.equal(GA.model(f),'last_click');assert.equal(GA.sum(GA.rows(f,'aristo',day,day,'total')).receita,100);
});
function fixture(){const row=(grain,dimension,n=1)=>({marca:'aristo',dia:day,model:'last_click',grain,dimension,pedidos:n,receita:n*100,assistidos:0});return {crm_familia_campanha:[{marca:'aristo',utm_campaign:utm.campaign,familia:family}],crm_conversao:[{marca:'aristo',dia:day,canal:'email',receita_ultimo:999}],crm_attribution:{schema_version:2,generated_at:day+'T14:00:00Z',coverage:[{brand:'aristo',day,checked_at:day+'T13:00:00Z'}],quality:[],daily:[row('family',[family]),row('family_channel',[family,'email']),row('total',['crm']),row('channel',['email']),row('piece',['email',utm.medium,utm.campaign,utm.content,'',utm.source])],campaigns:[{marca:'aristo',emissor:'aristo',canal:'email',campanha_id:127,nome:'Semana Cliente Mornos',familia:family,segmentos:['Mornos'],status:'running',enviados:700,utms:[utm],enviado_em:day+'T11:30:00Z'},{marca:'aristo',emissor:'aristo',canal:'email',campanha_id:126,nome:'Semana Cliente Quentes',familia:family,segmentos:['Quentes'],status:'scheduled',enviados:0,utms:[{...utm,content:'hero'}],agendado_em:day+'T21:00:00Z'}]}};}
test('initiative groups sends and scheduled bases while preserving one purchase',()=>{const [v]=GA.campaigns(fixture(),'aristo',day,day);assert.equal(v.members.length,2);assert.equal(v.sent,700);assert.equal(v.scheduled,1);assert.equal(v.pedidos,1);assert.equal(v.receita,100);assert.equal(v.members.find(m=>m.campanha_id===127).result.receita,100);assert.equal(v.members.find(m=>m.campanha_id===126).result,null);});
test('shared full UTM cannot allocate sale to a segment; initiative keeps one credit',()=>{const f=fixture();f.crm_attribution.campaigns.push({...f.crm_attribution.campaigns[0],campanha_id:128,segmentos:['Frios']});const [v]=GA.campaigns(f,'aristo',day,day);assert.equal(v.receita,100);assert.equal(v.shared,2);assert(v.members.filter(m=>!m.future).every(m=>m.result===null));});
test('different medium or source does not claim a purchase',()=>{for(const key of ['source','medium']){const f=fixture();f.crm_attribution.campaigns[0].utms=[{...utm,[key]:'different'}];assert.equal(GA.campaigns(f,'aristo',day,day)[0].members.find(m=>m.campanha_id===127).result.receita,0);}});
test('untagged sends remain visible with unknown revenue',()=>{const f=fixture();f.crm_attribution.campaigns[0].utms=null;const [v]=GA.campaigns(f,'aristo',day,day);assert.equal(v.sent,700);assert.equal(v.untracked,1);assert.equal(v.members.find(m=>m.campanha_id===127).result,null);});
test('purchase period and dispatch period differ explicitly',()=>{const f=fixture();f.crm_attribution.campaigns[0].enviado_em='2026-09-14T11:30:00Z';const [v]=GA.campaigns(f,'aristo',day,day);assert.equal(v.sent,0);assert.equal(v.receita,100);assert.equal(v.members.find(m=>m.campanha_id===127).in_period,false);});
test('cross promotion uses destination store for conversion and retains sender base',()=>{const f=fixture();f.crm_attribution.campaigns[0].emissor='fish';const [v]=GA.campaigns(f,'aristo',day,day);assert.equal(v.receita,100);assert.equal(v.members.find(m=>m.campanha_id===127).emissor,'fish');assert.equal(GA.campaigns(f,'fish',day,day).length,0);});
test('models project without retaining obsolete credit or accumulating on toggle',()=>{const f=fixture();GA.project(f);assert.equal(f.crm_conversao.length,1);assert.equal(f.crm_conversao[0].receita_ultimo,100);GA.project(f,'last_non_direct');assert.equal(f.crm_conversao.length,0);GA.project(f);assert.equal(f.crm_conversao.length,1);assert.equal(GA.conversion(f,'aristo',day,day,'familia')[0].receita,100);});
test('channel filtering and campaign search honor real dimensions',()=>{const f=fixture();assert.equal(GA.campaigns(f,'aristo',day,day,'whatsapp').length,0);assert.equal(GA.campaigns(f,'aristo',day,day,'email','mornos').length,1);assert.equal(GA.campaigns(f,'aristo',day,day,'email','not present').length,0);});
test('coverage is per brand per day; rows absent from one brand cannot imply full coverage',()=>{const f=fixture();assert.equal(GA.coverage(f,'aristo',day,day).complete,true);assert.equal(GA.coverage(f,'todas',day,day).complete,false);assert.equal(GA.coverage(f,'aristo','2026-09-14',day).covered,1);});
test('family and channel credit come from independent order-deduplicated grains',()=>{const f=fixture();f.crm_attribution.daily.find(r=>r.grain==='family').assistidos=1;f.crm_attribution.daily.push({...f.crm_attribution.daily.find(r=>r.grain==='piece'),dimension:['whatsapp','campanha',utm.campaign,'wa','','whatsapp'],pedidos:0,receita:0,assistidos:3});const v=GA.conversion(f,'aristo',day,day,'familia')[0];assert.equal(v.assist,1);assert.equal(v.pedidos,1);});
test('exclusive links keep their revenue when the dispatch also has a shared coupon link',()=>{const f=fixture(),shared={...utm,content:'coupon'};f.crm_attribution.campaigns[0].utms.push(shared);f.crm_attribution.campaigns.push({...f.crm_attribution.campaigns[0],campanha_id:128,utms:[shared]});const [v]=GA.campaigns(f,'aristo',day,day);const m=v.members.find(m=>m.campanha_id===127);assert.equal(m.shared,true);assert.equal(m.result.receita,100);assert.equal(v.members.find(m=>m.campanha_id===128).result,null);});
test('automatic recovery flows remain in conversion data, outside the commercial initiative list',()=>{const f=fixture();f.crm_attribution.daily.push({marca:'aristo',dia:day,model:'last_click',grain:'family',dimension:['workflow_123_carrinho'],pedidos:5,receita:500});assert.equal(GA.campaigns(f,'aristo',day,day).length,1);assert.equal(GA.conversion(f,'aristo',day,day,'familia').length,2);});

test('historical commercial WhatsApp stays visible without inventing an email campaign association',()=>{const f=fixture(),c='workflow-175919-semana-do-pescador-02';for(const grain of ['family','family_channel','piece'])f.crm_attribution.daily.push({marca:'fish',dia:day,model:'last_click',grain,dimension:grain==='family'?[c]:grain==='family_channel'?[c,'whatsapp']:['whatsapp','reportana',c,'cta','','rptn'],pedidos:2,receita:205.13,assistidos:0});const [v]=GA.campaigns(f,'fish',day,day,'whatsapp');assert.equal(v.pedidos,2);assert.equal(v.receita,205.13);assert.equal(v.members.length,0);assert.equal(v.channels[0].canal,'whatsapp');assert.equal(v.familia,c);});

test('scheduled link reuse is visible before sending without removing current exclusive credit',()=>{const f=fixture();f.crm_attribution.campaigns[1].utms=[utm];const [v]=GA.campaigns(f,'aristo',day,day);const sent=v.members.find(m=>m.campanha_id===127),future=v.members.find(m=>m.campanha_id===126);assert.equal(sent.tracking_state,'shared');assert.equal(future.tracking_state,'shared');assert.equal(sent.result.receita,100);assert.equal(future.result,null);f.crm_attribution.campaigns[1].utms=[{...utm,term:'lm-126-l123'}];assert(GA.campaigns(f,'aristo',day,day)[0].members.every(m=>m.tracking_state==='exclusive'));});


test('dispatch engagement uses unique recipients and delivered emails, not sends or total events',()=>{
 const m={enviados:1000,entregues:800,abriram:200,clicaram:40,aberturas:900,cliques:120};
 assert.deepEqual(GA.engagement(m),{delivered:800,opened:200,clicked:40,opening:25,ctr:5,ctor:20});
});
test('unmeasured engagement differs from zero and never divides by zero',()=>{
 for(const missing of [null,undefined,'',false,'invalid']){
  const m=GA.engagement({entregues:800,abriram:missing,clicaram:0});
  assert.equal(m.opening,null);assert.equal(m.ctr,0);assert.equal(m.ctor,null);
 }
 assert.deepEqual(GA.engagement({entregues:'800',abriram:'0',clicaram:'0'}),{delivered:800,opened:0,clicked:0,opening:0,ctr:0,ctor:null});
 const noDelivery=GA.engagement({entregues:0,abriram:0,clicaram:0});assert.equal(noDelivery.opening,null);assert.equal(noDelivery.ctr,null);assert.equal(noDelivery.ctor,null);
 const noClicks=GA.engagement({entregues:800,abriram:200,clicaram:null});assert.equal(noClicks.opening,25);assert.equal(noClicks.ctr,null);assert.equal(noClicks.ctor,null);
});

test('Olivas is included in campaign attribution and consolidated coverage without legacy duplicates',()=>{const f=fixture();f.crm_attribution.campaigns=f.crm_attribution.campaigns.map(m=>({...m,marca:'olivas',emissor:'olivas'}));f.crm_attribution.daily=f.crm_attribution.daily.map(r=>({...r,marca:'olivas'}));f.crm_attribution.coverage=[{brand:'olivas',day,checked_at:day+'T13:00:00Z'}];f.crm_conversao=[{marca:'olivas',canal:'email',receita_ultimo:999}];GA.project(f);assert.equal(GA.campaigns(f,'olivas',day,day)[0].receita,100);assert.equal(f.crm_conversao.length,1);assert.equal(f.crm_conversao[0].receita_ultimo,100);assert.equal(GA.coverage(f,'olivas',day,day).complete,true);assert.equal(GA.coverage(f,'todas',day,day).expected,3);assert.equal(GA.coverage(f,'todas',day,day).complete,false);});

test('tracking gaps distinguish missing quality from a measured zero',()=>{
 const f=fixture();assert.equal(GA.coverage(f,'aristo',day,day).lastVisitMissing,null);
 const q={marca:'aristo',dia:day,pagos_elegiveis:10,pagos_com_ultima_sessao:9,pagos_sem_ultima_sessao:1,pagos_sem_origem_nao_direta:2};
 f.crm_attribution.quality=[q];assert.equal(GA.coverage(f,'aristo',day,day).lastVisitMissing,1);
 assert.equal(GA.coverage(f,'aristo',day,day).lastVisitKnown,9);
 q.pagos_sem_ultima_sessao=0;assert.equal(GA.coverage(f,'aristo',day,day).lastVisitMissing,0);
 delete q.pagos_sem_ultima_sessao;assert.equal(GA.coverage(f,'aristo',day,day).lastVisitMissing,null);
});
