'use strict';
// File import prepares local form values only. No transport, storage or operation.
const C=require('../../campaign-write-contract.js'),T=require('../../campaign-write-tracking.js');
const CampaignImport=(()=>{
 const LIMIT=240*1024,fail=(code,message)=>{throw Object.assign(Error(message),{code});};
 function listUnion(rule){if(rule?.op==='in_list'&&Number.isSafeInteger(rule.list_id)&&rule.list_id>0)return[rule.list_id];if(rule?.op==='and'&&rule.rules?.length===1)return listUnion(rule.rules[0]);if(rule?.op==='or'&&Array.isArray(rule.rules)&&rule.rules.length){const groups=rule.rules.map(listUnion);if(groups.every(Boolean))return[...new Set(groups.flat())].sort((a,b)=>a-b);}return null;}
 function prepare(bytes,{brand,catalog,audiences=[],audienceId=null,editorialMode='legacy'}={}){
  if(!(bytes instanceof Uint8Array)||bytes.byteLength>LIMIT)fail('IMPORT_SIZE','Use um arquivo JSON UTF-8 de até 240 KB.');
  let raw;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('IMPORT_JSON','O arquivo precisa conter JSON válido em UTF-8.');}
  if(raw?.brand!==brand)fail('IMPORT_BRAND','O arquivo pertence a outra marca.');
  const d=C.preflight(raw,{catalog,tracking:T,editorialMode}),domain=C.BRANDS[brand],mail=d.from_email.match(/<([^<>]+)>$/)?.[1]||d.from_email;
  if(mail.toLowerCase()!=='avisos@'+domain||d.reply_to!=='contato@'+domain)fail('IMPORT_SENDER','Use o remetente confirmado e o endereço de respostas desta marca.');
  const matches=audiences.filter(x=>x.brand===brand&&!x.archived&&Number.isSafeInteger(x.version)&&x.version>0&&x.semantic_context?.current!==false&&JSON.stringify(listUnion(x.definition?.rule))===JSON.stringify(d.list_ids));
  const match=matches.length===1?matches[0]:matches.find(x=>x.id===audienceId);
  if(!match)fail('IMPORT_AUDIENCE',matches.length?'Mais de um público salvo corresponde às listas. Escolha o público no passo 1 e importe novamente.':'Nenhum público salvo corresponde exatamente às listas do arquivo. Crie ou ajuste esse público antes de importar.');
  return Object.freeze({definition:d,audienceId:match.id,audienceVersion:match.version});
 }
 return Object.freeze({LIMIT,prepare,listUnion});
})();
if(typeof module==='object')module.exports=CampaignImport;
if(typeof window==='object')window.ShrigmaCrmCampaignImport=CampaignImport;

if(typeof window==='object')window.ShrigmaCrmCampaignLinks=Object.freeze(T);
