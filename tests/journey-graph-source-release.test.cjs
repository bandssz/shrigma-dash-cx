'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {setup,id}=require('./journey-graph-source-fixture.cjs'),{body,graph}=require('./journey-graph-release-fixture.cjs');
const Release=require('../n8n/growth/journey-graph-release.cjs');
async function prepare(t){const x=await setup();t.after(()=>x.db.close());await x.db.exec('CREATE TABLE templates(id integer PRIMARY KEY,name text,type text,subject text,body text,body_source text);CREATE TABLE shrigma_template_email_registry(template_id integer,brand text);CREATE TABLE shrigma_flow_definition(key text PRIMARY KEY,brand text,runtime_ready boolean,published_version integer,published jsonb);');
 for(const brand of ['fish','aristo']){const tid=brand==='fish'?60:95;const html=body(brand).replace('<p>{{ .price }}','<p>{{ .name }} {{ .qty }} {{ if .variant }}{{ .variant }}{{ end }} {{ .price }}');await x.query('INSERT INTO templates VALUES($1,$2,$3,$4,$5,NULL)',[tid,'Synthetic '+brand,'tx','Seu carrinho',html]);await x.query('INSERT INTO shrigma_template_email_registry VALUES($1,$2)',[tid,brand]);await x.query('INSERT INTO shrigma_flow_definition VALUES($1,$2,true,1,$3)',[brand+':carrinho',brand,graph(brand)]);
  const a={...x.a,cart_id:'synthetic-'+brand,cart_url:'https://'+(brand==='fish'?'fishermans.com.br':'oaristocrata.com')+'/cart/synthetic?utm_source=old',cart_items:[{titulo:'Item sintético',qtd:2,preco:12.3,imagem:'https://cdn.example.invalid/item.png',variante:''}]};await x.query('UPDATE subscribers SET attribs=jsonb_set(attribs,ARRAY[$1],$2::jsonb) WHERE id=1',[brand,JSON.stringify(a)]);
 }
 await x.db.exec(fs.readFileSync(require.resolve('../n8n/growth/journey-graph-release.sql'),'utf8'));return {...x,provider:Release.createReleaseProvider({query:x.query})};
}
test('source→immutable release materialization preserves both brands, complete items and native unsubscribe without sending',async t=>{
 const x=await prepare(t),before=(await x.query('SELECT * FROM templates ORDER BY id')).rows;
 for(const [brand,n]of [['fish',600],['aristo',601]]){const source_ref=await x.capture(brand,id(n)),s=(await x.query('SELECT crm_graph_candidate.release_source_v1($1,$2) result',[brand,brand==='fish'?60:95])).rows[0].result;
  const release=await x.provider.prepare('panel:synthetic',{request_id:id(n+100),brand,binding:s.binding,expected_snapshot:s.source_snapshot});const proof=await x.read(source_ref,brand),built=Release.materialize(release.material,proof,{now:proof.observed_at});
  assert.equal(built.transport,false);assert.equal(built.context.Subscriber.UUID,id(1));assert.equal(built.context.Tx.Data.items[0].variant,'');assert.deepEqual(Object.keys(built.context.Tx.Data.items[0]).sort(),['image','name','price','qty','quantity','title','variant']);assert.equal(new URL(built.context.Tx.Data.checkout_url).searchParams.get('utm_campaign'),brand+'-carrinho');assert.equal(proof.facts['purchase.confirmed'],undefined,'materialization does not invent purchase completeness');
 }
 assert.deepEqual((await x.query('SELECT * FROM templates ORDER BY id')).rows,before);assert.equal((await x.query('SELECT count(*)::int n FROM crm_graph_candidate.entry')).rows[0].n,0);assert.equal((await x.query('SELECT count(*)::int n FROM shrigma_email_dispatch')).rows[0].n,0);assert.equal((await x.query('SELECT enabled FROM crm_graph_candidate.control')).rows[0].enabled,false);
});
test('combined source/release path refuses fresh-looking rereads of stale material and newly revoked consent',async t=>{
 const x=await prepare(t),source_ref=await x.capture(),s=(await x.query('SELECT crm_graph_candidate.release_source_v1($1,$2) result',['fish',60])).rows[0].result;const r=await x.provider.prepare('panel:synthetic',{request_id:id(710),brand:'fish',binding:s.binding,expected_snapshot:s.source_snapshot});
 await x.query("UPDATE crm_graph_candidate.source_observation_v1 SET observed_at=observed_at-interval '10 minutes'");let p=await x.read(source_ref);assert.throws(()=>Release.materialize(r.material,p,{now:p.observed_at}),/GRAPH_RELEASE_/);
 await x.query('UPDATE crm_graph_candidate.source_observation_v1 SET observed_at=$1',[x.now]);await x.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE list_id=17");p=await x.read(source_ref);assert.equal(p.consent,false);assert.throws(()=>Release.materialize(r.material,p,{now:p.observed_at}),/GRAPH_RELEASE_/);assert.equal((await x.query('SELECT count(*)::int n FROM shrigma_email_dispatch')).rows[0].n,0);
});
