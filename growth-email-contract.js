/* Shared email envelope and rendering rules. No transport or recipient selection. */
'use strict';
const GEC={
 BRANDS:{fish:{name:'Fishermans',domain:'fishermans.com.br',color:'#414f27'},aristo:{name:'O Aristocrata',domain:'oaristocrata.com',color:'#3b1f13'}},
 FIELDS:['from_email','reply_to','preheader'],
 esc:s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
 // A bounded lexical reader, not a DOM serializer. Offsets preserve the original document.
 htmlTag(source,start){
  let i=start+1,closing=false;if(source[i]==='/'){closing=true;i++;}
  const begin=i;while(/[A-Za-z0-9:_-]/.test(source[i]||'')&&i<source.length)i++;
  const name=source.slice(begin,i).toLowerCase();if(!/^[a-z][a-z0-9:_-]*$/.test(name))return null;
  const attrs=Object.create(null);let selfClosing=false;
  while(i<source.length){
   const before=i;while(/[\t\n\f\r ]/.test(source[i]||'')&&i<source.length)i++;
   if(source[i]==='>')return {type:'tag',start,end:i+1,name,closing,selfClosing,attrs};
   if(source[i]==='/'&&source[i+1]==='>'){selfClosing=true;return closing?null:{type:'tag',start,end:i+2,name,closing,selfClosing,attrs};}
   if(closing||i===before)return null;
   const attrStart=i;while(i<source.length&&!/[\t\n\f\r =/>]/.test(source[i]))i++;
   const attr=source.slice(attrStart,i).toLowerCase();if(!/^[a-z_:][a-z0-9:_.-]*$/.test(attr)||Object.hasOwn(attrs,attr))return null;
   const attrEnd=i;while(/[\t\n\f\r ]/.test(source[i]||'')&&i<source.length)i++;
   let value=null;
   if(source[i]==='='){
    i++;while(/[\t\n\f\r ]/.test(source[i]||'')&&i<source.length)i++;
    const quote=source[i];
    if(quote==='"'||quote==="'"){const valueStart=++i;while(i<source.length&&source[i]!==quote)i++;if(i===source.length)return null;value=source.slice(valueStart,i++);}
    else{const valueStart=i;while(i<source.length&&!/[\t\n\f\r >]/.test(source[i]))i++;value=source.slice(valueStart,i);if(!value||/["'`=<>]/.test(value))return null;}
   }else i=attrEnd;
   attrs[attr]=value;
  }
  return null;
 },
 htmlTokens(source){
  source=String(source||'');const tokens=[];let i=0,textStart=0,rawName='';
  const text=end=>{if(end>textStart)tokens.push({type:rawName?'raw':'text',name:rawName,start:textStart,end});};
  while(i<source.length){
   if(rawName){
    // HTML raw text ends on its literal closing tag, independently of CSS/JS quoting.
    if(source[i]==='<'&&source[i+1]==='/'&&source.slice(i+2,i+2+rawName.length).toLowerCase()===rawName&&/[\t\n\f\r >]/.test(source[i+2+rawName.length]||'')){
     const tag=GEC.htmlTag(source,i);if(!tag)return {ok:false,tokens};text(i);tokens.push(tag);rawName='';i=tag.end;textStart=i;continue;
    }
    i++;continue;
   }
   if(source[i]!=='<'){i++;continue;}
   text(i);
   if(source.startsWith('<!--',i)){
    const end=source.indexOf('-->',i+4);if(end<0)return {ok:false,tokens};tokens.push({type:'comment',start:i,end:end+3});i=end+3;
   }else if(/^<!doctype\s/i.test(source.slice(i,i+11))){
    let j=i+2,quote='';for(;j<source.length;j++){const ch=source[j];if(quote){if(ch===quote)quote='';}else if(ch==='"'||ch==="'")quote=ch;else if(ch==='>')break;else if(ch==='<')return {ok:false,tokens};}
    if(j===source.length)return {ok:false,tokens};tokens.push({type:'declaration',start:i,end:j+1});i=j+1;
   }else{
    const tag=GEC.htmlTag(source,i);if(!tag)return {ok:false,tokens};tokens.push(tag);i=tag.end;
    if(!tag.closing&&['style','script'].includes(tag.name))rawName=tag.name;
   }
   textStart=i;
  }
  text(i);return {ok:!rawName,tokens};
 },
 passiveMeta(tag){
  if(!tag||tag.name!=='meta'||tag.closing)return false;
  const a=tag.attrs,keys=Object.keys(a).sort().join(',');
  if(keys==='charset')return /^utf-8$/i.test(a.charset||'');
  if(keys==='content,http-equiv')return /^content-type$/i.test(a['http-equiv']||'')&&/^text\/html;\s*charset=utf-8$/i.test(a.content||'');
  if(keys!=='content,name')return false;
  const name=String(a.name||'').toLowerCase(),content=String(a.content||'').trim().toLowerCase().replace(/[ \t\n\f\r]+/g,' ');
  if(name==='color-scheme')return ['light dark','light only'].includes(content);
  if(name==='supported-color-schemes')return ['light dark','light'].includes(content);
  if(name!=='viewport')return false;
  const parts=String(a.content||'').toLowerCase().split(',').map(p=>p.trim());
  return parts.length===2&&parts.some(p=>/^width\s*=\s*device-width$/.test(p))&&parts.some(p=>/^initial-scale\s*=\s*1(?:\.0+)?$/.test(p));
 },
 passiveFontLink(tag){
  if(!tag||tag.name!=='link'||tag.closing||Object.keys(tag.attrs).sort().join(',')!=='href,rel')return false;
  const a=tag.attrs;if(!/^stylesheet$/i.test(a.rel||'')||typeof a.href!=='string'||a.href.length>4096)return false;
  // Canonical provider/path only. Do not normalize hosts, redirects or relative URLs.
  const match=a.href.replace(/&amp;/g,'&').match(/^https:\/\/fonts\.googleapis\.com\/css2\?([^\s"'<>`\\{}#]+)$/);
  if(!match)return false;
  let families=0,display=0;const parts=match[1].split('&');if(parts.length>16)return false;
  for(const part of parts){
   const pair=part.match(/^(family|display)=([^=]+)$/);if(!pair)return false;
   let value;try{value=decodeURIComponent(pair[2].replace(/\+/g,' '));}catch(_){return false;}
   if(pair[1]==='family'){if(!/^[A-Za-z][A-Za-z0-9 +:,@;.\-]{0,511}$/.test(value))return false;families++;}
   else{if(++display>1||!['auto','block','swap','fallback','optional'].includes(value))return false;}
  }
  return families>0;
 },
 htmlSafety(source){
  const parsed=GEC.htmlTokens(source);if(!parsed.ok)return 'EMAIL_HTML_MALFORMED';
  // Keep active content forbidden, including content hidden in Outlook comments.
  if(/<\s*(?:script|iframe|object|embed|form|input|button|select|textarea|base|svg|math)\b|\bon[a-z]+\s*=/i.test(source))return 'EMAIL_ACTIVE_CONTENT';
  let normalized=String(source).replace(/&#(x[0-9a-f]+|[0-9]+);?/gi,(_,n)=>{const hex=n[0].toLowerCase()==='x',cp=parseInt(hex?n.slice(1):n,hex?16:10);return cp<=0x10ffff?String.fromCodePoint(cp):'';}).replace(/&(colon|tab|newline);?/gi,(_,n)=>({colon:':',tab:'\t',newline:'\n'}[n.toLowerCase()])).replace(/\\([0-9a-f]{1,6})\s?/gi,(_,n)=>String.fromCodePoint(Math.min(parseInt(n,16),0x10ffff))).replace(/\\([():])/g,'$1');
  normalized=normalized.replace(/[\u0000-\u0020\u007f]/g,'');
  if(/(?:javascript|vbscript|data):|expression\(|-moz-binding:/i.test(normalized))return 'EMAIL_ACTIVE_CONTENT';
  for(const token of parsed.tokens){
   if(token.type==='tag'&&token.name==='meta'&&!GEC.passiveMeta(token))return 'EMAIL_META_UNSUPPORTED';
   if(token.type==='comment'&&/<\s*meta\b/i.test(source.slice(token.start,token.end)))return 'EMAIL_META_UNSUPPORTED';
   if(token.type==='tag'&&token.name==='link'&&!GEC.passiveFontLink(token))return 'EMAIL_LINK_UNSUPPORTED';
   if(token.type==='comment'&&/<\s*link\b/i.test(source.slice(token.start,token.end)))return 'EMAIL_LINK_UNSUPPORTED';
  }
  return null;
 },
 templateExpressions(source,html=false){
  source=String(source||'');const parts=html?GEC.htmlTokens(source):{ok:true,tokens:[{type:'text',start:0,end:source.length}]},keys=new Set();let unsupported=!parts.ok;
  for(const t of parts.tokens){
   const part=source.slice(t.start,t.end);
   // Adjacent CSS block closures are literal CSS, never a Go-template delimiter.
   const rest=part.replace(/\{\{\s*\.Tx\.Data\.([A-Za-z][A-Za-z0-9_]{0,63})\s*\}\}/g,(_,key)=>{keys.add(key);return '';});
   if(rest.includes('{{')||(!(t.type==='raw'&&t.name==='style')&&rest.includes('}}')))unsupported=true;
  }
  return {keys:[...keys],unsupported};
 },
 variablesInText(source){
  const parsed=GEC.htmlTokens(source);if(!parsed.ok)return false;
  return parsed.tokens.every(t=>t.type==='text'||!source.slice(t.start,t.end).includes('{{'));
 },
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
   const parsed=GEC.htmlTokens(raw);if(!parsed.ok)throw Error('EMAIL_HTML_MALFORMED');
   const body=parsed.tokens.find(t=>t.type==='tag'&&t.name==='body'&&!t.closing);if(!body)throw Error('EMAIL_BODY_REQUIRED');
   if((r.botoes||[]).length||r.rodape)throw Error('EMAIL_DOCUMENT_EXTRAS');
   return raw.slice(0,body.end)+preheader+raw.slice(body.end);
  }
  const content=/<[a-z][\s\S]*>/i.test(raw)?raw:raw.split(/\n\s*\n/).map(p=>'<p>'+esc(p).replace(/\n/g,'<br>')+'</p>').join('');
  const buttons=(r.botoes||[]).map(b=>'<p><a href="'+esc(b.valor)+'" style="display:inline-block;background:'+brand.color+';color:#fff;padding:14px 22px;border-radius:6px;text-decoration:none">'+esc(b.texto)+'</a></p>').join('');
  return '<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f4f3ef;font-family:Arial,sans-serif;color:#242424">'+preheader+'<table role="presentation" width="100%"><tr><td align="center"><table role="presentation" width="600" style="max-width:100%;background:#fff"><tr><td style="padding:28px;color:'+brand.color+';font-size:22px;font-weight:bold">'+brand.name+'</td></tr><tr><td style="padding:0 28px 28px;font-size:16px;line-height:1.6">'+content+buttons+(r.rodape?'<p style="font-size:12px;color:#777">'+esc(r.rodape)+'</p>':'')+'</td></tr></table></td></tr></table></body></html>';
 },
 documentErrors(r){
  if(r?.canal!=='email')return [];
  try{
   const raw=String(r.corpo||'');
   if(/<!--|<!doctype\b|<\/?[a-z]/i.test(raw)){const rawUnsafe=GEC.htmlSafety(raw);if(rawUnsafe)throw Error(rawUnsafe);}
   const html=GEC.html(r),unsafe=GEC.htmlSafety(html);if(unsafe)throw Error(unsafe);return [];
  }catch(e){
   const messages={EMAIL_DOCUMENT_EXTRAS:'O HTML completo deve incluir seus próprios botões e rodapé. Remova os campos extras ou use um fragmento.',EMAIL_BODY_REQUIRED:'O HTML completo precisa de uma seção body.',EMAIL_HTML_MALFORMED:'Confira o HTML: há uma tag, aspas ou comentário sem fechamento válido.',EMAIL_ACTIVE_CONTENT:'Remova scripts, formulários e conteúdo interativo do e-mail.',EMAIL_META_UNSUPPORTED:'Use apenas metadados UTF-8, viewport padrão e esquemas de cores permitidos. Redirecionamentos e outras instruções meta não são permitidos.',EMAIL_LINK_UNSUPPORTED:'Use apenas a folha de fontes Google Fonts permitida. Outros recursos externos via link não são aceitos.'};
   return [{codigo:'EMAIL_CONTENT',campo:'corpo',mensagem:messages[e.message]||'Escolha a marca do e-mail.'}];
  }
 },
 payload:r=>({name:'CRM '+r.marca+' · '+r.nome,type:'tx',subject:r.assunto,body:GEC.html(r)})
};
if(typeof module!=='undefined'&&module.exports)module.exports=GEC;
