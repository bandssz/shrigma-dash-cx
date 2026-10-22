'use strict';
// The installed ordinary editor enters through Públicos, without an order update.
const a=require('node:assert/strict');
async function prove({page,context,origin,brand,row,name,save}){
 const response=await context.request.get(origin+'/api/crm-purchases?'+new URLSearchParams({brand,action:'publics'}));a.equal(response.status(),200);const original=await response.json();a.equal(original.brand,brand);
 await page.goto(origin+'/app/crm/?'+new URLSearchParams({brand,view:'audiences'}),{waitUntil:'domcontentloaded'});await page.locator('#audience-mode-purchases').click();a.equal(new URL(page.url()).pathname,'/app/crm/');a.equal(new URL(page.url()).searchParams.get('audience_mode'),'purchases');
 const root=page.locator('#audience-purchases');await root.locator('[data-purchase-id="count"]:enabled').waitFor({timeout:90000});a.equal(await page.locator('#audience-general').isHidden(),true);
 const proofs=[];for(const[kind,suffix]of [['bought_recently','comprou30'],['not_bought_recently','não comprou30'],['bought_product','produto30']]){
  const title='[QA] Compras21 contínuo · '+brand+' · '+suffix,expected=original.publics.filter(p=>p.name===title);a.equal(expected.length,1);const tr=root.locator('tbody tr').filter({hasText:title});a.equal(await tr.count(),1);await tr.getByRole('button',{name:'Abrir',exact:true}).click();a.equal(await root.locator('[data-purchase-id="name"]').inputValue(),title);a.equal(await root.locator('[data-purchase-id="kind"]').inputValue(),kind);a.equal(await root.locator('[data-purchase-id="days"]').inputValue(),'30');if(kind==='bought_product')a.equal(await root.locator('[data-purchase-id="product"]').inputValue(),expected[0].rule.productId);
  const pending=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/crm-purchases'&&r.request().method()==='POST'&&r.request().postDataJSON().action==='count',{timeout:60000});await root.locator('[data-purchase-id="count"]').click();const r=await pending,value=await r.json();a.equal(r.status(),200);await root.locator('[data-purchase-id="count"]:enabled').waitFor();a.equal(await root.locator('[data-purchase-id="total"]').textContent(),value.confirmed?value.count.toLocaleString('pt-BR')+' pessoas':'—');if(!value.confirmed)a.equal(value.count,null);proofs.push({id:expected[0].id,kind,configured:true,countConfirmed:value.confirmed});
 }
 for(const width of [1440,390]){await page.setViewportSize({width,height:1000});a.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),true);await root.screenshot({path:'/proof/'+name+'-'+brand+'-purchases-'+width+'.png'});}await page.setViewportSize({width:1440,height:1000});
 await page.reload({waitUntil:'domcontentloaded'});await root.locator('[data-purchase-id="count"]:enabled').waitFor({timeout:90000});for(const p of original.publics.filter(p=>proofs.some(x=>x.id===p.id)))a.equal(await root.locator('tbody tr').filter({hasText:p.name}).count(),1);
 const other=brand==='fish'?'aristo':'fish',denied=await context.request.get(origin+'/api/crm-purchases?'+new URLSearchParams({brand:other,action:'publics'}));a.equal(denied.status(),403);
 row.purchases={ok:true,workspace:true,brand,publics:proofs,reload:true,crossBrandDenied:true,backfillPosts:0};row.phases.push('purchase-filters-in-publicos-three-reload');save();
}
module.exports={prove};
