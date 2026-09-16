const test=require('node:test'),assert=require('node:assert/strict');
const F=require('../growth-freshness'),GA=require('../growth-attribution'),render=require('../frescor');
const {collectionEvidence}=require('../n8n/growth/collection-evidence');
const now=Date.now(),stamp=m=>new Date(now-m*60000).toISOString();
function fixture(){return {crm_diario:[{marca:'fish',coletado_em:stamp(0)}],crm_intradia:[{marca:'olivas',coletado_em:stamp(27*60)}],crm_conversao:[],crm_collection_receipt:[{source:'legacy_conversion',brand:'olivas',checked_at:stamp(5)}],crm_attribution:{schema_version:2,coverage:['fish','aristo'].map(brand=>({brand,day:'2026-09-16',checked_at:stamp(5)})),hourly:[{marca:'fish',dia:'2026-09-16',model:'last_click',receita:100}]}};}
function badge(sources){const el={classList:{toggle(k,on){el.red=on;}}};render({},el,{collections:sources});return el;}
test('old Olivas sale does not imply a stopped collection; v2 uses real receipts',()=>{const f=fixture();GA.project(f);const el=badge(F.sources(f));assert.equal(el.red,false);assert(!el.textContent.includes('27 h'));assert(el.title.includes('Atribuição · Fishermans'));assert.equal(f.crm_intradia.find(r=>r.marca==='fish').coletado_em,stamp(5));});
test('no sales can still have a successful collection, without adding fake sales',()=>{const f=fixture();f.crm_intradia=[];f.crm_attribution.hourly=[];GA.project(f);assert.equal(badge(F.sources(f)).red,false);assert.equal(f.crm_intradia.length,0);assert.equal(f.crm_conversao.length,0);});
test('a fresh email source cannot conceal a stale attribution collection',()=>{const f=fixture();f.crm_attribution.coverage[0].checked_at=stamp(28*60);const el=badge(F.sources(f));assert.equal(el.red,true);assert.match(el.textContent,/Fishermans sem atualização há 28 h/);});
test('brand selection isolates alerts; all brands still includes a real Olivas delay',()=>{const f=fixture();f.crm_collection_receipt[0].checked_at=stamp(28*60);assert.equal(badge(F.sources(f,'fish')).red,false);assert.match(badge(F.sources(f,'todas')).textContent,/Olivas do Campo sem atualização/);});
test('missing coverage never borrows API generation time or another brand receipt',()=>{const f=fixture();f.gerado_em=stamp(0);f.crm_attribution.generated_at=stamp(0);f.crm_attribution.coverage=[];assert.equal(badge(F.sources(f,'aristo')).red,true);assert.match(badge(F.sources(f,'aristo')).textContent,/sem confirmação/);});
test('a legacy sale timestamp alone is not proof of a successful source read',()=>{const f=fixture();f.crm_collection_receipt=[];assert.match(badge(F.sources(f,'olivas')).textContent,/sem confirmação/);});
test('source receipts accept empty orders but reject partial GraphQL or pagination',()=>{
 const page={data:{orders:{nodes:[],pageInfo:{hasNextPage:false}}}},pages={fish:[page],aristo:[page],olivas:[page]};
 assert(collectionEvidence(pages,stamp(0),'fixture').every(e=>e.complete));
 for(const broken of [[],[{...page,errors:[{message:'partial'}]}],[{data:{orders:{nodes:[],pageInfo:{hasNextPage:true}}}}]]){
  assert.equal(collectionEvidence({...pages,olivas:broken},stamp(0),'fixture')[2].complete,false);
 }
});
test('shared legacy badge compares absolute instants rather than timestamp strings',()=>{const el={classList:{toggle(k,v){el.red=v;}}};const t=new Date(now-60000);render({rows:[{coletado_em:'invalid'},{coletado_em:t.toISOString()}]},el);assert.equal(el.red,false);assert.match(el.textContent,/1 min/);});
