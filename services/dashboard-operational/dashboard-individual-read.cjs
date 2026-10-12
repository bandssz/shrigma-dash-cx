'use strict';
// Read-only contracts used by the existing dashboards. Missing data is never zero.
const BRANDS=['fish','aristo'];
const brand=v=>['fish','fishermans'].includes(v)?'fish':['aristo','aristocrata'].includes(v)?'aristo':v==='olivas'?'olivas':null;
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
const fail=(code='BRAND_READ_CONTRACT_NOT_READY',status=503)=>{throw Object.assign(Error(code),{code,status});};
const spec=(text='',metrics='',dates='',flags='')=>Object.freeze({
 ...Object.fromEntries(text.split(' ').filter(Boolean).map(k=>[k,'text'])),
 ...Object.fromEntries(metrics.split(' ').filter(Boolean).map(k=>[k,'metric'])),
 ...Object.fromEntries(dates.split(' ').filter(Boolean).map(k=>[k,'date'])),
 ...Object.fromEntries(flags.split(' ').filter(Boolean).map(k=>[k,'flag']))
});
const FIELDS=Object.freeze({
 cx_post:spec('rede conta post_id tipo formato legenda permalink','alcance curtidas comentarios salvos compartilhamentos compartilh views','dia publicado_em coletado_em ultima_coleta','impulsionado'),
 cx_story:spec('rede conta story_id tipo permalink','alcance respostas saidas link_clicks','dia publicado_em coletado_em ultima_coleta'),
 cx_post_midia:spec('post_id previa_url'),
 cx_organico_receita:spec('rede canal','pedidos receita','dia coletado_em'),
 cx_conta_dia:spec('rede conta','seguidores alcance seguidores_novos seguidores_total website_clicks alcance_conta profile_views','dia coletado_em'),
 influs:spec('influ nome handle nicho modelo porte obs','comissao_pct','','ativo'),
 roi:spec('influ nome handle porte modelo obs patrocinio_rotulo','pedidos receita custo_lancado comissao patrocinio investimento investimento_total roi roi_total','','ativo frete_zerado tem_custo'),
 cupons:spec('codigo tipo influ obs','usos_lifetime desconto_pct influ_comissao_pct','desde','ativo'),
 custos:spec('influ competencia patrocinio_rotulo','fixo produto frete patrocinio'),
 receita_cupom:spec('codigo','pedidos receita'),
 termos:spec('influ modelo autor','comissao_pct','vigente_desde'),
 clientes:spec('influ','pedidos novos recorrentes sem_indice'),
 conciliacao:spec('codigo tipo influ relatorio_cobertura situacao','relatorio_pedidos relatorio_vendas_liquidas pagos receita_paga nao_pagos receita_nao_paga diferenca','relatorio_coletado_em painel_atualizado_em'),
 saude:spec('lane','itens','em ultimo_ok_em','ok'),
 daily:Object.freeze({...spec('model classification superficie rede canal utm_source utm_medium utm_campaign utm_content utm_term','pedidos receita_liquida','dia'),detail_level:'detail-level',rule_reason:'rule-reason'}),
 quality:spec('model','pedidos_lidos pagos_elegiveis jornada_pendente jornada_parcial ultima_sessao_conhecida ultima_sessao_desconhecida origem_nao_direta_desconhecida','dia leitura_mais_antiga coletado_em'),
 coverage:spec('','', 'dia checked_at')
});
const validDate=v=>typeof v==='string'&&v.length<=64&&/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(v)&&Number.isFinite(Date.parse(v));
function valid(v,type){
 if(v===null)return true;
 if(type==='text')return typeof v==='string'&&v.length<=4000&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v);
 if(type==='metric')return typeof v==='number'&&Number.isFinite(v)||typeof v==='string'&&/^-?\d{1,16}(?:\.\d{1,6})?$/.test(v);
 if(type==='date')return validDate(v);
 if(type==='detail-level')return ['utm','channel_summary'].includes(v);
 if(type==='rule-reason')return typeof v==='string'&&/^[a-z][a-z0-9_]{0,99}$/.test(v);
 return type==='flag'&&typeof v==='boolean';
}
function rows(value,b,fields,{required=[],present=[],unique=[],section=''}={}){
 const refused=(reason,field)=>{const e=Object.assign(Error('BRAND_RESPONSE_UNSCOPED'),{code:'BRAND_RESPONSE_UNSCOPED',status:502,projectionIssue:{section,reason,...(field?{field}:{})}});throw e;};
 if(!Array.isArray(value)||value.length>50000)refused('rows_type_invalid');
 const out=[],seen=new Set();
 for(const row of value){
  if(!plain(row))refused('row_type_invalid');
  const markers=['marca','brand'].filter(k=>Object.hasOwn(row,k)),brands=markers.map(k=>brand(row[k]));
  if(!markers.length||brands.some(v=>!v||v!==brands[0]))refused('brand_marker_invalid');
  if(brands[0]!==b)continue;
  const projected={marca:b,brand:b};
  for(const [name,type]of Object.entries(fields))if(Object.hasOwn(row,name)){
   if(!valid(row[name],type))refused('field_type_invalid',name);
   projected[name]=row[name];
  }
  if(required.some(k=>!Object.hasOwn(projected,k)||projected[k]===null))fail();
  if(present.some(k=>!Object.hasOwn(projected,k)))fail();
  if(unique.length){
   if(unique.some(k=>!Object.hasOwn(projected,k)||projected[k]===null))fail();
   const key=JSON.stringify(unique.map(k=>projected[k]));if(seen.has(key))fail('BRAND_RESPONSE_AMBIGUOUS',502);seen.add(key);
  }
  out.push(projected);
 }
 return out;
}
function metadata(source,out){
 for(const k of ['gerado_em','_cache_gerado_em'])if(Object.hasOwn(source,k)){if(!validDate(source[k]))fail();out[k]=source[k];}
 return out;
}
function organic(body,b){
 if(Array.isArray(body)){if(body.length!==1)fail();body=body[0];}
 if(plain(body)&&Object.hasOwn(body,'payload'))body=body.payload;
 if(!plain(body)||body.error||body.erro||body._escopo!=='organico')fail();
 if(!['cx_post','cx_story','cx_organico_receita'].some(k=>Array.isArray(body[k])))fail();
 const out=metadata(body,{brand:b,brands:[b],brandAccess:'single',_escopo:'organico',_painel:'organico'});
 for(const k of ['cx_post','cx_story','cx_organico_receita','cx_conta_dia','cx_post_midia'])if(Object.hasOwn(body,k))out[k]=rows(body[k],b,FIELDS[k],{section:k,...(k==='cx_post'?{required:['post_id','publicado_em','formato','impulsionado'],unique:['post_id']}: {})});
 if(Object.hasOwn(body,'organico_attribution')){
  const a=body.organico_attribution;
  if(!plain(a)||a.schema_version!==1||a.window_days!==30||a.source_system!=='shopify'||a.currency!=='BRL')fail();
  out.organico_attribution={schema_version:1,window_days:30,source_system:'shopify',currency:'BRL'};
  if(Object.hasOwn(a,'rule_version')){if(typeof a.rule_version!=='string'||!/^organico-utm-\d{8}-v[1-9]\d{0,3}$/.test(a.rule_version))fail();out.organico_attribution.rule_version=a.rule_version;}
  if(Object.hasOwn(a,'default_model')){if(!['last_click','last_non_direct'].includes(a.default_model))fail();out.organico_attribution.default_model=a.default_model;}
  for(const k of ['assistance_available','utm_raw_available'])if(Object.hasOwn(a,k)){if(typeof a[k]!=='boolean')fail();out.organico_attribution[k]=a[k];}
  for(const k of ['daily','quality','coverage'])out.organico_attribution[k]=rows(a[k],b,FIELDS[k],{section:'organic.'+k});
 }
 return out;
}
function creators(body,b,query){
 if(!plain(body)||body.error||body.erro||!plain(body.janela)||body.janela.ini!==query.ini||body.janela.fim!==query.fim)fail();
 const out=metadata(body,{brand:b,brands:[b],brandAccess:'single',janela:{ini:query.ini,fim:query.fim}});
 const unique={influs:['influ'],roi:['influ'],cupons:['codigo'],receita_cupom:['codigo'],custos:['influ','competencia'],termos:['influ','vigente_desde']};
 for(const k of ['influs','roi','cupons','custos','receita_cupom','termos'])out[k]=rows(body[k],b,FIELDS[k],{section:k,unique:unique[k],present:Object.entries(FIELDS[k]).filter(([,type])=>type==='metric').map(([name])=>name)});
 const ids=new Set(out.influs.map(row=>row.influ)),coupons=new Set(out.cupons.map(row=>row.codigo));
 for(const k of ['roi','custos','termos','cupons'])if(out[k].some(row=>row.influ!==null&&!ids.has(row.influ)))fail('BRAND_RESPONSE_AMBIGUOUS',502);
 if(out.receita_cupom.some(row=>!coupons.has(row.codigo)))fail('BRAND_RESPONSE_AMBIGUOUS',502);
 for(const k of ['clientes','conciliacao','saude'])if(Object.hasOwn(body,k))out[k]=rows(body[k],b,FIELDS[k],{section:k,unique:k==='clientes'?['influ']:k==='conciliacao'?['codigo']:['lane']});
 if(out.clientes?.some(row=>!ids.has(row.influ)||['pedidos','novos','recorrentes','sem_indice'].some(k=>!Number.isSafeInteger(Number(row[k]))||row[k]===null||Number(row[k])<0)||Number(row.novos)+Number(row.recorrentes)+Number(row.sem_indice)!==Number(row.pedidos)))fail();
 if(out.saude?.some(row=>!['sync_cupom','coleta_pedidos','relatorio_shopify'].includes(row.lane)||typeof row.ok!=='boolean'))fail();
 if(out.saude)for(const row of out.saude)if(!row.ok)row.detalhe='A fonte registrou falha; detalhe privado não exibido.';
 if(out.conciliacao?.some(row=>row.relatorio_cobertura!==null&&row.relatorio_cobertura!==undefined&&!['sem_coleta','parcial','completa'].includes(row.relatorio_cobertura)||row.situacao!==null&&row.situacao!==undefined&&!['relatorio_indisponivel','relatorio_parcial','fora_da_lente','ausente_no_painel','ausente_no_relatorio','diferenca_de_valor','explicada_nao_pagos','igual'].includes(row.situacao)))fail();
 if(out.conciliacao?.some(row=>['pagos','nao_pagos'].some(k=>row[k]===null||!Number.isSafeInteger(Number(row[k]))||Number(row[k])<0)||['receita_paga','receita_nao_paga'].some(k=>row[k]===null||!Number.isFinite(Number(row[k])))||!row.relatorio_cobertura||!row.situacao||row.relatorio_cobertura==='completa'&&!(row.situacao==='ausente_no_relatorio'&&row.relatorio_pedidos===null&&row.relatorio_vendas_liquidas===null)&&['relatorio_pedidos','relatorio_vendas_liquidas'].some(k=>row[k]===null||!Number.isFinite(Number(row[k])))))fail();
 if(Object.hasOwn(body,'coleta')){if(!plain(body.coleta))fail();out.coleta={};for(const [name,date]of Object.entries(body.coleta))if(brand(name)===b){if(date!==null&&!validDate(date)||Object.hasOwn(out.coleta,b))fail();out.coleta[b]=date;}}
 return out;
}
function allowed(route,method,action,area){
 if(area==='growth')return route==='crm-read'&&method==='GET'&&['identity','cache_growth'].includes(action);
 if(area==='organico')return ['cx','cache'].includes(route)&&method==='GET'&&action==='';
 return area==='influs'&&(['cx','cache'].includes(route)&&method==='GET'&&action===''||route==='influ'&&method==='POST'&&action==='listar');
}
function project(body,{area,brand:b,query={},credential}={}){
 if(!BRANDS.includes(b))fail('BRAND_REQUIRED',400);
 if(typeof credential==='string'&&credential.length>=8&&JSON.stringify(body).includes(credential))fail('BRAND_RESPONSE_UNSCOPED',502);
 if(area==='organico')return organic(body,b);
 if(area==='influs')return creators(body,b,query);
 fail();
}
module.exports={allowed,project,rows,FIELDS};
