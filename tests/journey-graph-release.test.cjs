'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite'),R=require('../n8n/growth/journey-graph-release.cjs');
const sql=fs.readFileSync(require.resolve('../n8n/growth/journey-graph-release.sql'),'utf8'),id=n=>'20000000-0000-4000-8000-'+String(n).padStart(12,'0'),copy=x=>JSON.parse(JSON.stringify(x)),T='2026-09-26T12:00:00.000Z';
const {install,proof}=require('./journey-graph-release-fixture.cjs');
async function setup(t){const db=new PGlite();t.after(()=>db.close());return install(db);}
test('both current cart shapes bind actual fields, native unsubscribe and exact sender/tracking without native writes',async t=>{
 const f=await setup(t),before=(await f.query('SELECT * FROM templates ORDER BY id')).rows;
 for(const b of ['fish','aristo']){const p=await f.request(b),r=await f.provider.prepare('panel:synthetic',p),m=r.material;assert.deepEqual(m.required_fields,['cart.checkout_url','cart.items']);assert.deepEqual(m.required_identity,['subject_id']);assert.equal(m.variables['.Subscriber.UUID'].path,'subject_id');assert.equal(m.variables['.Tx.Data.preheader'].value,'Resumo de exemplo');assert.equal(m.readiness.transport,false);if(b==='aristo')assert.deepEqual(m.variables['.Tx.Data.order_number'],{kind:'template_default',value:'iniciada'});
  const built=R.materialize(m,proof(b),{now:T});assert.equal(built.context.Subscriber.UUID,id(300));assert.equal(built.context.Tx.Data.items[0].price,'R$ 10,00');assert.equal(built.transport,false);assert.match(built.from_email,new RegExp(b==='fish'?'@fishermans.com.br':'@oaristocrata.com'));
  const url=new URL(built.context.Tx.Data.checkout_url);assert.deepEqual(url.searchParams.getAll('utm_source'),['email']);assert.equal(url.searchParams.get('discount'),'SYNTHETIC');assert.equal(url.searchParams.get('utm_campaign'),b+'-carrinho');assert.equal(url.searchParams.get('utm_content'),'carrinho-30min');
 }
 assert.deepEqual((await f.query('SELECT * FROM templates ORDER BY id')).rows,before);assert.equal((await f.query('SELECT count(*)::int n FROM crm_graph_candidate.message_release_v1')).rows[0].n,2);
});
test('request replay is exact, immutable snapshots survive native edits and later preparations use a new content hash',async t=>{
 const f=await setup(t),p=await f.request(),r=await f.provider.prepare('panel:synthetic',p);assert.deepEqual(await f.provider.prepare('panel:synthetic',p),r);await assert.rejects(f.provider.prepare('panel:another',p),/REPLAY_MISMATCH/);
 await f.query('UPDATE templates SET subject=$1 WHERE id=60',['Revisão nova']);assert.deepEqual(await f.provider.prepare('panel:synthetic',p),r);const next=await f.provider.prepare('panel:synthetic',await f.request());assert.notEqual(next.id,r.id);assert.notEqual(next.material_sha256,r.material_sha256);assert.equal((await f.provider.read('fish',r.id)).material.native.subject,'Seu carrinho');await assert.rejects(f.provider.read('aristo',r.id),/NOT_FOUND/);
 for(const q of ['UPDATE crm_graph_candidate.message_release_v1 SET actor=actor','DELETE FROM crm_graph_candidate.message_release_v1','DELETE FROM crm_graph_candidate.message_release_request_v1'])await assert.rejects(f.db.exec(q),/IMMUTABLE/);
});
test('same material coalesces releases while preserving separate operation receipts',async t=>{
 const f=await setup(t),a=await f.provider.prepare('panel:synthetic',await f.request()),b=await f.provider.prepare('panel:synthetic',await f.request());assert.equal(a.id,b.id);assert.equal((await f.query('SELECT count(*)::int n FROM crm_graph_candidate.message_release_request_v1')).rows[0].n,2);
});
test('source changes between planning and transaction, wrong slots and ambiguous brands fail without a release',async t=>{
 const f=await setup(t),s=await f.source('fish'),p=await f.request(),m=R.prepareMaterial(s);await f.query('UPDATE templates SET subject=$1 WHERE id=60',['Mudou']);await assert.rejects(f.query('SELECT crm_graph_candidate.release_prepare_v1($1,$2,$3,$4)',['panel:synthetic',p,s,m]),/SOURCE_CHANGED/);
 await f.query("INSERT INTO shrigma_template_email_registry VALUES(60,'aristo')");await assert.rejects(f.source('fish'),/TEMPLATE_UNAVAILABLE/);await f.query("DELETE FROM shrigma_template_email_registry WHERE template_id=60 AND brand='aristo'");await f.query("UPDATE shrigma_flow_definition SET published=jsonb_set(published,'{steps,0,enabled}','false') WHERE brand='fish'");await assert.rejects(f.source('fish'),/SLOT_UNAVAILABLE/);assert.equal((await f.query('SELECT count(*)::int n FROM crm_graph_candidate.message_release_v1')).rows[0].n,0);
});
test('unknown variables, unsafe content, unproven default or unsubscribe and cross-brand content are rejected',async t=>{
 const f=await setup(t),s=await f.source('aristo');
 for(const [edit,code]of [
  [x=>x.native.body=x.native.body.replace('iniciada','iniciada')+'{{ .Tx.Data.tracking_url }}','VARIABLE_UNSUPPORTED'],
  [x=>x.native.body=x.native.body.replace('{{ default "iniciada" .Tx.Data.order_number }}','{{ .Tx.Data.order_number }}'),'VARIABLE_UNSUPPORTED'],
  [x=>x.native.body=x.native.body.replace('{{ default "iniciada" .Tx.Data.order_number }}','{{ if .Tx.Data.order_number }}Pedido{{ end }}'),'VARIABLE_UNSUPPORTED'],
  [x=>x.native.body+='<script>alert(1)</script>','CONTENT_INVALID'],
  [x=>x.native.body=x.native.body.replace('email.shrigma.com.br','example.invalid'),'UNSUBSCRIBE_REQUIRED'],
  [x=>x.native.body+='<a href="https://fishermans.com.br">Marca errada</a>','CROSS_BRAND'],
  [x=>x.native.body+='<a href="https://fishermans&#46;com.br">Marca errada</a>','CROSS_BRAND'],
  [x=>x.native.subject='Olá {{ .Tx.Data.first_name }}','SUBJECT_DYNAMIC']]){const x=copy(s);edit(x);assert.throws(()=>R.prepareMaterial(x),new RegExp(code));}
});
test('materialization fails closed on optout, missing or stale facts, malformed items, wrong identity/brand and forged release fields',async t=>{
 const f=await setup(t),m=R.prepareMaterial(await f.source('fish'));
 for(const edit of [x=>x.brand='aristo',x=>x.consent=false,x=>x.suppressed=true,x=>x.complete=false,x=>x.subject_id='',x=>delete x.facts['cart.items'],x=>x.facts['cart.items'].complete=false,x=>x.facts['cart.items'].observed_at='2026-09-26T11:00:00Z',x=>delete x.facts['cart.items'].value[0].image,x=>x.facts['cart.items'].value[0].quantity='1',x=>x.facts['cart.items'].value[0].quantity=0,x=>x.facts['cart.checkout_url'].value='https://oaristocrata.com/cart/a',x=>x.facts['cart.checkout_url'].value='javascript:alert(1)']){const s=proof();edit(s);assert.throws(()=>R.materialize(m,s,{now:T}),/GRAPH_RELEASE_/);}
 const altered=copy(m);altered.envelope.reply_to='attacker@example.invalid';assert.throws(()=>R.materialize(altered,proof(),{now:T}),/GRAPH_RELEASE_INVALID/);
});
test('receipt failure rolls back the release and candidate installation has no public grants or native triggers',async t=>{
 const f=await setup(t),p=await f.request();await f.db.exec("CREATE FUNCTION crm_graph_candidate.test_fault() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic receipt failure';END$$;CREATE TRIGGER fail_receipt BEFORE INSERT ON crm_graph_candidate.message_release_request_v1 FOR EACH ROW EXECUTE FUNCTION crm_graph_candidate.test_fault();");await assert.rejects(f.provider.prepare('panel:synthetic',p),/synthetic receipt failure/);assert.equal((await f.query('SELECT count(*)::int n FROM crm_graph_candidate.message_release_v1')).rows[0].n,0);
 await assert.rejects(f.db.exec(sql),/COLLISION/);assert.equal((await f.query('SELECT 1 ok')).rows[0].ok,1);const grants=(await f.query("SELECT count(*)::int n FROM pg_proc p, LATERAL aclexplode(p.proacl)a WHERE p.pronamespace='crm_graph_candidate'::regnamespace AND p.proname LIKE 'release_%' AND a.grantee=0 AND a.privilege_type='EXECUTE'")).rows[0].n;assert.equal(grants,0);assert.equal((await f.query("SELECT count(*)::int n FROM pg_trigger WHERE tgrelid='templates'::regclass AND NOT tgisinternal")).rows[0].n,0);
});

test('explicitly empty optional item text remains known; missing item keys are never filled from defaults',async t=>{
 const f=await setup(t),s=await f.source('fish');s.native.body=s.native.body.replace('<p>{{ .price }}', '<p>{{ if .variant }}{{ .variant }}{{ end }}{{ .price }}');const m=R.prepareMaterial(s),p=proof();p.facts['cart.items'].value[0].variant='';
 assert.equal(R.materialize(m,p,{now:T}).context.Tx.Data.items[0].variant,'');delete p.facts['cart.items'].value[0].variant;assert.throws(()=>R.materialize(m,p,{now:T}),/ITEM_FIELD_MISSING/);
});
