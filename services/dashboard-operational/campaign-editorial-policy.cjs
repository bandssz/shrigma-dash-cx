'use strict';
const {randomUUID}=require('node:crypto');
// The gateway owns the single editorial policy. It never evaluates HTML,
// templates or CSS; it retains offsets for diagnostics on the original line.
const STORES=Object.freeze({aristo:'oaristocrata.com',fish:'fishermans.com.br'});
function decode(value){
 return String(value||'').replace(/&#(x[0-9a-f]+|[0-9]+);?/gi,(_m,n)=>{
  const hex=n[0].toLowerCase()==='x',cp=parseInt(hex?n.slice(1):n,hex?16:10);
  return cp>0&&cp<=1114111?String.fromCodePoint(cp):'';
 }).replace(/&(amp|lt|gt|colon|tab|newline|quot|apos);?/gi,(_m,n)=>({amp:'&',lt:'<',gt:'>',colon:':',tab:'\t',newline:'\n',quot:'"',apos:"'"})[n.toLowerCase()]);
}
function cssScripts(value,attribute=true){
 const source=attribute?decode(value):String(value),tokens=[];let i=0;
 function escaped(){i++;if(source[i]==='\r'&&source[i+1]==='\n'){i+=2;return'';}if(/[\r\n\f]/.test(source[i]||'!')){i++;return'';}const hex=/^[0-9a-f]{1,6}/i.exec(source.slice(i));if(hex){i+=hex[0].length;const cp=parseInt(hex[0],16);if(source[i]==='\r'&&source[i+1]==='\n')i+=2;else if(/[\t\n\f\r ]/.test(source[i]||'!'))i++;return cp>0&&cp<=1114111?String.fromCodePoint(cp):'';}return source[i++]||'';}
 const comment=()=>{const end=source.indexOf('*/',i+2);i=end<0?source.length:end+2;};
 while(i<source.length){
  const ch=source[i];if(/[\t\n\f\r ]/.test(ch)){i++;continue;}if(source.slice(i,i+2)==='/*'){comment();continue;}
  if(ch==='"'||ch==="'"){const quote=ch;let value='';i++;while(i<source.length&&source[i]!==quote){if(/[\r\n\f]/.test(source[i]))break;value+=source[i]==='\\'?escaped():source[i++];}if(source[i]===quote)i++;tokens.push({type:'string',value});continue;}
  if(/[a-z0-9_-]/i.test(ch)||ch==='\\'){let value='';while(i<source.length){if(source[i]==='\\'){value+=escaped();continue;}if(source.slice(i,i+2)==='/*'){comment();continue;}if(!/[a-z0-9_-]/i.test(source[i]))break;value+=source[i++];}tokens.push({type:'word',value:value.toLowerCase()});continue;}
  tokens.push({type:'punctuation',value:ch});i++;
 }
 const executable=value=>/^(?:javascript|vbscript):/i.test(value.replace(/[\u0000-\u0020\u007f]/g,''));
 for(let n=0;n<tokens.length;n++){const token=tokens[n],next=tokens[n+1];if(token.type!=='word')continue;
  if(token.value==='expression'&&next?.value==='(')return true;
  if(['-moz-binding','behavior'].includes(token.value)&&next?.value===':'&&(n===0||[';','{'].includes(tokens[n-1].value)))return true;
  if(token.value==='url'&&next?.value==='('){let value='';for(let j=n+2;j<tokens.length&&tokens[j].value!==')';j++)value+=tokens[j].value;if(executable(value))return true;}
  if(token.value==='import'&&tokens[n-1]?.value==='@'&&next?.type==='string'&&executable(next.value))return true;
 }
 return false;
}
function lineIndex(source){
 const starts=[0];for(let i=0;i<source.length;i++)if(source[i]==='\n')starts.push(i+1);
 return offset=>{let lo=0,hi=starts.length;while(lo+1<hi){const mid=(lo+hi)>>1;if(starts[mid]<=offset)lo=mid;else hi=mid;}return lo+1;};
}
// Unlike the old strict tokenizer, malformed markup does not stop inspection
// of later tags. Quoted values, ordinary comments and raw styles stay inert.
function scan(source){
 const out=[],stack=[],voidHtml=new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']),foreignBreakout=new Set(['b','big','blockquote','body','br','center','code','dd','div','dl','dt','em','embed','h1','h2','h3','h4','h5','h6','head','hr','i','img','li','listing','menu','meta','nobr','ol','p','pre','ruby','s','small','span','strong','strike','sub','sup','table','tt','u','ul','var']);let i=0,malformed=false;
 // Resolve raw text using the element namespace and HTML integration points.
 function childNamespace(parent,name){
  if(!parent)return 'html';
  if(parent.ns==='svg'&&['title','desc','foreignobject'].includes(parent.name))return 'html';
  if(parent.ns==='math'){
   if(['mi','mo','mn','ms','mtext'].includes(parent.name)&&!['mglyph','malignmark'].includes(name))return 'html';
   if(parent.name==='annotation-xml'&&/^(?:text\/html|application\/xhtml\+xml)$/i.test(decode(parent.attrs.encoding?.value)))return 'html';
  }
  return parent.ns;
 }
 while(i<source.length){
  const start=source.indexOf('<',i);if(start<0)break;
  if(source.startsWith('<!--',start)){
   const close=/-->|--!>/g;close.lastIndex=start+4;const match=close.exec(source),abrupt=source[start+4]==='>'?start+4:source.slice(start+4,start+6)==='->'?start+5:null,end=abrupt??match?.index,stop=end===undefined?source.length:abrupt!==null?end+1:end+match[0].length;
   out.push({kind:'comment',start,end:stop,content:source.slice(start+4,end===undefined?source.length:end)});
   if(end===undefined)malformed=true;i=stop;continue;
  }
  if(source.startsWith('<!',start)||source.startsWith('<?',start)){
   const end=source.indexOf('>',start+2);if(end<0){malformed=true;break;}i=end+1;continue;
  }
  const name=/^<(\/?)([a-z][a-z0-9:_-]*)/i.exec(source.slice(start));
  if(!name){i=start+1;continue;}
  const tag={kind:'tag',start,name:name[2].toLowerCase(),closing:!!name[1],attrs:{}};
  let cursor=start+name[0].length,closed=false,selfClosing=false;
  while(cursor<source.length){
   while(/[\t\n\f\r ]/.test(source[cursor]||'!'))cursor++;
   if(source[cursor]==='>'){cursor++;closed=true;break;}
   if(source[cursor]==='/'){cursor++;if(source[cursor]==='>'){cursor++;closed=true;selfClosing=true;break;}malformed=true;continue;}
   const at=cursor;
   while(cursor<source.length&&!/[\t\n\f\r />=]/.test(source[cursor]))cursor++;
   const key=source.slice(at,cursor).toLowerCase();if(!key){cursor++;malformed=true;continue;}
   while(/[\t\n\f\r ]/.test(source[cursor]||'!'))cursor++;
   let value='',valueStart=cursor;
   if(source[cursor]==='='){
    cursor++;while(/[\t\n\f\r ]/.test(source[cursor]||'!'))cursor++;
    const quote=source[cursor];
    if(quote==='"'||quote==="'"){
     valueStart=++cursor;const end=source.indexOf(quote,cursor);
     if(end<0){value=source.slice(cursor);cursor=source.length;malformed=true;}
     else{value=source.slice(cursor,end);cursor=end+1;}
    }else{
     valueStart=cursor;while(cursor<source.length&&!/[\t\n\f\r >]/.test(source[cursor]))cursor++;
     value=source.slice(valueStart,cursor);
    }
   }
   if(!Object.hasOwn(tag.attrs,key))tag.attrs[key]={value,start:at,valueStart};
  }
  let ns=childNamespace(stack.at(-1),tag.name);
  if(ns!=='html'&&(tag.closing?['p','br'].includes(tag.name):foreignBreakout.has(tag.name)||tag.name==='font'&&['color','face','size'].some(k=>Object.hasOwn(tag.attrs,k)))){while(stack.length&&childNamespace(stack.at(-1),tag.name)!=='html')stack.pop();ns='html';}
  if(!tag.closing&&ns==='html'&&['svg','math'].includes(tag.name))ns=tag.name;
  tag.ns=ns;tag.end=cursor;out.push(tag);i=cursor;if(!closed)malformed=true;
  if(tag.closing){for(let n=stack.length-1;n>=0;n--)if(stack[n].name===tag.name){stack.length=n;break;}}
  else if(!(ns==='html'?voidHtml.has(tag.name):selfClosing))stack.push(tag);
  if(!tag.closing&&!selfClosing&&ns!=='html'&&tag.name==='style'){const close=/<\/style(?=[\t\n\f\r />])/ig;close.lastIndex=i;const match=close.exec(source),end=match?match.index:source.length;out.push({kind:'raw',name:'style',start:i,end,content:source.slice(i,end)});}
  if(!tag.closing&&ns==='html'&&['script','style','textarea','title','iframe','xmp','noembed','noframes','plaintext'].includes(tag.name)){
   if(tag.name==='plaintext'){out.push({kind:'raw',name:tag.name,start:i,end:source.length,content:source.slice(i)});break;}
   const close=new RegExp('</'+tag.name+'(?=[\\t\\n\\f\\r />])','ig');close.lastIndex=i;
   const match=close.exec(source),end=match?match.index:source.length;
   out.push({kind:'raw',name:tag.name,start:i,end,content:source.slice(i,end)});
   if(!match){malformed=true;break;}i=end;
  }
 }
 return{tokens:out,malformed};
}
function review({html='',text='',brand,campaign}={}){
 if(!Object.hasOwn(STORES,brand))throw Object.assign(Error('EDITORIAL_BRAND_REQUIRED'),{code:'EDITORIAL_BRAND_REQUIRED'});
 const original=String(html),plain=String(text),store=STORES[brand],diagnostics=[],seen=new Set(),htmlLine=lineIndex(original),textLine=lineIndex(plain);
 let blocked=false,commercial=0,truncated=false;
 function add(code,severity,offset,message,field='html'){
  if(severity==='block')blocked=true;
  const line=(field==='text'?textLine:htmlLine)(Math.max(0,offset)),key=[field,line,code].join(':');
  if(seen.has(key))return;seen.add(key);
  const item={code,line,severity,message,field};
  if(diagnostics.length<200)diagnostics.push(item);
  else{truncated=true;if(severity==='block'&&!diagnostics.some(x=>x.severity==='block'))diagnostics[199]=item;}
 }
 const scriptProtocol=value=>/^(?:javascript|vbscript):/i.test(decode(value).replace(/[\u0000-\u0020\u007f]/g,''));
 function destination(raw,offset,field,base){
  const value=decode(raw).trim();
  if(/^(?:javascript|vbscript):/i.test(value.replace(/[\u0000-\u0020\u007f]/g,''))){add('SCRIPT','block',offset,'Remova o código executável deste destino.',field);return;}
  if(!value||value[0]==='#'||/^\{\{\s*\.?UnsubscribeURL\s*\}\}$/.test(value))return;
  const dynamic=value.includes('{{')||value.includes('}}'),marker='shrigmadynamic'+randomUUID().replaceAll('-','');
  if(dynamic)add('DYNAMIC_DESTINATION','warning',offset,'Confira o destino na prévia nativa.',field);
  if(/^(?:mailto|tel):/i.test(value)){add('CONTACT_DESTINATION','warning',offset,'Confira este link de contato.',field);return;}
  const masked=value.replace(/\{\{[\s\S]*?(?:\}\}|$)/g,marker).replace(/\}\}/g,marker);
  let u;try{u=new URL(masked,base);}catch{add('DESTINATION_SYNTAX','warning',offset,'Confira a sintaxe deste destino.',field);return;}
  const local=target=>target.hostname.includes(marker)?null:![store,'www.'+store].includes(target.hostname)||target.port?false:target.protocol.includes(marker)?null:['https:','http:'].includes(target.protocol);
  if(local(u)===false){add('OUTSIDE_STORE','block',offset,'O destino precisa permanecer na loja desta marca.',field);return;}
  if(u.username||u.password)add('URL_CREDENTIALS','warning',offset,'Confira as credenciais presentes neste endereço.',field);
  if(u.protocol==='http:')add('HTTP_DESTINATION','warning',offset,'Prefira HTTPS neste destino.',field);
  let target=u;
  if(u.searchParams.has('redirect')){
   let rawTarget=u.searchParams.get('redirect');
   for(let n=0;n<3;n++){let next;try{next=decodeURIComponent(rawTarget);}catch{break;}if(next===rawTarget)break;rawTarget=next;}
   try{target=new URL(rawTarget,u.origin);}catch{target=null;}
   if(!target||local(target)===false){add('REDIRECT','block',offset,'O redirecionamento precisa permanecer na loja desta marca.',field);return;}
  }else if(u.pathname.startsWith('/discount/'))add('COUPON_DESTINATION_REQUIRED','warning',offset,'Confira o destino deste cupom antes do envio.',field);
  if(/^\/(?:products|pages|collections)\//.test(target.pathname))commercial++;
  if(campaign&&target.searchParams.getAll('utm_campaign').some(v=>v&&v!==campaign))add('UTM_CONFLICT','warning',offset,'O link usa outra identificação de campanha.',field);
 }
 function inspect(source,{offset=0,fixedOffset=null,depth=0,base='https://'+store+'/'}={}){
  if(depth>12)throw Object.assign(Error('EDITORIAL_STRUCTURE_LIMIT'),{code:'EDITORIAL_STRUCTURE_LIMIT',status:413});
  const parsed=scan(source),at=position=>fixedOffset===null?offset+position:fixedOffset;
  if(parsed.malformed)add('HTML_SYNTAX','warning',at(0),'Confira o fechamento das tags e aspas.');
  const firstBase=parsed.tokens.find(t=>t.kind==='tag'&&!t.closing&&t.name==='base'&&t.attrs.href);
  if(firstBase)try{base=new URL(decode(firstBase.attrs.href.value),base).href;}catch{}
  for(const t of parsed.tokens){
   if(t.kind==='comment'){
    if(/^\s*\[if\b/i.test(t.content))inspect(t.content,{offset:offset+t.start+4,fixedOffset,depth:depth+1,base});
    continue;
   }
   if(t.kind==='raw'){
    if(t.name==='style'&&cssScripts(t.content,false))add('SCRIPT','block',at(t.start),'Remova o código executável do estilo.');
    continue;
   }
   if(t.kind!=='tag'||t.closing)continue;
   const attrs=t.attrs,name=t.name.split(':').at(-1),where=at(t.start);
   if(name==='script')add('SCRIPT','block',where,'Remova o script do e-mail.');
   for(const [key,attr]of Object.entries(attrs)){
    const attrAt=at(attr.start);
    if(/^on[a-z]/i.test(key))add('SCRIPT','block',attrAt,'Remova o evento executável desta tag.');
    if(key==='style'&&cssScripts(attr.value))add('SCRIPT','block',attrAt,'Remova o código executável do estilo.');
    if(['href','xlink:href','src','data','action','formaction','background','poster'].includes(key)&&scriptProtocol(attr.value))add('SCRIPT','block',attrAt,'Remova o código executável deste destino.');
   }
   if(name==='meta'&&decode(attrs['http-equiv']?.value).replace(/[\u0000-\u0020\u007f]/g,'').toLowerCase()==='refresh')add('REDIRECT','block',where,'Remova o redirecionamento automático do e-mail.');
   const nav=name==='a'||name==='area'||name==='base'?['href','xlink:href']:name==='form'?['action']:name==='iframe'||name==='embed'?['src']:name==='object'?['data']:[];
   for(const key of [...nav,'formaction'])if(attrs[key])destination(attrs[key].value,at(attrs[key].start),'html',base);
   if(name==='iframe'&&attrs.srcdoc)inspect(decode(attrs.srcdoc.value),{fixedOffset:where,depth:depth+1,base});
   if(['animate','set','animatetransform','animatemotion'].includes(name)&&/^(?:href|xlink:href|src)$/i.test(decode(attrs.attributename?.value)))for(const key of ['to','from','values'])if(attrs[key]?.value.split(';').some(scriptProtocol))add('SCRIPT','block',where,'Remova o destino executável desta animação.');
   if(['iframe','object','embed','form','input','button','select','textarea','svg','math','base'].includes(name))add('EMAIL_INTERACTIVE','warning',where,'Este elemento pode não funcionar em alguns leitores de e-mail.');
   if(name==='link')add('EXTERNAL_RESOURCE','warning',where,'Confira a disponibilidade deste recurso no leitor de e-mail.');
  }
 }
 inspect(original);
 for(const match of original.matchAll(/\{\{[\s\S]*?\}\}/g))if(!/^\{\{\s*\.?UnsubscribeURL\s*\}\}$/.test(match[0]))add('TEMPLATE_EXPRESSION','warning',match.index,'Confira a variável ou expressão na prévia nativa.');
 if(!/\{\{\s*\.?UnsubscribeURL\s*\}\}/.test(original))add('UNSUBSCRIBE_REVIEW','warning',0,'Confira o descadastro no modelo nativo antes de enviar.');
 for(const match of plain.matchAll(/https?:\/\/[^\s<>"']+/g))destination(match[0],match.index,'text','https://'+store+'/');
 if(!commercial)add('NO_COMMERCIAL_LINK','warning',0,'Confira se a peça precisa de um link de produto, página ou coleção.');
 diagnostics.sort((x,y)=>x.field.localeCompare(y.field)||x.line-y.line||x.code.localeCompare(y.code));
 return{schema:'crm-editorial-policy-v1',brand,ok:!blocked,diagnostics,truncated};
}
module.exports=Object.freeze({review,STORES});
