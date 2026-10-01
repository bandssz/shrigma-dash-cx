'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {buildRfmEvidence}=require('../n8n/growth/segment-shopify-rfm-evidence.cjs'),{createWorker}=require('../services/crm-shopify-sync/worker.cjs');
const {fixture,replaceOrders}=require('./segment-shopify-rfm-evidence-fixture.cjs');
test('R/F/M use the same GID-linked paid export with exact decimal sum and transient resolvable-email digests only',()=>{
 for(const brand of ['fish','aristo']){const input=fixture(brand),out=buildRfmEvidence(input);assert.equal(out.meta.brand,brand);assert.equal(out.customers[0].paid_orders,4);assert.equal(out.customers[1].paid_orders,1);assert.equal(out.customers[0].amount_spent,'4000000000000000000.00400');assert.equal(out.customers[0].identity_email_sha256,crypto.createHash('sha256').update('person1@example.test').digest('hex'));assert.deepEqual(out.customers[2],{customer_gid:'gid://shopify/Customer/3',paid_orders:0,amount_spent:'0',last_paid_order_at:null,identity_email_sha256:null});assert.equal(out.counts.paid_orders,5);assert.equal(out.meta.paid_orders_payload_sha256,crypto.createHash('sha256').update(input.paidOrdersJsonl).digest('hex'));const serialized=JSON.stringify(out);assert.equal(serialized.includes('@'),false);assert.equal(serialized.includes('person1'),false);assert.equal(serialized.includes('private-download'),false);}
});
test('null or duplicate Customer email produces no identity digest without changing the four RFM inputs',()=>{
 const x=fixture(),rows=x.customerJsonl.trimEnd().split('\n').map(JSON.parse);rows[1].email=rows[0].email;rows[1].defaultEmailAddress={emailAddress:rows[0].email};x.customerJsonl=rows.map(JSON.stringify).join('\n')+'\n';const op=x.customerOperation.data.node;op.objectCount=String(rows.length);op.fileSize=String(Buffer.byteLength(x.customerJsonl));
 const out=buildRfmEvidence(x);assert.equal(out.customers[0].identity_email_sha256,null);assert.equal(out.customers[1].identity_email_sha256,null);assert.equal(out.customers[2].identity_email_sha256,null);for(const row of out.customers)assert.deepEqual(Object.keys(row).filter(k=>k!=='identity_email_sha256').sort(),['amount_spent','customer_gid','last_paid_order_at','paid_orders']);assert.equal(JSON.stringify(out).includes('@'),false);
});
test('history and exact query pins refuse a sixty-day export, partial data, scope drift or a different shop',()=>{
 const changes=[v=>v.paidOrdersOperation.data.node.query+=' # created_at:>=2026-08-01',v=>v.paidOrdersOperation.data.node.partialDataUrl='https://partial.invalid',v=>v.paidOrdersOperation.data.currentAppInstallation.accessScopes=v.paidOrdersOperation.data.currentAppInstallation.accessScopes.filter(x=>x.handle!=='read_all_orders'),v=>v.paidOrdersOperation.data.shop.id='gid://shopify/Shop/999'];
 for(const change of changes){const x=fixture();change(x);assert.throws(()=>buildRfmEvidence(x),/RFM_EXPORT_/);}
});
test('duplicate order, non-paid status, unknown Customer and orphan item cannot produce a false zero',()=>{
 for(const change of [rows=>rows.push({...rows[0]}),rows=>rows[0].displayFinancialStatus='PARTIALLY_REFUNDED',rows=>rows[0].customer.id='gid://shopify/Customer/999',rows=>rows[1].__parentId='gid://shopify/Order/999']){const x=fixture(),rows=x.paidOrdersJsonl.trimEnd().split('\n').map(JSON.parse);change(rows);replaceOrders(x,rows);assert.throws(()=>buildRfmEvidence(x),/RFM_EXPORT_/);}
});
test('download truncation, invalid bytes, counts, chronology and expired pair are rejected',()=>{
 for(const change of [v=>v.paidOrdersJsonl=v.paidOrdersJsonl.slice(0,-2),v=>v.paidOrdersOperation.data.node.objectCount='999',v=>v.paidOrdersOperation.data.node.createdAt=v.customerOperation.data.node.createdAt,v=>v.paidOrdersOperation.data.node.completedAt='2026-02-30T00:00:00.000Z',v=>v.observedAt=new Date(Date.parse(v.customerOperation.data.node.createdAt)+27*3600000).toISOString(),v=>{v.paidOrdersJsonl+='\ud800';v.paidOrdersOperation.data.node.fileSize=String(Buffer.byteLength(v.paidOrdersJsonl));}]){const x=fixture();change(x);assert.throws(()=>buildRfmEvidence(x),/RFM_EXPORT_/);}
});
test('fully reconciled empty paid history yields known zero; order with deleted customer stays unassigned',()=>{
 const x=fixture();replaceOrders(x,[]);const empty=buildRfmEvidence(x);assert.equal(empty.customers.every(c=>c.paid_orders===0&&c.last_paid_order_at===null),true);
 replaceOrders(x,[{id:'gid://shopify/Order/11',createdAt:'2025-01-02T00:00:00.000Z',displayFinancialStatus:'PAID',customer:null,currentTotalPriceSet:{shopMoney:{amount:'10.00',currencyCode:'BRL'}}}]);assert.equal(buildRfmEvidence(x).counts.unassigned_orders,1);
});
test('existing isolated collector worker reads each file once; product path remains the default',async()=>{
 const x=fixture(),seen=[],files=new Map([['customers.jsonl',Buffer.from(x.customerJsonl)],['paid-orders.jsonl',Buffer.from(x.paidOrdersJsonl)]]),worker=createWorker({rfmRevision:'1234567',readFile:async()=>{throw Error('WHOLE_FILE_READ_FORBIDDEN');},readStream:async function*(file,options){seen.push(file);assert.equal(options.highWaterMark,64*1024);const bytes=files.get(file);for(let i=0;i<bytes.length;i+=17)yield bytes.subarray(i,i+17);}}),input={...x};delete input.customerJsonl;delete input.paidOrdersJsonl;
 assert.equal(worker.productSemantics,'v1');const out=await worker.parseRfm({customerFile:'customers.jsonl',paidOrdersFile:'paid-orders.jsonl',input});assert.deepEqual(seen,['customers.jsonl','paid-orders.jsonl']);assert.deepEqual(out,buildRfmEvidence(x));await assert.rejects(worker.parseRfm({customerFile:'customers.jsonl',paidOrdersFile:'customers.jsonl',input}),/WORKER_INPUT/);
});
test('Customer stream keeps duplicate identity ambiguity across the 1000-row batch boundary',async()=>{
 const x=fixture(),base=JSON.parse(x.customerJsonl.split('\n')[0]),rows=Array.from({length:1001},(_,i)=>({...structuredClone(base),id:`gid://shopify/Customer/${i+1}`,email:`person${i+1}@example.test`,defaultEmailAddress:{emailAddress:`person${i+1}@example.test`},numberOfOrders:'0',amountSpent:{amount:'0.00',currencyCode:'BRL'}}));rows.at(-1).email=rows[0].email;rows.at(-1).defaultEmailAddress={emailAddress:rows[0].email};x.customerJsonl=rows.map(JSON.stringify).join('\n')+'\n';const node=x.customerOperation.data.node;node.objectCount=node.rootObjectCount=String(rows.length);node.fileSize=String(Buffer.byteLength(x.customerJsonl));replaceOrders(x,[]);
 const files=new Map([['c',Buffer.from(x.customerJsonl)],['o',Buffer.from(x.paidOrdersJsonl)]]),worker=createWorker({rfmRevision:'1234567',readStream:async function*(file){const bytes=files.get(file);for(let i=0;i<bytes.length;i+=997)yield bytes.subarray(i,i+997);}}),input={...x};delete input.customerJsonl;delete input.paidOrdersJsonl;const out=await worker.parseRfm({customerFile:'c',paidOrdersFile:'o',input});assert.equal(out.customers.length,1001);assert.equal(out.customers[0].identity_email_sha256,null);assert.equal(out.customers.at(-1).identity_email_sha256,null);assert.equal(out.customers[1].identity_email_sha256,crypto.createHash('sha256').update('person2@example.test').digest('hex'));assert.equal(JSON.stringify(out).includes('@'),false);
 rows.at(-1).id=rows[0].id;x.customerJsonl=rows.map(JSON.stringify).join('\n')+'\n';node.fileSize=String(Buffer.byteLength(x.customerJsonl));files.set('c',Buffer.from(x.customerJsonl));await assert.rejects(worker.parseRfm({customerFile:'c',paidOrdersFile:'o',input}),/SHOPIFY_CUSTOMER_GID_DUPLICATE/);
});
test('Customer stream preserves UTF-8 split boundaries and permits an exact zero-byte export',async()=>{
 let x=fixture(),rows=x.customerJsonl.trimEnd().split('\n').map(JSON.parse);rows[0].firstName='Árvore';x.customerJsonl=rows.map(JSON.stringify).join('\n')+'\n';x.customerOperation.data.node.fileSize=String(Buffer.byteLength(x.customerJsonl));let files=new Map([['c',Buffer.from(x.customerJsonl)],['o',Buffer.from(x.paidOrdersJsonl)]]),worker=createWorker({rfmRevision:'1234567',readStream:async function*(file){const bytes=files.get(file);for(let i=0;i<bytes.length;i++)yield bytes.subarray(i,i+1);}}),input={...x};delete input.customerJsonl;delete input.paidOrdersJsonl;assert.deepEqual(await worker.parseRfm({customerFile:'c',paidOrdersFile:'o',input}),buildRfmEvidence(x));
 x=fixture();x.customerJsonl='';Object.assign(x.customerOperation.data.node,{objectCount:'0',rootObjectCount:'0',fileSize:'0',url:null});replaceOrders(x,[]);files=new Map([['c',Buffer.alloc(0)],['o',Buffer.alloc(0)]]);worker=createWorker({rfmRevision:'1234567',readStream:async function*(file){yield* [files.get(file)].filter(b=>b.length);}});input={...x};delete input.customerJsonl;delete input.paidOrdersJsonl;const empty=await worker.parseRfm({customerFile:'c',paidOrdersFile:'o',input});assert.deepEqual([empty.customers.length,empty.counts.customers,empty.counts.bytes],[0,0,0]);
});
test('Customer streaming rejects fatal UTF-8, truncation and count mismatch before reading paid orders',async()=>{
 for(const mode of ['utf8','truncated','count']){const x=fixture(),full=Buffer.from(x.customerJsonl),customer=mode==='utf8'?Buffer.from([0xc3,0x28]):mode==='truncated'?full.subarray(0,-1):full;if(mode==='utf8'){x.customerOperation.data.node.fileSize='2';x.customerOperation.data.node.objectCount=x.customerOperation.data.node.rootObjectCount='1';}if(mode==='count')x.customerOperation.data.node.objectCount=x.customerOperation.data.node.rootObjectCount='4';let orderReads=0;const worker=createWorker({rfmRevision:'1234567',readStream:async function*(file){if(file==='o')orderReads++;else yield customer;}}),input={...x};delete input.customerJsonl;delete input.paidOrdersJsonl;await assert.rejects(worker.parseRfm({customerFile:'c',paidOrdersFile:'o',input}),/RFM_EXPORT_|SHOPIFY_/);assert.equal(orderReads,0);}
});
test('RFM consumer defaults OFF and requires the pinned producer revision before file access',async()=>{
 let reads=0;const readFile=async()=>{reads++;throw Error('MUST_NOT_READ');};const args={customerFile:'c',paidOrdersFile:'p',input:{producerRevision:'7654321'}};
 await assert.rejects(createWorker({readFile}).parseRfm(args),/CRM_SHOPIFY_RFM_DISABLED/);await assert.rejects(createWorker({readFile,rfmRevision:'1234567'}).parseRfm(args),/CRM_SHOPIFY_WORKER_INPUT/);assert.equal(reads,0);
});
test('strict streaming rejects original invalid UTF-8 and escaped surrogate IDs before SQL',async()=>{
 const E=require('../n8n/growth/segment-shopify-rfm-evidence.cjs'),x=fixture();assert.throws(()=>E.decodeBytes(Buffer.from([0xc3,0x28])),/RFM_EXPORT_UTF8/);
 let state=E.prepareRfmEvidence(x);await assert.rejects(E.consumePaidOrdersStream(state,(async function*(){yield Buffer.from([0xc3,0x28]);})()),/RFM_EXPORT_UTF8/);
 const rows=x.paidOrdersJsonl.trimEnd().split('\n').map(JSON.parse);rows[0].customer.id='gid://shopify/Customer/1\ud800';replaceOrders(x,rows);assert.throws(()=>buildRfmEvidence(x),/RFM_EXPORT_CUSTOMER/);
});
test('shop field order is immaterial; nanosecond chronology and currency remain strict',()=>{
 let x=fixture();x.paidOrdersOperation.data.shop=Object.fromEntries(Object.entries(x.paidOrdersOperation.data.shop).reverse());assert.equal(buildRfmEvidence(x).customers.length,3);
 x=fixture();x.customerOperation.data.node.completedAt=x.customerOperation.data.node.completedAt.slice(0,19)+'.000000002Z';x.paidOrdersOperation.data.node.createdAt=x.customerOperation.data.node.completedAt.slice(0,19)+'.000000001Z';assert.throws(()=>buildRfmEvidence(x),/RFM_EXPORT_SEQUENCE/);
 x=fixture();const rows=x.paidOrdersJsonl.trimEnd().split('\n').map(JSON.parse);rows[0].currentTotalPriceSet.shopMoney.currencyCode='USD';replaceOrders(x,rows);assert.throws(()=>buildRfmEvidence(x),/RFM_EXPORT_MONEY/);
});
test('immutable module seals reject cached algorithm or query bytes replaced in the same process',t=>{
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'rfm-module-seal-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 const files=['segment-shopify-rfm-evidence.cjs','segment-shopify-rfm.cjs','segment-shopify-bulk-evidence.cjs','segment-audience-review.cjs','segment-audience-contract.js','segment-shopify-customer-bulk.graphql','segment-shopify-rfm-paid-orders-bulk.graphql'];
 for(const scenario of ['query-replaced-after-load','algorithm-cached-before-replacement']){
  const directory=path.join(temporary,scenario);fs.mkdirSync(directory);for(const file of files)fs.copyFileSync(path.join(__dirname,'../n8n/growth',file),path.join(directory,file));
  const script=`const fs=require('fs'),path=require('path'),assert=require('assert/strict'),root=process.argv[1],scenario=process.argv[2];if(scenario==='algorithm-cached-before-replacement'){require(path.join(root,'segment-shopify-rfm.cjs'));fs.appendFileSync(path.join(root,'segment-shopify-rfm.cjs'),'\\n');}const E=require(path.join(root,'segment-shopify-rfm-evidence.cjs'));if(scenario==='query-replaced-after-load'){E.assertSourceSeal();fs.appendFileSync(path.join(root,'segment-shopify-rfm-paid-orders-bulk.graphql'),'\\n# replaced');}assert.throws(()=>E.assertSourceSeal(),/RFM_EXPORT_SOURCE_DRIFT/);`;
  const child=spawnSync(process.execPath,['-e',script,directory,scenario],{encoding:'utf8',timeout:10000});assert.equal(child.status,0,child.stderr);
 }
});

test('compact order identity remains exact above 2^53 and latest nanoseconds retain the same millisecond output',()=>{
 const x=fixture(),prototype=JSON.parse(x.paidOrdersJsonl.split('\n')[0]);
 const a={...structuredClone(prototype),id:'gid://shopify/Order/9007199254740992',createdAt:'2026-09-01T00:00:00.000999999Z',customer:{id:'gid://shopify/Customer/1'}};
 const b={...structuredClone(a),id:'gid://shopify/Order/9007199254740993',createdAt:'2026-09-01T00:00:00.001000000Z'};
 replaceOrders(x,[b,a]);const out=buildRfmEvidence(x),buyer=out.customers.find(c=>c.customer_gid==='gid://shopify/Customer/1');
 assert.equal(buyer.paid_orders,2);assert.equal(buyer.last_paid_order_at,'2026-09-01T00:00:00.001Z');
 replaceOrders(x,[a,b,{...structuredClone(b)}]);assert.throws(()=>buildRfmEvidence(x),/RFM_EXPORT_ORDER/);
});
