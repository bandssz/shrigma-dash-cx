const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function boot(entries=[]){const map=new Map(entries),context=vm.createContext({localStorage:{getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v)}});vm.runInContext(fs.readFileSync(path.join(__dirname,'../growth-brand-state.js'),'utf8'),context);return {map,run:s=>vm.runInContext(s,context)};}
test('campaign legacy is copied only to its declared brand and never deletes or changes journals',()=>{
 const old=JSON.stringify({brand:'fish',subject:'Conteúdo preservado',html:'<p>Fish</p>',accidental_key:'not-a-draft-field'}),journal='opaque-operation-do-not-rewrite';
 const x=boot([['shrigma_campaign_composer_v1',old],['shrigma_campaign_operation_v1:fish',journal]]);
 assert.equal(x.run("GBS.campaign('aristo')"),null);
 assert.equal(x.run("GBS.campaign('fish').subject"),'Conteúdo preservado');
 assert.equal(x.run("GBS.campaign('fish').accidental_key"),undefined);
 assert.equal(x.map.get('shrigma_campaign_composer_v1'),old);assert.equal(x.map.get('shrigma_campaign_operation_v1:fish'),journal);
 x.run("GBS.save('campaign','fish',{brand:'fish',subject:'Edição nova'})");
 assert.equal(x.run("GBS.campaign('fish').subject"),'Edição nova');
});
test('Olivas legacy stays recoverable and invalid data is never replaced by a Fish draft',()=>{
 const old=JSON.stringify({brand:'olivas',subject:'Legado'}),x=boot([['shrigma_campaign_composer_v1',old]]);
 assert.equal(x.run("GBS.campaign('fish')"),null);assert.equal(x.run("GBS.campaign('olivas').subject"),'Legado');
 const y=boot([['shrigma_campaign_composer_v1','{invalid']]);assert.throws(()=>y.run("GBS.campaign('fish')"));assert.equal(y.map.get('shrigma_campaign_composer_v1'),'{invalid');
 const key='shrigma_growth_editor_v1:template:fish';y.map.set(key,'{invalid');assert.throws(()=>y.run("GBS.read('template','fish')"));assert.equal(y.map.get(key),'{invalid');
});
test('a detected change from another tab prevents overwriting the opened preparation',()=>{
 const x=boot();x.run("GBS.read('ab','fish');GBS.save('ab','fish',{'f-id':'old'})");
 const key='shrigma_growth_editor_v1:ab:fish',other=JSON.stringify({version:1,area:'ab',brand:'fish',value:{'f-id':'other-tab'}});x.map.set(key,other);
 assert.throws(()=>x.run("GBS.save('ab','fish',{'f-id':'stale'})"),/Outra aba/);assert.equal(x.map.get(key),other);
});
test('a campaign with inconsistent saved brand is retained without relabeling its content',()=>{
 const key='shrigma_growth_editor_v1:campaign:aristo',raw=JSON.stringify({version:1,area:'campaign',brand:'aristo',value:{brand:'fish',subject:'Fish body'}}),x=boot([[key,raw]]);
 assert.throws(()=>x.run("GBS.campaign('aristo')"),/outra marca/);assert.equal(x.map.get(key),raw);
});
