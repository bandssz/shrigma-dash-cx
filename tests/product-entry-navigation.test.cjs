'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const runtime=process.env.DASHBOARD_ACCESS_TEST_RUNTIME||require('node:path').resolve(__dirname,'../services/dashboard-operational');
const entry=runtime==='/app/native-backend/runtime'?'/app/presentation-release/public/entry.js':runtime+'/public/entry.compiled.js';
const {initialProductView,productViewsForAreas,crmWorkContext}=require(entry);
test('an explicit Afiliados address cannot silently open Influs',()=>{
 const views=productViewsForAreas(['influs'],['influs']);
 assert.equal(initialProductView('influs','?view=afiliados',views),null);
 assert.equal(initialProductView('influs','?view=unknown',views),null);
 assert.equal(initialProductView('influs','',views).view,'influs');
});
test('an Afiliados-only person opens their own front from the shared host',()=>{
 const views=productViewsForAreas(['influs'],['afiliados']);
 assert.equal(initialProductView('influs','',views).view,'afiliados');
 assert.equal(initialProductView('influs','?view=afiliados',views).view,'afiliados');
 assert.equal(initialProductView('influs','?view=influs',views),null);
});
test('central portal preserves front order and rejects a view from another area',()=>{
 const views=productViewsForAreas(['growth','influs'],['growth','afiliados']);
 assert.equal(initialProductView('todos','',views).view,'growth');
 assert.equal(initialProductView('todos','?view=afiliados',views).view,'afiliados');
 assert.equal(initialProductView('growth','?view=afiliados',views),null);
 assert.equal(initialProductView('organico','',views),null);
});
test('CRM work preference preserves allowed brand, screen and draft without changing account scope',()=>{
 const user={role:'superadmin',brandAccess:'all',brand:null,brands:['fish','aristo'],viewBrands:['fish','aristo','olivas'],permissions:{growth:{read:true}}},before=JSON.stringify(user);
 assert.deepEqual(crmWorkContext('?crmBrand=aristo&crmView=campaigns&crmCampaign=204',user),{brand:'aristo',view:'campaigns',campaign_id:'204'});
 assert.deepEqual(crmWorkContext('?crmBrand=todas&crmView=results',user),{brand:'todas',view:'results'});
 assert.deepEqual(crmWorkContext('?crmBrand=olivas&crmView=home',user),{brand:'olivas',view:'home'});
 assert.equal(JSON.stringify(user),before);
});
test('revoked CRM brand, invalid screen, read withdrawal and malformed draft grant no access',()=>{
 const user={role:'manager',brandAccess:'single',brand:'fish',brands:['fish'],permissions:{growth:{read:true}}};
 for(const q of ['?crmBrand=aristo&crmView=campaigns','?crmBrand=todas&crmView=results','?crmBrand=fish&crmView=admin'])assert.equal(crmWorkContext(q,user),null);
 assert.equal(crmWorkContext('?crmBrand=fish&crmView=home',{...user,permissions:{growth:{read:false}}}),null);
 assert.deepEqual(crmWorkContext('?crmBrand=fish&crmView=campaigns&crmCampaign=0',user),{brand:'fish',view:'campaigns'});
 assert.deepEqual(crmWorkContext('?crmBrand=fish&crmView=campaigns&crmCampaign=204%26brand%3Daristo',user),{brand:'fish',view:'campaigns'});
});
