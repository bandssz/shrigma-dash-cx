'use strict';
// Ephemeral Linux PostgreSQL only; no production credentials or network.
const fs=require('node:fs'),path=require('node:path'),a=require('node:assert/strict'),cp=require('node:child_process');
const root=path.resolve(__dirname,'../..'),docker=process.env.SHRIGMA_DOCKER_BIN||'docker',name='paid-publics-query-'+process.pid;
const run=(args,input)=>cp.execFileSync(docker,args,{encoding:'utf8',input,maxBuffer:2*1024*1024});
const literal=v=>v===null?'NULL':typeof v==='boolean'?String(v):"'"+String(v).replaceAll("'","''")+"'";
let created=false;
(async()=>{
 run(['run','--detach','--platform','linux/amd64','--name',name,'--network','none','--memory','256m','--tmpfs','/var/lib/postgresql/data:rw,nosuid','--env','POSTGRES_HOST_AUTH_METHOD=trust','postgres:17.10']);created=true;
 for(let i=0;i<40;i++){try{run(['exec',name,'pg_isready','-h','127.0.0.1','-U','postgres']);break;}catch{if(i===39)throw Error('POSTGRES_NOT_READY');await new Promise(r=>setTimeout(r,500));}}
 const sql=q=>run(['exec','-i',name,'psql','-X','-U','postgres','-v','ON_ERROR_STOP=1','-At'],q).trim();
 sql('CREATE SCHEMA crm_audience_v2; CREATE TABLE public.crm_attribution_order_v2(brand text,paid_fact jsonb); CREATE TABLE public.subscribers(id int,uuid text,status text); CREATE TABLE public.subscriber_lists(subscriber_id int,list_id int,status text); CREATE TABLE public.lists(id int,status text,optin text); CREATE TABLE crm_audience_v2.shopify_identity(brand text,customer_gid text,subscriber_id int,subscriber_uuid text);');
 for(const[brand,base]of[['aristo',16],['fish',17]]){
  sql('INSERT INTO public.lists VALUES('+base+",'active','single');");
  for(let id=1;id<=12;id++){
   const sid=base*100+id,customer=id===3?null:'customer-'+id;
   sql('INSERT INTO public.subscribers VALUES('+sid+','+literal('uuid-'+sid)+','+literal(id===5?'disabled':'enabled')+'); INSERT INTO public.subscriber_lists VALUES('+sid+','+base+','+literal(id===4?'unsubscribed':id===7?'unconfirmed':'confirmed')+'); INSERT INTO crm_audience_v2.shopify_identity VALUES('+[brand,customer,sid,'uuid-'+sid].map(literal).join(',')+');');
  }
  sql('INSERT INTO crm_audience_v2.shopify_identity VALUES('+[brand,'customer-1',base*100+1,'uuid-'+(base*100+1)].map(literal).join(',')+'),('+[brand,'never-bought',base*100+8,'uuid-'+(base*100+8)].map(literal).join(',')+'),('+[brand,'customer-1',base*100+2,'wrong-uuid'].map(literal).join(',')+');');
  const fact=(customer,patch={})=>({customerId:customer,createdAt:'2026-10-20T12:00:00.000Z',financialStatus:'paid',test:false,products:[{productId:'gid://shopify/Product/1'}],...patch});
  for(const f of[...['customer-1','customer-1','customer-4','customer-5','customer-7','customer-8'].map(c=>fact(c)),fact(null),fact('customer-10',{test:true}),fact('customer-11',{createdAt:'2026-09-01T00:00:00.000Z'}),fact('customer-12',{financialStatus:'refunded'})])sql('INSERT INTO public.crm_attribution_order_v2 VALUES('+literal(brand)+','+literal(JSON.stringify(f))+'::jsonb);');
 }
 const current=require(path.join(root,'services/dashboard-operational/crm-paid-facts.cjs')).audienceSql('not_bought_recently'),legacy=fs.readFileSync(path.join(root,'tests/fixtures/paid-publics-negative-before.sql'),'utf8');
 let cases=0;
 const compare=()=>{for(const[brand,base]of[['aristo',16],['fish',17]])for(const tests of[false,true])for(const product of[null,'gid://shopify/Product/1','gid://shopify/Product/99']){
  const args=[brand,'2026-09-21T00:00:00.000Z','2026-10-21T00:00:00.000Z',product,tests,base];
  const members=q=>sql(q.replace('SELECT count(DISTINCT s.id)::int count','SELECT DISTINCT s.id').replace(/\$([1-6])/g,(_,n)=>literal(args[n-1]))+' ORDER BY s.id;');
  a.equal(members(current),members(legacy));cases++;
 }};
 compare();sql("UPDATE public.lists SET optin='double';");compare();sql("UPDATE public.lists SET status='inactive';");compare();sql("UPDATE public.lists SET status='active'; DELETE FROM public.crm_attribution_order_v2;");compare();
 console.log(JSON.stringify({ok:true,postgres:'17.10',cases,comparedDistinctMembers:true,nullCustomers:true,duplicateOrdersAndIdentities:true,multipleIdentities:true,unsubscribedAndDisabled:true,listOptinAndStatus:true,emptyBuyers:true,productionConnections:0,databaseChanges:0}));
})().catch(()=>{console.error(JSON.stringify({ok:false,code:'PAID_PUBLIC_QUERY_REGRESSION'}));process.exitCode=1;}).finally(()=>{if(created)run(['rm','--force',name]);});
