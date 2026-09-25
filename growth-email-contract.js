/* Shared email envelope and rendering rules. No transport or recipient selection. */
'use strict';
const GEC={
 BRANDS:{fish:{name:'Fishermans',domain:'fishermans.com.br',color:'#414f27'},aristo:{name:'O Aristocrata',domain:'oaristocrata.com',color:'#3b1f13'}},
 FIELDS:['from_email','reply_to','preheader'],
 esc:s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
 envelopeErrors(r){
  if(r?.canal!=='email')return [];
  const errors=[],add=(campo,mensagem)=>errors.push({codigo:'EMAIL_ENVELOPE',campo,mensagem}),brand=GEC.BRANDS[r.marca];
  if(!brand){add('marca','Escolha Fishermans ou O Aristocrata.');return errors;}
  const mailbox='[A-Za-z0-9.!#$%&\u0027*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+',from=String(r.from_email??''),reply=String(r.reply_to??'');
  const address=from.match(new RegExp('^('+mailbox+')$'))?.[1]||from.match(new RegExp('^[^<>,;:@\\r\\n]+<('+mailbox+')>$'))?.[1];
  if(!address||from.length>254||/[\r\n\u0000-\u001f\u007f]/.test(from)||address.split('@')[1].toLowerCase()!==brand.domain)add('from_email','Informe um remetente com o domínio de '+brand.name+'.');
  if(!new RegExp('^'+mailbox+'$').test(reply)||reply.length>254||/[\r\n\u0000-\u001f\u007f]/.test(reply)||reply.split('@')[1].toLowerCase()!==brand.domain)add('reply_to','Informe um e-mail de resposta com o domínio de '+brand.name+'.');
  if(typeof r.preheader!=='string'||!r.preheader.trim()||r.preheader.length>200||/[\r\n\u0000-\u001f\u007f]/.test(r.preheader))add('preheader','Escreva um pré-header de 1 a 200 caracteres, em uma linha.');
  if(String(r.preheader||'').includes('{{')||String(r.preheader||'').includes('}}'))add('preheader','Use texto simples no pré-header.');
  return errors;
 },
 draft(r){
  const brand=GEC.BRANDS[r?.marca];if(r?.canal!=='email'||!brand)return r;
  return {from_email:brand.name+' <contato@'+brand.domain+'>',reply_to:'contato@'+brand.domain,preheader:'',...r};
 },
 hasEnvelope:r=>GEC.FIELDS.some(k=>Object.hasOwn(r||{},k)),
 preheaderHTML:r=>r.preheader?'<div data-crm-preheader="1" style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;max-height:0;overflow:hidden;mso-hide:all">'+GEC.esc(r.preheader)+'</div>':'',
 html(r){
  const brand=GEC.BRANDS[r.marca];if(!brand)throw Error('EMAIL_BRAND_REQUIRED');
  const esc=GEC.esc,raw=String(r.corpo||''),preheader=GEC.preheaderHTML(r);
  // Complete documents retain their own layout; fragments/plain text use the brand shell.
  if(/<html(?:\s|>)/i.test(raw)){
   if(!/<body(?:\s[^>]*)?>/i.test(raw))throw Error('EMAIL_BODY_REQUIRED');
   if((r.botoes||[]).length||r.rodape)throw Error('EMAIL_DOCUMENT_EXTRAS');
   return raw.replace(/(<body(?:\s[^>]*)?>)/i,'$1'+preheader);
  }
  const content=/<[a-z][\s\S]*>/i.test(raw)?raw:raw.split(/\n\s*\n/).map(p=>'<p>'+esc(p).replace(/\n/g,'<br>')+'</p>').join('');
  const buttons=(r.botoes||[]).map(b=>'<p><a href="'+esc(b.valor)+'" style="display:inline-block;background:'+brand.color+';color:#fff;padding:14px 22px;border-radius:6px;text-decoration:none">'+esc(b.texto)+'</a></p>').join('');
  return '<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f4f3ef;font-family:Arial,sans-serif;color:#242424">'+preheader+'<table role="presentation" width="100%"><tr><td align="center"><table role="presentation" width="600" style="max-width:100%;background:#fff"><tr><td style="padding:28px;color:'+brand.color+';font-size:22px;font-weight:bold">'+brand.name+'</td></tr><tr><td style="padding:0 28px 28px;font-size:16px;line-height:1.6">'+content+buttons+(r.rodape?'<p style="font-size:12px;color:#777">'+esc(r.rodape)+'</p>':'')+'</td></tr></table></td></tr></table></body></html>';
 },
 documentErrors(r){
  if(r?.canal!=='email')return [];
  try{GEC.html(r);return [];}catch(e){return [{codigo:'EMAIL_CONTENT',campo:'corpo',mensagem:e.message==='EMAIL_DOCUMENT_EXTRAS'?'O HTML completo deve incluir seus próprios botões e rodapé. Remova os campos extras ou use um fragmento.':e.message==='EMAIL_BODY_REQUIRED'?'O HTML completo precisa de uma seção body.':'Escolha a marca do e-mail.'}];}
 },
 payload:r=>({name:'CRM '+r.marca+' · '+r.nome,type:'tx',subject:r.assunto,body:GEC.html(r)})
};
if(typeof module!=='undefined'&&module.exports)module.exports=GEC;
