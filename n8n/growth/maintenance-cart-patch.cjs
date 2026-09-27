'use strict';
// Pure builders: no API, filesystem, database, activation or transport calls.
const {createHash}=require('node:crypto');
const TARGET='ekQxu1pUFyab8Iyd';
const NAME={selector:'Elegíveis (PG)',claim:'R4 reserva carrinho',winner:'R4 vencedores carrinho',http:'R4 Listmonk carrinho',classify:'R4 classifica carrinho',finish:'R4 finaliza carrinho'};
const OLD_CLAIM='SELECT * FROM public.shrigma_email_claim_cart($1::jsonb);';
const NEW_FINISH='SELECT * FROM crm_maintenance_candidate.cart_finish_v1($1::uuid,$2::uuid,$3::text,$4::jsonb);';
const NEW_CLAIM='SELECT * FROM crm_maintenance_candidate.cart_admit_claim_v1($1::jsonb);';
const SELECTOR_ANCHOR='WHERE cl.toque IS NOT NULL';
const EXCLUDE="\n  AND NOT ($2::text IN ('fish','aristo') AND crm_maintenance_candidate.cart_known_v1($2::text,cl.toque,cl.id,cl.cart_at))";
function canonical(value){if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';return JSON.stringify(value);}
function digest(value){return createHash('sha256').update(canonical(value)).digest('hex');}
function clone(value){return JSON.parse(JSON.stringify(value));}
function node(w,name,type){const n=w.nodes?.filter(x=>x.name===name);if(n?.length!==1||n[0].type!==type)throw Error('MAINTENANCE_CART_NODE_DRIFT');return n[0];}
function out(w,name,targets){const expected={main:[targets.map(node=>({node,type:'main',index:0}))]};if(canonical(w.connections?.[name])!==canonical(expected))throw Error('MAINTENANCE_CART_GRAPH_DRIFT');}
function source(w,g){
 if(!w||w.id!==TARGET||typeof g?.version!=='string'||!g.version||w.versionId!==g.version||w.activeVersionId!==g.version||w.active!==true||g.workflowHash!==digest(w)||g.connectionsHash!==digest(w.connections))throw Error('MAINTENANCE_CART_VERSION_HASH');
 const selector=node(w,NAME.selector,'n8n-nodes-base.postgres'),claim=node(w,NAME.claim,'n8n-nodes-base.postgres');
 if(claim.parameters.query!==OLD_CLAIM||claim.parameters.options?.queryReplacement!=='={{ [JSON.stringify($json)] }}'||claim.parameters.options.queryBatching!=='independently')throw Error('MAINTENANCE_CART_CLAIM_DRIFT');
 const q=selector.parameters.query;
 if(typeof q!=='string'||q.split(SELECTOR_ANCHOR).length!==2||!q.includes('ORDER BY cl.id\nLIMIT 500;')||q.includes('crm_maintenance_candidate')||!q.includes('cl.cart_at'))throw Error('MAINTENANCE_CART_SELECTOR_DRIFT');
 const branch=node(w,'R4 carrinho Fish Aristo','n8n-nodes-base.if');
 const c=branch.parameters.conditions;
 if(c?.conditions?.length!==1||c.conditions[0].leftValue!=="={{ ['fish','aristo'].includes($json.brand) }}"||c.conditions[0].operator?.operation!=='true'||c.combinator!=='and')throw Error('MAINTENANCE_CART_BRAND_GUARD');
 if(canonical(w.connections?.[branch.name])!==canonical({main:[[{node:NAME.claim,type:'main',index:0}],[{node:'Envia /api/tx',type:'main',index:0}]]}))throw Error('MAINTENANCE_CART_GRAPH_DRIFT');
 const winner=node(w,NAME.winner,'n8n-nodes-base.code');
 if(winner.parameters.jsCode!=="return $input.all().flatMap((i,index)=>i.json.should_send===true?[{json:i.json,pairedItem:{item:index}}]:[]);")throw Error('MAINTENANCE_CART_WINNER_DRIFT');
 const http=node(w,NAME.http,'n8n-nodes-base.httpRequest'),finish=node(w,NAME.finish,'n8n-nodes-base.postgres');
 node(w,NAME.classify,'n8n-nodes-base.code');
 if(http.retryOnFail!==false||http.onError!=='continueRegularOutput'||http.parameters.method!=='POST'||http.parameters.jsonBody!=='={{ $json.payload }}'||http.parameters.authentication!=='genericCredentialType'||http.parameters.genericAuthType!=='httpBasicAuth'||!http.credentials?.httpBasicAuth||http.parameters.options?.response?.response?.fullResponse!==true||http.parameters.options?.response?.response?.neverError!==true||http.parameters.options?.redirect?.redirect?.followRedirects!==false)throw Error('MAINTENANCE_CART_TRANSPORT_DRIFT');
 if(finish.parameters.query!=='SELECT * FROM public.shrigma_email_finish_cart($1::uuid,$2::uuid,$3::text,$4::jsonb);'||finish.parameters.options?.queryReplacement!=="={{ [$('R4 reserva carrinho').item.json.dispatch_id,$('R4 reserva carrinho').item.json.claim_token,$json.outcome,JSON.stringify($('R4 reserva carrinho').item.json.context)] }}"||finish.parameters.options.queryBatching!=='independently'||!finish.credentials?.postgres)throw Error('MAINTENANCE_CART_FINISH_DRIFT');
 out(w,NAME.claim,[NAME.winner]);out(w,NAME.winner,[NAME.http]);out(w,NAME.http,[NAME.classify]);out(w,NAME.classify,[NAME.finish]);
 if(w.connections?.[NAME.finish]&&canonical(w.connections[NAME.finish])!==canonical({main:[]}))throw Error('MAINTENANCE_CART_FINISH_GRAPH');
 return {selector,claim,http,finish};
}
function patchCartProducer(workflow,guard){
 source(workflow,guard);const w=clone(workflow);
 node(w,NAME.selector,'n8n-nodes-base.postgres').parameters.query=node(w,NAME.selector,'n8n-nodes-base.postgres').parameters.query.replace(SELECTOR_ANCHOR,SELECTOR_ANCHOR+EXCLUDE);
 node(w,NAME.claim,'n8n-nodes-base.postgres').parameters.query=NEW_CLAIM;
 node(w,NAME.finish,'n8n-nodes-base.postgres').parameters.query=NEW_FINISH;
 return w;
}
function buildCartConsumer(workflow,guard){
 const checked=source(workflow,guard),names=[NAME.claim,NAME.winner,NAME.http,NAME.classify,NAME.finish];
 const nodes=names.map(name=>clone(workflow.nodes.find(n=>n.name===name)));
 nodes.forEach((n,i)=>{n.id='maintenance-cart-'+i;n.position=[i*260,0];});
 const reserve=nodes.find(n=>n.name===NAME.claim);reserve.parameters.query='SELECT * FROM crm_maintenance_candidate.cart_next_v1($1::text);';reserve.parameters.options.queryReplacement='={{ [$json.brand] }}';reserve.retryOnFail=false;
 nodes.find(n=>n.name===NAME.finish).parameters.query=NEW_FINISH;
 const tick={id:'maintenance-cart-clock',name:'Retomada a cada minuto',type:'n8n-nodes-base.scheduleTrigger',typeVersion:1.2,position:[-520,0],parameters:{rule:{interval:[{field:'cronExpression',expression:'* * * * *'}]}}};
 const turns={id:'maintenance-cart-turns',name:'Dez tentativas por marca',type:'n8n-nodes-base.code',typeVersion:2,position:[-260,0],parameters:{jsCode:"return Array.from({length:10},()=>['fish','aristo']).flat().map(brand=>({json:{brand},pairedItem:{item:0}}));"},retryOnFail:false};
 const connections={};for(const name of names.slice(0,-1))connections[name]=clone(workflow.connections[name]);
 const edge=(from,to)=>{connections[from]={main:[[{node:to,type:'main',index:0}]]};};
 edge(tick.name,turns.name);edge(turns.name,NAME.claim);
 return {name:'Growth · Retomada retida de carrinho · CANDIDATO OFF',active:false,nodes:[tick,turns,...nodes],connections,settings:{executionOrder:workflow.settings?.executionOrder||'v1',timezone:workflow.settings?.timezone||'America/Sao_Paulo',saveDataSuccessExecution:'none',saveDataErrorExecution:'none',saveManualExecutions:false,saveExecutionProgress:false,callerPolicy:'workflowsFromSameOwner',availableInMCP:false}};
}
module.exports={digest,patchCartProducer,buildCartConsumer,TARGET};
