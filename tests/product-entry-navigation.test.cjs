'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {initialProductView,productViewsForAreas}=require('../services/dashboard-operational/public/entry.js');
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
