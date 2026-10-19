'use strict';
const GEC=require('../../../../growth-email-contract.js');
 const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i,REF=/^d_[A-Za-z0-9_-]{1,96}$/,HEX=/^[a-f0-9]{64}$/;
 const canonical=x=>JSON.stringify(x,(_k,v)=>v&&Object.getPrototypeOf(v)===Object.prototype?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
 const bytes=s=>new TextEncoder().encode(s).byteLength;
 const fail=code=>{throw Object.assign(Error(code),{code});};
 // The shared renderer validates TX fields. Campaign pieces also contain the
 // native unsubscribe action. Mask only that exact action while checking HTML;
 // restore its original bytes in the preview/campaign document, never evaluate it.
 function emailHTML(r){
  const prefix='SHRIGMA_IMPORT_UNSUBSCRIBE_',actions=[],raw=String(r?.corpo||'');if(raw.includes(prefix))fail('IMPORT_DRAFT_CONTENT');
  const masked=raw.replace(/\{\{\s*\.?UnsubscribeURL\s*\}\}/g,token=>{if(actions.length>=32)fail('IMPORT_DRAFT_CONTENT');const marker=prefix+actions.length+'_END';actions.push({marker,token});return marker;}),copy={...r,corpo:masked};
  const parsed=GEC.htmlTokens(masked);for(const t of parsed.tokens||[])if(t.type==='tag'&&(t.name.includes(prefix.toLowerCase())||Object.entries(t.attrs).some(([key,value])=>key.includes(prefix.toLowerCase())||typeof value==='string'&&value.includes(prefix)&&(key!=='href'||!actions.some(a=>a.marker===value)))))fail('IMPORT_DRAFT_CONTENT');else if(t.type==='raw'&&masked.slice(t.start,t.end).includes(prefix))fail('IMPORT_DRAFT_CONTENT');
  const errors=GEC.documentErrors(copy);if(errors.length)throw Object.assign(Error('IMPORT_HTML'),{code:'IMPORT_HTML',message:errors[0].mensagem});
  let html=GEC.html(copy);for(const {marker,token}of actions)html=html.replaceAll(marker,token);return html;
 }
 function prepare(input,brand){
  if(!['aristo','fish'].includes(brand)||!input||!['html','text'].includes(input.format))fail('IMPORT_SCOPE');
  const nome=String(input.name||'').trim(),assunto=String(input.subject||'').trim(),content=String(input.content||'');
  if(!nome||nome.length>120)fail('IMPORT_NAME');if(!assunto||assunto.length>250)fail('IMPORT_SUBJECT');
  if(!content.trim())fail('IMPORT_CONTENT');if(bytes(content)>200000)fail('IMPORT_TOO_LARGE');
  const corpo=input.format==='text'?content.split(/\r?\n\s*\r?\n/).map(p=>'<p>'+GEC.esc(p).replace(/\r?\n/g,'<br>')+'</p>').join(''):content;
  if(bytes(corpo)>200000)fail('IMPORT_TOO_LARGE');
  const rascunho={marca:brand,canal:'email',nome,assunto,corpo,idioma:'pt_BR',categoria:'MARKETING',peca:'campanha',cabecalho:'',rodape:'',exemplos:{},botoes:[]};
  if(bytes(canonical({acao:'rascunho',rascunho,draft_id:null,expected_version:null,confirm:null}))>290000)fail('IMPORT_TOO_LARGE');
  emailHTML(rascunho);
  return rascunho;
 }
 function fromDraft(d,brand){
  if(!d||!REF.test(d.draft_id||'')||d.brand!==brand||d.channel!=='email'||!Number.isSafeInteger(d.version)||d.version<1||d.rascunho?.marca!==brand||d.rascunho?.canal!=='email')fail('IMPORT_DRAFT_SCOPE');
  const r=d.rascunho;if(typeof r.nome!=='string'||typeof r.assunto!=='string'||typeof r.corpo!=='string'||bytes(r.corpo)>300000)fail('IMPORT_DRAFT_CONTENT');let html;try{html=emailHTML(r);}catch{fail('IMPORT_DRAFT_CONTENT');}
  return {id:d.draft_id,version:d.version,name:r.nome,subject:r.assunto,html,rawHtml:r.corpo,draft:d};
 }
 function list(raw,brand){if(raw?.contract!=='crm-model-drafts-v1'||raw.brand!==brand||!Array.isArray(raw.drafts)||raw.drafts.length>20)fail('IMPORT_LIST_SCOPE');return raw.drafts.map(d=>{try{return fromDraft(d,brand);}catch(e){if(e.code!=='IMPORT_DRAFT_CONTENT')throw e;return {id:d.draft_id,version:d.version,name:typeof d.rascunho.nome==='string'?d.rascunho.nome:'Rascunho',unavailable:true};}});}
 function request(rascunho){return {acao:'rascunho',rascunho,draft_id:null,expected_version:null,confirm:null};}

function fontLinksAllowed(html){const parsed=GEC.htmlTokens(String(html));return parsed.ok&&parsed.tokens.filter(t=>t.type==='tag'&&t.name==='link').every(t=>GEC.passiveFontLink(t));}
module.exports=Object.freeze({prepare,fromDraft,list,request,canonical,emailHTML,fontLinksAllowed});
