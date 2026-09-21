const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{parseHTML}=require('linkedom'),crypto=require('node:crypto').webcrypto;
function setup({mode='ok',storage=new Map()}={}){
 const {document,window}=parseHTML('<html><body><div id="area-partners"></div><div id="area-meta-creators"></div></body></html>');
 let data={influs:[],pilot:{schema:'creator_pilot_v1',programs:[{marca:'fish',rate:0.07,payment_day:5}],candidates:[],sources:[],ads:[],coupon_by_creator:[]}},k='synthetic-area-key',posts=[],locks=false;
 const context=vm.createContext({window,document,crypto,TextEncoder,navigator:{locks:{request:async(_name,_opts,cb)=>{if(locks)return cb(null);locks=true;try{return await cb({});}finally{locks=false;}}}},localStorage:{getItem:x=>storage.get(x)||null,setItem:(x,v)=>storage.set(x,v)},fetch:async(_url,opts)=>{const b=JSON.parse(opts.body);posts.push(b);if(mode==='uncertain'&&b.acao==='piloto_salvar')throw Error('offline');const j=b.acao==='piloto_operacao'?{ok:true,state:'confirmed',receipt:{ok:true,request_id:b.request_id,version:1}}:{ok:true,request_id:b.request_id,version:1};return {ok:true,status:200,json:async()=>j};}});
 vm.runInContext(fs.readFileSync(require.resolve('../creators-meta.js'),'utf8')+'\n'+fs.readFileSync(require.resolve('../creators-pilot-ui.js'),'utf8'),context);
 const api=window.CreatorsPilotUI.bind({document,getData:()=>data,getMarca:()=> 'fish',getPeriod:()=>({fim:'2026-09-20'}),key:()=>k,endpoint:()=> 'https://synthetic.invalid',reload:async()=>{}});api.render();
 return {api,document,storage,posts,drop:()=>{data=null;api.render();},changeKey:()=>k='other-key'};
}
const command={id:'10000000-0000-4000-8000-000000000001',marca:'fish',name:'Synthetic',source:'manual',state:'novo'};
test('pilot entry renders confirmed rules without auto writes and stores no credential or candidate data',async()=>{
 const x=setup();assert.equal(x.posts.length,0);assert.match(x.document.body.textContent,/7%/);assert.match(x.document.body.textContent,/Não liberado/);await x.api.save('candidato',command,0);assert.equal(x.posts.length,1);const text=[...x.storage.values()].join('');assert(!text.includes('synthetic-area-key'));assert(!text.includes('Synthetic'));assert.equal(JSON.parse([...x.storage.values()][0]).phase,'confirmed');
});
test('uncertain response blocks repeated edits and another actor cannot reconcile its receipt',async()=>{
 const x=setup({mode:'uncertain'});await x.api.save('candidato',command,0);await x.api.save('candidato',command,0);assert.equal(x.posts.length,1);assert(x.document.querySelector('[data-pilot-save]').disabled);x.changeKey();await x.api.reconcile();assert.equal(x.posts.length,1);assert.equal(JSON.parse([...x.storage.values()][0]).phase,'uncertain');
});
test('receipt reconciliation reads the original identity without resending the write',async()=>{
 const x=setup({mode:'uncertain'});await x.api.save('candidato',command,0);await x.api.reconcile();assert.deepEqual(x.posts.map(p=>p.acao),['piloto_salvar','piloto_operacao']);assert.equal(x.posts[0].request_id,x.posts[1].request_id);assert.equal(JSON.parse([...x.storage.values()][0]).phase,'confirmed');
});
test('missing current data removes edit controls and blocks direct save during read refresh',async()=>{
 const x=setup();x.drop();assert.equal(x.document.querySelectorAll('[data-pilot-save]').length,0);await x.api.save('candidato',command,0);assert.equal(x.posts.length,0);
});
