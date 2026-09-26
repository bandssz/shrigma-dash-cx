/* Preview only. No send, tracking request, clipboard payment code or live button. */
'use strict';
const GMP={
 esc:s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
 brand:r=>({fish:'Fishermans',aristo:'O Aristocrata',olivas:'Olivas do Campo'}[r.marca]||'Sua marca'),
 fill:(s,r)=>String(s||'').replace(/\{\{\s*(\d+)\s*\}\}/g,(m,n)=>r.exemplos?.[n]||m),
 format(s){return GMP.esc(s).replace(/\*([^*\n]+)\*/g,'<strong>$1</strong>').replace(/_([^_\n]+)_/g,'<em>$1</em>').replace(/~([^~\n]+)~/g,'<s>$1</s>');},
 whatsapp(r){
  const e=GMP.esc,pix=(r.botoes||[]).some(b=>b.tipo==='order_details');
  return `<div class="mp-phone"><div class="mp-chat-head"><span class="mp-avatar" aria-hidden="true">${e(GMP.brand(r).slice(0,1))}</span><div><strong>${e(GMP.brand(r))}</strong><span>Prévia da conversa</span></div><span class="mp-chat-menu" aria-hidden="true">⋮</span></div><div class="mp-chat"><span class="mp-today">Hoje</span><div class="mp-message">${pix?'<div class="mp-payment"><small>Dados ilustrativos</small><strong>Produto do pedido</strong><span>Quantidade do pedido</span><div><b>Pagar com</b><span class="mp-pix">◈ PIX</span></div><div><span>Total</span><b>R$ —</b></div></div>':''}<div class="draft-bubble">${r.cabecalho?`<div class="draft-bubble-head">${GMP.format(GMP.fill(r.cabecalho,r))}</div>`:''}<div class="draft-bubble-body">${GMP.format(GMP.fill(r.corpo,r))||'<span class="mini">Sua mensagem aparece aqui enquanto você escreve.</span>'}</div>${r.rodape?`<div class="draft-bubble-foot">${e(r.rodape)}</div>`:''}<span class="mp-time">09:41</span></div>${(r.botoes||[]).filter(b=>b.texto||b.tipo==='order_details').map(b=>`<div class="draft-bubble-btn" title="${e(b.valor||'Botão ilustrativo')}">${b.tipo==='url'?'↗':b.tipo==='phone'?'☏':b.tipo==='order_details'?'▢':'↩'} ${e(b.tipo==='order_details'?'Copiar código Pix':b.texto)}</div>`).join('')}</div></div></div><p class="mp-caption">Exemplos ilustrativos. ${pix?'Produto, valor e cobrança são preenchidos no envio. ':''}O WhatsApp pode ajustar a apresentação conforme o aparelho.</p>`;
 },
 // Same wrapper, paragraph conversion, buttons and footer as emailPayload in
 // the template creator. Variables deliberately remain unresolved in previews.
 emailHTML(r){
  const contract=typeof GEC!=='undefined'?GEC:typeof require==='function'?require('./growth-email-contract.js'):null;
  if(contract){try{return contract.html(r);}catch{return '<!doctype html><html><body><p>Complete o conteúdo do e-mail para ver a prévia.</p></body></html>';}}
  const esc=s=>GMP.esc(String(s||'')),color=r.marca==='fish'?'#414f27':'#3b1f13',name=r.marca==='fish'?'Fishermans':'O Aristocrata',raw=String(r.corpo||'');
  const content=/<[a-z][\s\S]*>/i.test(raw)?raw:raw.split(/\n\s*\n/).map(p=>'<p>'+esc(p).replace(/\n/g,'<br>')+'</p>').join('');
  const buttons=(r.botoes||[]).map(b=>'<p><a href="'+esc(b.valor)+'" style="display:inline-block;background:'+color+';color:#fff;padding:14px 22px;border-radius:6px;text-decoration:none">'+esc(b.texto)+'</a></p>').join('');
  return '<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f4f3ef;font-family:Arial,sans-serif;color:#242424"><table role="presentation" width="100%"><tr><td align="center"><table role="presentation" width="600" style="max-width:100%;background:#fff"><tr><td style="padding:28px;color:'+color+';font-size:22px;font-weight:bold">'+name+'</td></tr><tr><td style="padding:0 28px 28px;font-size:16px;line-height:1.6">'+content+buttons+(r.rodape?'<p style="font-size:12px;color:#777">'+esc(r.rodape)+'</p>':'')+'</td></tr></table></td></tr></table></body></html>';
 },
 isolate(source,images=false){
  const Parser=typeof DOMParser!=='undefined'?DOMParser:window.DOMParser,doc=new Parser().parseFromString(String(source),'text/html');
  doc.querySelectorAll('script,iframe,object,embed,form,input,button,textarea,select,base,meta,link,svg,math,audio,video,source').forEach(n=>n.remove());
  for(const n of doc.querySelectorAll('*'))for(const a of [...n.attributes]){
   const k=a.name.toLowerCase();
   if(k.startsWith('on')||['srcdoc','target','action','formaction','srcset','ping','background'].includes(k))n.removeAttribute(a.name);
   if(k==='href'){n.removeAttribute(a.name);if(n.tagName==='A')n.setAttribute('title','Link desativado na prévia');}
   if(k==='src'&&(!images||n.tagName!=='IMG'||!/^https:\/\//i.test(a.value)))n.removeAttribute(a.name);
  }
  doc.body.setAttribute('inert','');
  const policy=`default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src ${images?'https:':"'none'"}; base-uri 'none'; form-action 'none';`;
  return '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="'+GMP.esc(policy)+'"><meta name="viewport" content="width=device-width,initial-scale=1">'+doc.head.innerHTML+'<style>a{pointer-events:none!important}body{overflow-wrap:anywhere}</style></head>'+doc.body.outerHTML+'</html>';
 },
 frame(source,images=false,title='Prévia do template de e-mail'){
  return `<iframe class="mp-mail-frame" title="${GMP.esc(title)}" sandbox="" referrerpolicy="no-referrer" srcdoc="${GMP.esc(GMP.isolate(source,images))}"></iframe>`;
 },
 email(r){return `<div class="mp-mail-header"><small>De: ${GMP.esc(r.from_email||'Preencha o remetente')} · Responder para: ${GMP.esc(r.reply_to||'Preencha o e-mail de resposta')}</small><strong>${GMP.esc(r.assunto||'(sem assunto)')}</strong><small>${GMP.esc(r.preheader||'Preencha o pré-header')}</small></div>${GMP.frame(GMP.emailHTML(r))}`;},
 publishedWhatsApp(template){
  const cs=template.components;if(!Array.isArray(cs))throw Error('Conteúdo de WhatsApp indisponível.');
  const part=type=>cs.find(c=>c&&c.type===type),body=part('BODY'),header=part('HEADER'),footer=part('FOOTER');
  if(typeof body?.text!=='string'||!body.text.trim())throw Error('Conteúdo de WhatsApp indisponível.');
  // Provider examples can contain customer data. Use visibly synthetic values,
  // never example.body_text, a media URL, a payment code or button destination.
  const fill=text=>String(text||'').replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g,(_,key)=>'[Exemplo '+key+']');
  const r={marca:template.brand,corpo:fill(body.text),cabecalho:header?(header.format==='TEXT'||!header.format?fill(header.text):'['+({IMAGE:'Imagem',VIDEO:'Vídeo',DOCUMENT:'Documento',LOCATION:'Localização'}[header.format]||'Mídia')+' do envio não carregada]'):'',rodape:fill(footer?.text),botoes:(part('BUTTONS')?.buttons||[]).filter(b=>b&&typeof b.type==='string').map(b=>({tipo:({URL:'url',PHONE_NUMBER:'phone',ORDER_DETAILS:'order_details'}[b.type]||'quick_reply'),texto:typeof b.text==='string'?b.text:'Botão do template',valor:''}))};
  return GMP.whatsapp(r);
 },
 openPublished({label='Prévia do template',brand,channel,selection}){
  document.getElementById('message-preview-dialog')?.remove();
  const opener=document.activeElement,dialog=document.createElement('dialog'),e=GMP.esc;
  dialog.id='message-preview-dialog';dialog.className='mp-dialog mp-published';dialog.setAttribute('aria-label',label);
  dialog.innerHTML=`<header class="mp-dialog-head"><div><small>${e(GMP.brand({marca:brand}))} · ${channel==='email'?'E-mail':'WhatsApp'}</small><h2>${e(label)}</h2></div><button type="button" class="refresh-btn" data-mp-close aria-label="Fechar prévia">Fechar ×</button></header><div class="mp-caption mp-preview-labels"><span class="control-badge" title="Consulta o conteúdo publicado do template escolhido, sem salvar ou alterar a jornada.">Conteúdo publicado</span><span class="control-badge" title="Variáveis usam dados fictícios. Imagens externas, links e botões ficam desativados; nenhum envio é feito.">Dados fictícios ⓘ</span>${selection==='draft'?'<span class="control-badge">Seleção em rascunho</span>':''}${channel==='email'?'<span class="control-badge" title="Remetente e destinatário não fazem parte desta prévia.">Só conteúdo ⓘ</span>':''}</div><p class="mp-preview-state" role="status">Consultando conteúdo publicado…</p><div class="mp-published-content"></div>`;
  document.body.append(dialog);
  const cleanup=()=>{dialog.remove();opener?.focus?.();};dialog.addEventListener('close',cleanup);
  dialog.querySelector('[data-mp-close]').onclick=()=>{if(dialog.close)dialog.close();else cleanup();};
  if(dialog.showModal)dialog.showModal();else dialog.setAttribute('open','');dialog.querySelector('[data-mp-close]').focus();
  const current=()=>document.getElementById('message-preview-dialog')===dialog;
  const status=text=>{if(current())dialog.querySelector('[role=status]').textContent=text;};
  return {current,status,email({source,subject,checkedAt}){if(!current())return;status('Consulta '+checkedAt+' · Brasília');dialog.querySelector('.mp-published-content').innerHTML='<h3 class="mp-published-subject">'+e(subject)+'</h3>'+GMP.frame(source,false,'Conteúdo publicado com dados fictícios');},whatsapp(template,checkedAt){if(!current())return;const html=GMP.publishedWhatsApp(template);status('Consulta '+checkedAt+' · Brasília');dialog.querySelector('.mp-published-content').innerHTML=html;}};
 },
 openEmail({source,subject='',label='Prévia do e-mail'}){
  document.getElementById('message-preview-dialog')?.remove();
  const opener=document.activeElement,dialog=document.createElement('dialog');dialog.id='message-preview-dialog';dialog.className='mp-dialog';dialog.setAttribute('aria-label',label);
  dialog.innerHTML=`<header class="mp-dialog-head"><div><small>PRÉVIA DO HTML</small><h2>${GMP.esc(subject||label)}</h2></div><button type="button" class="refresh-btn" data-mp-close aria-label="Fechar prévia">Fechar ×</button></header><div class="mp-toolbar"><div role="group" aria-label="Tamanho da prévia"><button type="button" class="refresh-btn" data-mp-device="desktop" aria-pressed="true">Desktop</button><button type="button" class="refresh-btn" data-mp-device="mobile" aria-pressed="false">Celular</button></div><label><input type="checkbox" data-mp-images> Mostrar imagens externas</label></div><p class="mp-caption">Links desativados na prévia. A aparência pode variar entre aplicativos de e-mail.</p><div class="mp-mail-stage" data-device="desktop"><div data-mp-frame></div></div>`;
  document.body.append(dialog);
  const draw=()=>{dialog.querySelector('[data-mp-frame]').innerHTML=GMP.frame(source,dialog.querySelector('[data-mp-images]').checked,'HTML do e-mail em prévia ampliada');};draw();
  dialog.querySelector('[data-mp-images]').onchange=draw;
  dialog.querySelectorAll('[data-mp-device]').forEach(b=>b.onclick=()=>{dialog.querySelector('.mp-mail-stage').dataset.device=b.dataset.mpDevice;dialog.querySelectorAll('[data-mp-device]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));});
  const cleanup=()=>{dialog.remove();opener?.focus?.();};dialog.addEventListener('close',cleanup);
  dialog.querySelector('[data-mp-close]').onclick=()=>{if(dialog.close)dialog.close();else cleanup();};
  if(dialog.showModal)dialog.showModal();else dialog.setAttribute('open','');
  dialog.querySelector('[data-mp-close]').focus();
 },
};
if(typeof module!=='undefined'&&module.exports)module.exports=GMP;
