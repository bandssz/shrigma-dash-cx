'use strict';
const a=require('node:assert/strict');
async function find({page,brand,origin,id,name,kind}){
 a(['aristo','fish'].includes(brand));a(['campaign','audience'].includes(kind));a.match(name,/^\[QA\] editor CI ci-[0-9]+-[0-9]+/);
 const audience=kind==='audience',view=audience?'audiences':'campaigns',prefix=audience?'audience':'campaign',list=page.locator('#'+prefix+'-list'),toggle=page.locator('#'+prefix+'-show-tests'),search=page.locator('#'+prefix+'-search');
 await page.goto(origin+'/app/crm/?brand='+brand+'&view='+view,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(prefix=>document.getElementById('loading')?.classList.contains('d-none')&&document.querySelector('#'+prefix+'-list table'),prefix,{timeout:90000});
 a.equal(await toggle.isChecked(),false,'QA_TESTS_MUST_START_HIDDEN');a.equal(await search.inputValue(),'');
 const selector=audience?'[data-audience-detail="'+id+'"]':'[data-open-draft="'+id+'"]';
 a.equal(await list.locator(selector).count(),0,'QA_OBJECT_VISIBLE_WITH_TESTS_HIDDEN');a.equal(await list.getByText(name,{exact:true}).count(),0,'QA_EXACT_NAME_VISIBLE_WITH_TESTS_HIDDEN');await search.fill(name);a.equal(await list.locator(selector).count(),0,'QA_EXACT_SEARCH_MUST_RESPECT_HIDDEN_TESTS');a.equal(await list.getByText(name,{exact:true}).count(),0,'QA_EXACT_NAME_VISIBLE_DURING_HIDDEN_SEARCH');
 await toggle.check();const label=list.getByText(name,{exact:true});await label.waitFor({state:'visible',timeout:90000});a.equal(await label.count(),1,'QA_EXACT_NAME_AMBIGUOUS');const row=list.locator('tr').filter({has:page.getByText(name,{exact:true})});a.equal(await row.count(),1);a.equal(await label.innerText(),name);a.equal(await row.locator(selector).count(),1,'QA_EXACT_NAME_WRONG_ID');
 const opened=page.waitForResponse(r=>{const u=new URL(r.url());return r.request().method()==='GET'&&u.pathname===(audience?'/api/segments':'/api/campaigns')&&u.searchParams.get('acao')===(audience?'segmento_obter':'campanha_obter')&&u.searchParams.get('brand')===brand&&u.searchParams.get('id')===String(id);},{timeout:90000});opened.catch(()=>{});await row.locator(selector).click();const response=await opened;a.equal(response.status(),200);const body=await response.json(),record=audience?body.segment:body.campaign;a.equal(record.id,id);a.equal(audience?record.brand:record.definition.brand,brand);a.equal(audience?record.name:record.definition.name,name);
 const native=require('./editor-native-state.cjs'),expected=native.validateRecord(record,{kind,brand,id,name});await native.waitEditor(page,expected);
 return {hiddenByDefault:true,hiddenDuringExactSearch:true,exactNameHiddenByDefault:true,exactNameHiddenDuringSearch:true,showTestsChecked:true,exactName:name,openedId:id,nativeVersion:record.version,nativeReadConfirmed:true};
}
module.exports={findAudience:options=>find({...options,kind:'audience'}),findCampaign:options=>find({...options,kind:'campaign'})};
