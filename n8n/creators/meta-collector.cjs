'use strict';
function normalizePages(pages,config){
 const rows=[],seen=new Set();let complete=pages.length>0,error=null;
 const metric=list=>{if(!Array.isArray(list))return null;const match=list.filter(x=>x.action_type==='offsite_conversion.fb_pixel_purchase');if(match.length!==1||match[0]['7d_click']==null||String(match[0]['7d_click']).trim()=='')return null;const n=Number(match[0]['7d_click']);return Number.isFinite(n)&&n>=0?n:null;};
 for(const page of pages){const body=page?.body;
  if(page?.statusCode!==200||!Array.isArray(body?.data)){complete=false;error='Meta não confirmou a consulta'+(body?.error?.code?' (código '+body.error.code+')':'')+'.';break;}
  for(const r of body.data){const grain=r.ad_id+'|'+r.date_start;
   if(String(r.account_id)!==config.account_id||r.account_currency!=='BRL'||r.date_start!==r.date_stop||r.date_start<config.since||r.date_stop>config.until||!/^\d+$/.test(String(r.ad_id))||seen.has(grain)||!['spend','impressions','clicks'].every(k=>r[k]!=null&&String(r[k]).trim()!==''&&Number.isFinite(Number(r[k]))&&Number(r[k])>=0)){complete=false;error='Resposta fora do grão, marca ou período esperado.';break;}
   seen.add(grain);rows.push({...Object.fromEntries(['account_id','account_currency','ad_id','ad_name','adset_name','campaign_name','date_start','date_stop','spend','impressions','clicks'].map(k=>[k,r[k]])),model:'7d_click_conversion',purchases:metric(r.actions),purchase_value:metric(r.action_values)});
  }
  if(!complete)break;
 }
 if(pages.at(-1)?.body?.paging?.next){complete=false;error='Paginação incompleta. Última leitura preservada.';}
 return {...config,metric_basis:'explicit_7d_click',complete,error,rows:complete?rows:[]};
}
function build({accounts,metaCredential,postgresCredential}){
 if(!Array.isArray(accounts)||!accounts.length||accounts.some(a=>!/^\d+$/.test(a.account_id)||!['fish','aristo'].includes(a.marca)))throw Error('Verified accounts required');
 if(!metaCredential?.id||!postgresCredential?.id)throw Error('Vault credentials required');
 const node=(name,type,parameters,x,y=0,extra={})=>({id:name.replace(/\s/g,'-'),name,type:'n8n-nodes-base.'+type,typeVersion:type==='httpRequest'?4.2:type==='postgres'?2.6:type==='code'?2:type==='scheduleTrigger'?1.2:1.1,position:[x,y],parameters,...extra});
 const dateCode="const now=new Date();const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);const day=n=>new Date(new Date(today+'T12:00:00Z').getTime()+n*86400000).toISOString().slice(0,10);return [{json:{since:day(-7),until:day(-1),started_at:now.toISOString()}}];";
 const nodes=[node('Diário','scheduleTrigger',{rule:{interval:[{field:'cronExpression',expression:'17 6 * * *'}]}},0),node('Chamado','executeWorkflowTrigger',{inputSource:'passthrough'},0,180),node('Janela','code',{jsCode:dateCode},200)],connections={};
 const edge=(a,b)=>connections[a]={main:[[{node:b,type:'main',index:0}]]};edge('Diário','Janela');edge('Chamado','Janela');let prior='Janela';
 for(const [i,a] of accounts.entries()){
  const http='Meta '+(i+1),norm='Conferir '+(i+1),pg='Gravar '+(i+1);
  nodes.push(node(http,'httpRequest',{url:'https://graph.facebook.com/v25.0/act_'+a.account_id+'/insights',authentication:'genericCredentialType',genericAuthType:'httpHeaderAuth',sendQuery:true,queryParameters:{parameters:[{name:'fields',value:'account_id,account_currency,ad_id,ad_name,adset_name,campaign_name,date_start,date_stop,spend,impressions,clicks,actions,action_values'},{name:'level',value:'ad'},{name:'time_increment',value:'1'},{name:'time_range',value:'={{ JSON.stringify({since:$("Janela").first().json.since,until:$("Janela").first().json.until}) }}'},{name:'action_attribution_windows',value:'["7d_click"]'},{name:'action_report_time',value:'conversion'},{name:'limit',value:'250'}]},options:{timeout:60000,response:{response:{fullResponse:true,neverError:true,responseFormat:'json'}},redirect:{redirect:{followRedirects:false}},pagination:{pagination:{paginationMode:'updateAParameterInEachRequest',parameters:{parameters:[{type:'qs',name:'after',value:'={{ $response.body.paging?.cursors?.after || "" }}'}]},paginationCompleteWhen:'other',completeExpression:'={{ !$response.body.paging?.next }}',limitPagesFetched:true,maxRequests:20,requestInterval:1500}}} },400+i*600,0,{credentials:{httpHeaderAuth:metaCredential},retryOnFail:false,onError:'continueRegularOutput'}));
  nodes.push(node(norm,'code',{jsCode:'const normalize='+normalizePages.toString()+';return [{json:{payload:normalize($input.all().map(i=>i.json),{...$("Janela").first().json,account_id:'+JSON.stringify(a.account_id)+'})}}];'},600+i*600));
  nodes.push(node(pg,'postgres',{operation:'executeQuery',query:'SELECT public.crm_creator_meta_ingest_v2($1::jsonb) AS result',options:{queryReplacement:'={{ [JSON.stringify($json.payload)] }}'}},800+i*600,0,{credentials:{postgres:postgresCredential},retryOnFail:false}));
  edge(prior,http);edge(http,norm);edge(norm,pg);prior=pg;
 }
 return {name:'Creators — Meta Ads · leitura diária por anúncio (piloto)',nodes,connections,settings:{executionOrder:'v1',callerPolicy:'workflowsFromSameOwner',timezone:'America/Sao_Paulo',saveDataErrorExecution:'none',saveDataSuccessExecution:'none',saveManualExecutions:false,availableInMCP:false}};
}
module.exports={build,normalizePages};
