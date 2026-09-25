'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),crypto=require('node:crypto');
const {build}=require('../n8n/growth/whatsapp-cart-outcomes-workflow.cjs');
const C=require('../n8n/growth/whatsapp-cart-outcomes.cjs');
const shops=['aristo','fish'].map(brand=>({brand,origin:'https://synthetic-'+brand+'.myshopify.com',credential:{id:'synthetic-'+brand,name:'Vault '+brand}}));
const workflow=build({shops,postgresCredential:{id:'synthetic-pg',name:'Vault PG'}});
const get=name=>workflow.nodes.find(n=>n.name===name),plain=x=>JSON.parse(JSON.stringify(x));
const bag=amount=>({shopMoney:{amount,currencyCode:'BRL'}});
const order=id=>({id:'gid://shopify/Order/'+id,createdAt:'2026-09-24T00:30:00Z',updatedAt:'2026-09-24T00:40:00Z',test:false,cancelledAt:null,displayFinancialStatus:'PAID',phone:'+5511900000001',shippingAddress:null,billingAddress:null,netPaymentSet:bag('100'),totalReceivedSet:bag('100'),totalRefundedSet:bag('0'),transactions:[{kind:'SALE',status:'SUCCESS',processedAt:'2026-09-24T00:35:00Z',amountSet:bag('100')}]});
const native=(name,items)=>{const n=get(name),field=n.parameters.value.match(/\$json\.(\w+)/)[1];return items.map(item=>({...item,json:{...item.json,[n.parameters.dataPropertyName]:crypto.createHash(n.parameters.type.toLowerCase()).update(item.json[field]).digest('hex')}}));};
function execute(name,items,extra={}){
 // Only n8n adapters are mocked; do not inject host globals absent in its sandbox.
 const context={$json:items[0]?.json,$input:{all:()=>items},...extra};
 return plain(vm.runInNewContext('(function(){'+get(name).parameters.jsCode+'})()',context));
}
test('candidate is inactive, only vault credentials/destinations, has no require in Code and no persistence in probe branch',()=>{
 assert.equal(vm.runInNewContext('typeof structuredClone'),'undefined');
 assert.equal(vm.runInNewContext('typeof BigInt'),'function');
 assert.equal(workflow.active,false);assert.equal(workflow.settings.saveDataSuccessExecution,'none');assert.equal(workflow.settings.saveDataErrorExecution,'none');assert.equal(workflow.settings.saveManualExecutions,false);
 for(const n of workflow.nodes){if(n.type==='n8n-nodes-base.code'){assert.doesNotMatch(n.parameters.jsCode,/require\(/);new vm.Script('(function(){'+n.parameters.jsCode+'})');}}
 assert.equal(workflow.nodes.filter(n=>n.type==='n8n-nodes-base.crypto').length,3);
 assert.equal(workflow.nodes.some(n=>/webhook|executeWorkflow$/.test(n.type)),false);
 for(const n of workflow.nodes.filter(n=>n.type==='n8n-nodes-base.httpRequest')){assert.match(n.parameters.url,/^https:\/\/synthetic-(aristo|fish)\.myshopify\.com\/admin\/api\/2026-07\/graphql\.json$/);assert.ok(n.credentials.httpHeaderAuth.id);assert.equal(n.parameters.options.redirect.redirect.followRedirects,false);}
 assert.equal(workflow.connections['É prova somenteleitura'].main[0][0].node,'Resumo da prova');
 assert.equal(workflow.connections['Resumo da prova'].main[0][0].node,'Uma janela por vez');
 assert.throws(()=>build({shops:[...shops.slice(0,1),{...shops[1],origin:'https://unverified.invalid'}],postgresCredential:{id:'pg'}}),/VERIFIED_CREDENTIALS/);
});
test('native runtime path links each page by request index, removes PII before SQL, and has a measured envelope',t=>{
 const job={brand:'aristo',mode:'reconcile',since:'2026-09-24T00:00:00Z',until:'2026-09-24T02:00:00Z',salt:'4bd4e574-9810-436b-a815-f9376d86c26a',run_id:'5265dcf0-10a8-4fe7-bdca-9cb6434d342f',now:'2026-09-25T01:00:00Z',dry_run:true};
 let bytes=0,items=[{json:job}],requests=[],state;
 const account=out=>{bytes+=Buffer.byteLength(JSON.stringify(out));return out;};
 items=account(execute('Preparar janela',items));items=account(native('Hash da consulta',items));items=account(execute('Janela pronta',items));state=items[0].json.state;
 function request(){const out=account(execute('Próxima consulta',[{json:{state}}],{$runIndex:requests.length}));account(out);requests.push(out);return out[0].json;}
 function response(req,body){account([{json:{statusCode:200,body}}]);const out=account(execute('Ler resposta',[{json:{statusCode:200,body}}],{$:()=>({item:{json:req}})}));account(out);account(out);if(out[0].json.state)account(out);return out;}
 let req=request();state=response(req,{data:{ordersCount:{count:500,precision:'EXACT'}}})[0].json.state;
 for(let page=0;page<5;page++){
  req=request();const body={data:{orders:{nodes:Array.from({length:100},(_,i)=>order(page*100+i+1)),pageInfo:{hasNextPage:page<4,endCursor:page<4?'cursor'+page:null}}}};
  const lookup=(name,out,index)=>{assert.equal(name,'Próxima consulta');assert.equal(out,0);return requests[index];};
  items=response(req,body);items=account(execute('Preparar identidades',items,{$items:lookup}));
  assert.equal(items.some(x=>'state' in x.json),false,'large cumulative state must never be copied into every order');
  items=account(native('Pseudônimo MD5',items));items=account(execute('Apagar telefone e preparar revisão',items));assert.doesNotMatch(JSON.stringify(items),/5511900000001|_identity_input/);
  items=account(native('Revisão SHA256',items));items=account(execute('Aceitar página sanitizada',items,{$items:lookup}));account(items);state=items[0].json.state;
 }
 req=request();state=response(req,{data:{ordersCount:{count:500,precision:'EXACT'}}})[0].json.state;
 items=account(execute('Preparar resultado',[{json:{state}}]));account(items);assert.equal(items[0].json.batch.rows.length,500);
 assert.doesNotMatch(JSON.stringify(items[0].json.batch),/5511900000001|phone|_identity_input|_revision_input/);
 assert.deepEqual(items[0].json.batch.rows[0],C.normalize(order(1),job));
 items=account(execute('Resumo da prova',items));assert.deepEqual(items[0].json,{ok:true,dry_run:true,brand:'aristo',orders:500,pages:5,missing_identity:0,unknown_financial:0,source_writes:0,holdout_enabled:false});
 // Count each node's serialized output, including native hash stages and raw HTTP.
 // Four maximum jobs must fit this conservative measured fixture envelope.
 assert.ok(bytes<12*1024*1024,`one job serialized node outputs=${bytes}`);assert.ok(bytes*4<48*1024*1024);
 t.diagnostic(JSON.stringify({serializedNodeOutputBytesPer500OrderJob:bytes,fourJobsBytes:bytes*4,measurement:'serialized fixture outputs; not process RSS'}));
});
test('raw oversized response stops before phone-bearing data can propagate through the graph',()=>{
 const out=execute('Ler resposta',[{json:{statusCode:200,body:{padding:'x'.repeat(1024001),data:{orders:{nodes:[]}}}}}],{$:()=>({item:{json:{state:{phase:'page',brand:'aristo',run_id:'synthetic'},request_run_index:0}}})});
 assert.deepEqual(out,[{json:{failed:true,brand:'aristo',run_id:'synthetic',reason:'OUTCOME_PAGE_SIZE_LIMIT_SPLIT_REQUIRED'}}]);
});
