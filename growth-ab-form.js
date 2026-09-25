/* Local A/B form context. This does not allocate audiences or change its operation journal. */
'use strict';
const GABF={
 brand:null,saved:null,error:'',channel:'email',
 ids:['f-id','f-canal','f-nome','f-hip','f-var','f-met','f-efeito','f-ca','f-da','f-cb','f-db'],
 defaults:{'f-id':'','f-canal':'email','f-nome':'','f-hip':'','f-var':'assunto','f-met':'ctor','f-efeito':'1.0','f-ca':'','f-da':'','f-cb':'','f-db':''},
 el:id=>document.getElementById(id),
 values(){return Object.fromEntries(GABF.ids.map(id=>[id,GABF.el(id).value]));},
 fill(value){for(const id of GABF.ids)GABF.el(id).value=typeof value[id]==='string'?value[id]:GABF.defaults[id];GABF.channel=GABF.el('f-canal').value;},
 contextStatus(){return {dirty:GBS.validBrand(GABF.brand)&&JSON.stringify(GABF.values())!==GABF.saved};},
 preserve(){if(GABF.error)throw Error(GABF.error);if(GBS.validBrand(GABF.brand)){const value=GABF.values();GBS.save('ab',GABF.brand,value);GABF.saved=JSON.stringify(value);}},
 enter(brand,api){
  if(GABF.brand!==brand){
   let value=null;GABF.error='';try{value=GBS.read('ab',brand);}catch(e){GABF.error=e.message;}
   GABF.brand=brand;GABF.fill({...GABF.defaults,...(value||{})});
   GABF.el('form-teste').hidden=true;GABF.el('f-marca').value=brand;GABF.el('f-marca').disabled=true;
   GABF.options(api,value||GABF.defaults);GABF.saved=JSON.stringify(GABF.values());
  }else GABF.options(api);
  GABF.el('btn-novo').disabled=!GBS.validBrand(brand)||!!GABF.error;
  if(GABF.error)GABF.el('f-msg').textContent=GABF.error;
 },
 campaigns(api){return (api?.crm_campanha||[]).filter(c=>c.marca===GABF.brand&&c.canal===GABF.el('f-canal').value&&Number.isSafeInteger(Number(c.campanha_id))&&Number(c.campanha_id)>0);},
 options(api,value=GABF.values()){
  const rows=GABF.campaigns(api),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  for(const id of ['f-ca','f-cb']){
   const selected=value[id]||'',field=GABF.el(id),valid=rows.filter(c=>String(c.campanha_id)===selected).length===1;
   field.innerHTML='<option value="">— sem campanha ainda —</option>'+rows.map(c=>`<option value="${Number(c.campanha_id)}">#${Number(c.campanha_id)} · ${esc(c.nome)}</option>`).join('')+(selected&&!valid?`<option value="${esc(selected)}" disabled>Indisponível neste recorte · #${esc(selected)}</option>`:'');
   field.value=selected;
  }
 },
 valid(api){return !GABF.error&&GBS.validBrand(GABF.brand)&&['f-ca','f-cb'].every(id=>{const value=GABF.el(id).value;return !value||GABF.campaigns(api).filter(c=>String(c.campanha_id)===value).length===1;});},
 matches(teste){return teste?.marca===GABF.brand&&teste?.teste_id===GABF.el('f-id').value.trim();},
 changeChannel(api){
  const selected=['f-ca','f-cb'].some(id=>GABF.el(id).value);
  if(selected&&!GABF.valid(api)){
   if(typeof confirm!=='function'||!confirm('Trocar o canal e retirar os vínculos de campanha que não pertencem ao novo canal?')){GABF.el('f-canal').value=GABF.channel;return;}
   for(const id of ['f-ca','f-cb'])GABF.el(id).value='';
  }
  GABF.channel=GABF.el('f-canal').value;GABF.options(api);
 }
};
if(typeof module!=='undefined'&&module.exports)module.exports=GABF;
