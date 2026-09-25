/* Growth editor preparations only. Operation journals and credentials stay untouched. */
'use strict';
const GBS=(()=>{
 const brands=['fish','aristo','olivas'],areas=['campaign','template','ab'],seen=new Map();
 const validBrand=b=>brands.includes(b),copy=x=>JSON.parse(JSON.stringify(x));
 const store=()=>typeof localStorage!=='undefined'?localStorage:null;
 const slot=(area,brand)=>{if(!areas.includes(area)||!validBrand(brand))throw Error('Escolha uma marca para editar.');return `shrigma_growth_editor_v1:${area}:${brand}`;};
 function read(area,brand){
  if(!validBrand(brand))return null;
  const key=slot(area,brand),s=store();if(!s)return null;
  const raw=s.getItem(key);seen.set(key,raw);
  if(raw===null)return null;
  let data;try{data=JSON.parse(raw);}catch{throw Error('Preparação local não pôde ser lida. Preserve este navegador e exporte o conteúdo aberto.');}
  if(data?.version!==1||data.area!==area||data.brand!==brand||!data.value||typeof data.value!=='object'||Array.isArray(data.value))throw Error('Preparação local incompatível. Os dados foram preservados.');
  return copy(data.value);
 }
 function save(area,brand,value){
  const key=slot(area,brand),s=store();if(!s)throw Error('Não foi possível guardar neste dispositivo. Exporte o conteúdo antes de trocar de marca.');
  const current=s.getItem(key);
  if(seen.has(key)&&seen.get(key)!==current)throw Error('Outra aba alterou esta preparação. Exporte seu conteúdo e recarregue antes de trocar de marca.');
  const raw=JSON.stringify({version:1,area,brand,value});s.setItem(key,raw);
  if(s.getItem(key)!==raw)throw Error('A gravação local não foi confirmada. Continue nesta marca e exporte o conteúdo.');
  seen.set(key,raw);return copy(value);
 }
 function campaign(brand){
  const current=read('campaign',brand);if(current){if(current.brand!==brand)throw Error('Preparação de campanha de outra marca. Os dados foram preservados.');return current;}
  if(!validBrand(brand))return null;
  const raw=store()?.getItem('shrigma_campaign_composer_v1');if(!raw)return null;
  let old;try{old=JSON.parse(raw);}catch{throw Error('O rascunho de campanha anterior não pôde ser lido. Os dados foram preservados.');}
  if(!old||Array.isArray(old)||!validBrand(old.brand))throw Error('O rascunho anterior não declara uma marca válida. Os dados foram preservados.');
  if(old.brand!==brand)return null;
  // Copy lazily to its declared brand. Never delete the legacy preparation.
  const fields=['brand','initiative_name','initiative_key','utm_campaign','name','subject','from_email','reply_to','list_ids','template_id','send_at','tags','html','text'];
  const value=Object.fromEntries(fields.filter(k=>typeof old[k]==='string').map(k=>[k,old[k]]));
  return save('campaign',brand,value);
 }
 return {validBrand,read,save,campaign};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=GBS;
