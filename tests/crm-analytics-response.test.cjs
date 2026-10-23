'use strict';
const {test}=require('node:test'),a=require('node:assert/strict');
const M=require(require('node:path').join(process.env.DASHBOARD_ACCESS_TEST_RUNTIME||require('node:path').resolve(__dirname,'../services/dashboard-operational'),'crm-analytics-response.cjs'));
const A=require('../services/dashboard-operational/public/crm-preview/analytics.js');
const checked='2026-10-23T10:00:00Z',days=['2026-10-08','2026-10-09','2026-10-15','2026-10-16'];
function source(brand){
 const row=(dia,model,grain,dimension)=>({marca:brand,dia,model,grain,dimension,pedidos:2,receita:100,assistidos:1,receita_assistida:30,novos:1,recorrentes:1});
 return {brand,brands:[brand],gerado_em:checked,_cache_gerado_em:checked,
  crm_campanha:[],crm_fluxo:[],crm_carrinho:[],crm_wa_envios:[],crm_familia_campanha:[],
  crm_diario:days.map(dia=>({marca:brand,dia,janela:'1d',canal:'email',enviados:10,cliques:2,complaints:0})),
  crm_attribution:{schema_version:2,generated_at:checked,default_model:'last_click',money_basis:'paid',window_days:30,quality:[],coverage:days.map(day=>({brand,day,checked_at:checked})),
   daily:days.flatMap(d=>['last_click','last_non_direct'].flatMap(model=>[
    row(d,model,'channel',['email']),row(d,model,'channel',['whatsapp']),
    row(d,model,'piece',['email','campanha','shared','message','','listmonk']),
    row(d,model,'campaign',['shared']),row(d,model,'campaign_channel',['shared','email']),
    row(d,model,'family',['shared']),row(d,model,'family_channel',['shared','email']),
    row(d,model,'total',['crm'])])),campaigns:[],dispatch_evidence:{schema_version:1,checked_at:checked,daily:[]}},
  _attribution_legacy:{daily:[{unused:true}]},crm_intradia:[{unused:true}],crm_fontes:[{unused:true}]};
}
const relevant=(data,view)=>Object.fromEntries(Object.entries(data).filter(([key])=>
 view==='journeys'||!['flows','carts'].includes(key)));
for(const brand of ['aristo','fish'])test(brand+': consumers preserve calculations, comparison and historical attribution',()=>{
 const full=source(brand);
 a.equal(A.build({[brand]:full},[brand],days[0],days[1],'email').revenueTotal.total,200);
 for(const [consumer,view]of Object.entries(M.CONSUMERS)){
  const dto=M.project(full,consumer),before=JSON.stringify(full);
  a.equal(dto.crm_attribution,full.crm_attribution);a.equal(dto.crm_diario,full.crm_diario);
  for(const model of ['last_click','last_non_direct'])for(const channel of ['email','whatsapp','todos'])for(const [ini,fim]of [['2026-10-15','2026-10-16'],['2026-10-08','2026-10-09'],['2026-11-01','2026-11-02']]){
   const opts={campaignHistory:view!=='journeys'};
   a.deepEqual(relevant(A.build({[brand]:dto},[brand],ini,fim,channel,model,opts),view),relevant(A.build({[brand]:full},[brand],ini,fim,channel,model,opts),view));
   for(const grain of ['peca','familia','campanha'])a.deepEqual(A.conversion({...dto,_attribution_model:model},brand,ini,fim,grain,channel),A.conversion({...full,_attribution_model:model},brand,ini,fim,grain,channel));
   if(view==='results')for(const metric of ['receita','pedidos','enviados','cliques'])a.deepEqual(A.series(dto,brand,ini,fim,metric,channel),A.series(full,brand,ini,fim,metric,channel));
  }
  a.equal(JSON.stringify(full),before);a.equal(dto._attribution_legacy,undefined);a.equal(dto.crm_intradia,undefined);a.deepEqual(dto.capabilities,{read:true,send:false});
 }
});
test('NULLs, duplicate coverage and historical UTM ownership are never rewritten',()=>{
 const full=source('fish');full.crm_attribution.daily[0].receita=null;
 full.crm_attribution.daily.push({...full.crm_attribution.daily[0]});full.crm_attribution.coverage.push({...full.crm_attribution.coverage[0]});
 full.crm_attribution.campaigns=[{marca:'fish',campanha_id:281,utms:[{campaign:'shared'}]},{marca:'fish',campanha_id:282,utms:[{campaign:'shared'}]}];
 const dto=M.project(full,'campaigns-read-v1');a.deepEqual(dto.crm_attribution,full.crm_attribution);
 a.equal(dto.crm_attribution.daily[0].receita,null);a.equal(dto.crm_attribution.coverage.length,5);a.equal(dto.crm_attribution.campaigns.length,2);
 a.deepEqual(A.coverage(dto,'fish',days[0],days[1]),A.coverage(full,'fish',days[0],days[1]));
});
test('unknown consumers and an unscoped envelope cannot be projected',()=>{
 for(const consumer of ['results-read-v1','wrong','__proto__',undefined])a.throws(()=>M.project(source('fish'),consumer),{code:'ANALYTICS_RESPONSE_SCOPE_DENIED'});
 for(const patch of [{brand:'olivas'},{brands:['fish','aristo']},{brands:['aristo']},{brand:null}])a.throws(()=>M.project({...source('fish'),...patch},'results-read-v2'),{code:'ANALYTICS_RESPONSE_SCOPE_DENIED'});
});
test('DTO compression respects refusals and round trips Unicode and unknown metrics',()=>{
 const value={nome:'Jornada · ação',receita:null,rows:Array.from({length:200},()=>({pedidos:2,receita:100}))};
 for(const header of ['gzip','br, gzip;q=1','*;q=1','identity;q=0,gzip']){
  const encoded=M.encode(value,header);a.equal(encoded.encoding,'gzip');a.deepEqual(JSON.parse(require('node:zlib').gunzipSync(encoded.bytes)),value);
 }
 for(const header of ['', 'gzip;q=0','gzip;q=invalid','gzip;q=1,gzip;q=0','*;q=0,identity;q=1']){
  const encoded=M.encode(value,header);a.equal(encoded.encoding,null);a.deepEqual(JSON.parse(encoded.bytes),value);
 }
 for(const header of ['identity;q=0,gzip;q=0','*;q=0','br, identity;q=0'])a.throws(()=>M.encode(value,header),{code:'ANALYTICS_ENCODING_UNAVAILABLE',status:406});
});
