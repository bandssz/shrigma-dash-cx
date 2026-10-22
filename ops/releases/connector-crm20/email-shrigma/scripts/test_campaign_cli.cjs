const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {prepare}=require('./campaign_cli.cjs'),C=require('./lib/campaign-contract'),T=require('./lib/campaign-tracking');
const now=Date.now(),read_at=new Date(now).toISOString();
const d={schema_version:C.VERSION,brand:'aristo',channel:'email',initiative:{key:'iniciativa-teste',name:'Teste local'},utm_campaign:'aristo-teste',name:'Teste local',subject:'Conteúdo sintético',from_email:'O Aristocrata <contato@oaristocrata.com>',reply_to:'contato@oaristocrata.com',list_ids:[123],template_id:1,html:'<a href=\'{{ TrackLink "https://oaristocrata.com/products/kit?variant=10&utm_content=teste-cta1" }}\'>Kit</a> {{ UnsubscribeURL }} {{ TrackView }}',text:'https://oaristocrata.com/products/kit?variant=10&utm_content=teste-texto\n{{ UnsubscribeURL }}',tags:[],send_at:null};
const snapshot={read_at,brand:'aristo',campaign:{id:987,status:'draft',sent:0,started_at:null,updated_at:read_at,lists:[{id:123}]}};
const catalog={read_at,brand:'aristo',current:true,lists:[{id:123,brand:'aristo',available:true}],templates:[{id:1,type:'campaign',available:true}],initiatives:[]};
test('prepares HTML and text with native ID and keeps exact offer routing',()=>{const r=prepare(d,snapshot,catalog,now);assert.match(r.definition.html,/variant=10/);assert.match(r.definition.html,/lm-987-l123/);assert.match(r.definition.text,/lm-987-l123/);assert.equal(r.manifest.remote_saved,false);assert.equal(r.manifest.scheduled,false);assert.deepEqual(prepare(r.definition,snapshot,catalog,now).definition,r.definition);});
test('stale snapshots, started campaigns and mismatched lists cannot prepare',()=>{assert.throws(()=>prepare(d,{...snapshot,read_at:'2020-01-01T00:00:00Z'},catalog,now));assert.throws(()=>prepare(d,{...snapshot,campaign:{...snapshot.campaign,status:'running'}},catalog,now));assert.throws(()=>prepare(d,{...snapshot,campaign:{...snapshot.campaign,lists:[456]}},catalog,now));});
test('shorthand TrackLink survives URL rewriting and repeated preparation',()=>{const x={...d,html:'<a href="https://oaristocrata.com/products/kit?variant=10@TrackLink">Kit</a> {{ UnsubscribeURL }}'};const r=prepare(x,snapshot,catalog,now);assert.match(r.definition.html,/utm_term=lm-987-l123@TrackLink"/);assert(!r.definition.html.includes('%40TrackLink'));assert.deepEqual(prepare(r.definition,snapshot,catalog,now).definition,r.definition);});
test('CLI writes only a new local review directory and refuses overwrite',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'shrigma-skill-test-'));try{for(const [n,v] of Object.entries({d,snapshot,catalog}))fs.writeFileSync(path.join(dir,n+'.json'),JSON.stringify(v));const args=['prepare',path.join(dir,'d.json'),'--snapshot',path.join(dir,'snapshot.json'),'--catalog',path.join(dir,'catalog.json'),'--out-dir',path.join(dir,'out')],r=spawnSync(process.execPath,[path.join(__dirname,'campaign_cli.cjs'),...args],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);const manifest=JSON.parse(fs.readFileSync(path.join(dir,'out/tracking-manifest.json')));assert.equal(manifest.campaign_id,987);assert.equal(manifest.remote_saved,false);const r2=spawnSync(process.execPath,[path.join(__dirname,'campaign_cli.cjs'),...args],{encoding:'utf8'});assert.equal(r2.status,1);assert.equal(fs.readdirSync(path.join(dir,'out')).length,4);}finally{fs.rmSync(dir,{recursive:true,force:true});}});
test('cloning preserves only the variant and reports a missing initiative mapping',()=>{
 const x={...d,text:d.text.replace('utm_content=teste-texto','utm_content=teste-texto&utm_term=a--lm-100-l10')};const r=prepare(x,snapshot,catalog,now);
 assert.match(r.definition.text,/utm_term=a--lm-987-l123/);assert(!r.definition.text.includes('lm-100-l10'));assert.equal(r.manifest.initiative_mapping,'pending_registration');
 const mapped=prepare(x,snapshot,{...catalog,initiatives:[{key:d.initiative.key,utm_campaign:d.utm_campaign}]},now);assert.equal(mapped.manifest.initiative_mapping,'confirmed_in_supplied_catalog');
});
test('both brands roundtrip through the shared contract without carrying remote identity',()=>{
 for(const brand of ['aristo','fish']){
  const domain=C.BRANDS[brand],def={...d,brand,from_email:`Equipe <contato@${domain}>`,reply_to:`contato@${domain}`,utm_campaign:`${brand}-teste`,html:d.html.replaceAll('oaristocrata.com',domain),text:d.text.replaceAll('oaristocrata.com',domain)};
  const r=prepare(def,{...snapshot,brand},{...catalog,brand,lists:[{id:123,brand,available:true}]},now);
  const roundtrip=C.normalize(JSON.parse(JSON.stringify({...r.definition,id:999,version:'not-content',idempotency_key:'not-content',access_key:'synthetic'})));
  assert.deepEqual(roundtrip,r.definition);assert.equal(roundtrip.brand,brand);assert(!Object.hasOwn(roundtrip,'id'));assert(!Object.hasOwn(roundtrip,'access_key'));
  assert.match(roundtrip.html,new RegExp(domain.replaceAll('.','\\.')));assert.equal(r.manifest.remote_saved,false);
 }
});
test('cross-brand snapshot/catalog and out-of-scope brand cannot prepare',()=>{
 assert.throws(()=>prepare(d,{...snapshot,brand:'fish'},catalog,now),/Snapshot/);
 assert.throws(()=>prepare(d,snapshot,{...catalog,brand:'fish'},now),/catálogo/);
 assert.throws(()=>prepare({...d,brand:'olivas'},{...snapshot,brand:'olivas'},catalog,now),/somente/);
 assert.throws(()=>prepare(d,{...snapshot,campaign:{...snapshot.campaign,started_at:undefined}},catalog,now),/rascunho/);
});
test('CLI rejects out-of-scope brands and files larger than the panel limit',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'shrigma-skill-limits-'));
 try{
  const file=path.join(dir,'input.json');
  fs.writeFileSync(file,JSON.stringify({...d,brand:'olivas'}));
  let r=spawnSync(process.execPath,[path.join(__dirname,'campaign_cli.cjs'),'normalize',file],{encoding:'utf8'});assert.equal(r.status,1);assert.match(r.stderr,/somente/);
  fs.writeFileSync(file,' '.repeat(800001));
  r=spawnSync(process.execPath,[path.join(__dirname,'campaign_cli.cjs'),'normalize',file],{encoding:'utf8'});assert.equal(r.status,1);assert.match(r.stderr,/800000 bytes/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('prepared output respects panel UTF-8 byte limit and shared module provenance',()=>{
 assert.throws(()=>prepare({...d,html:d.html+'漢'.repeat(298000)},snapshot,catalog,now),/800 KB/);
 const crypto=require('node:crypto'),manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'lib/source.json')));
 for(const [name,entry] of Object.entries(manifest.files)){const digest=crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,'lib',name))).digest('hex');assert.equal(digest,entry.sha256);}
});
