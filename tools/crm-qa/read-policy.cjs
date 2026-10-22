'use strict';
const hosts=new Set(['crm.shrigma.com.br','gerencial.shrigma.com.br','influs.shrigma.com.br','organico.shrigma.com.br']);
const campaignActions=new Set(['campanha_capacidade','campanha_teste_capacidade','campanha_teste_historico','campanha_obter','campanha_listar','campanha_catalogo','campanha_nativa_capacidade']);
const modelActions=new Set(['listar','fluxos_listar','fluxos_capacidade','modelos_capacidade','rascunhos_listar','rascunho_obter','email_capacidades']);
function allow(method,address,body){
 let u;try{u=new URL(address);}catch{return false;}
 if(!hosts.has(u.hostname)||u.protocol!=='https:'||u.port||u.username||u.password)return false;
 if(method==='GET'||method==='HEAD'){
  if(u.pathname.startsWith('/auth/'))return u.pathname==='/auth/session';
  if(!u.pathname.startsWith('/api/'))return ['/healthz','/guard.js','/favicon.ico'].includes(u.pathname)||u.pathname.startsWith('/app/')||u.pathname.startsWith('/assets/');
  if(u.pathname==='/api/crm-features')return u.searchParams.size===1&&['fish','aristo'].includes(u.searchParams.get('brand'));
  if(u.pathname==='/api/crm-purchases')return u.searchParams.size===2&&['fish','aristo'].includes(u.searchParams.get('brand'))&&['interface','publics','products'].includes(u.searchParams.get('action'));
  if(u.pathname==='/api/crm-ab-plans')return u.searchParams.size===1&&['fish','aristo'].includes(u.searchParams.get('brand'));
  if(u.pathname==='/api/segments')return ['fish','aristo'].includes(u.searchParams.get('brand'))&&['segmentos_listar','segmento_obter','segmento_capacidade','segmento_operacao'].includes(u.searchParams.get('acao'));
  if(u.pathname==='/api/campaign_audience')return ['fish','aristo'].includes(u.searchParams.get('brand'))&&['campanha_publico_obter','campanha_publico_operacao'].includes(u.searchParams.get('acao'));
  if(u.pathname==='/api/campaigns')return u.searchParams.get('acao')==='campanha_lista_contagem'?u.searchParams.size===3&&['fish','aristo'].includes(u.searchParams.get('brand'))&&/^[1-9][0-9]{0,9}$/.test(u.searchParams.get('list_id')||''):campaignActions.has(u.searchParams.get('acao'));
  if(u.pathname==='/api/templates')return modelActions.has(u.searchParams.get('acao'));
  if(u.pathname==='/api/journey-lab'||u.pathname==='/api/journey-test')return u.searchParams.size===1&&['fish','aristo'].includes(u.searchParams.get('brand'));
  if(u.pathname==='/api/tts-manual')return ['capabilities','attempts'].includes(u.searchParams.get('action'))&&u.searchParams.size===2&&['fish','aristo'].includes(u.searchParams.get('brand'));
  if(u.pathname==='/api/crm-read')return ['cache_growth','identity'].includes(u.searchParams.get('action'));
  return ['/api/cache','/api/front-access','/api/session','/api/affiliate-read'].includes(u.pathname);
 }
 if(method!=='POST'||!body||Object.getPrototypeOf(body)!==Object.prototype||u.search)return false;
 if(u.pathname==='/api/influ')return body.acao==='listar'&&body.pilot===false&&['fish','aristo'].includes(body.marca)&&Object.keys(body).every(k=>['acao','marca','ini','fim','pilot'].includes(k));
 if(u.pathname==='/api/affiliate-read')return ['fish','aristo'].includes(body.brand)&&Object.keys(body).sort().join(',')==='brand,expected_binding,fim,ini';
 if(u.pathname==='/api/affiliate-own-read')return ['fish','aristo'].includes(body.brand)&&Object.keys(body).sort().join(',')==='brand,fim,ini';
 return false;
}
module.exports={allow};
