/* Local-only e-mail copy. Explicit URL review; no provider calls or identity reuse. */
'use strict';
const GER=(()=>{
 const contract=()=>typeof GEC!=='undefined'?GEC:require('./growth-email-contract.js');
 const drafts=()=>typeof GR!=='undefined'?GR:require('./growth-drafts.js');
 const clone=v=>JSON.parse(JSON.stringify(v));
 const fail=message=>{throw Error(message);};
 const decode=(s,percent=true)=>{
  let out=String(s);
  for(let i=0;i<3;i++){
   out=out.replace(/&#(x[0-9a-f]+|[0-9]+);?/gi,(_,n)=>{const c=parseInt(n[0].toLowerCase()==='x'?n.slice(1):n,n[0].toLowerCase()==='x'?16:10);return c<=0x10ffff?String.fromCodePoint(c):'';}).replace(/&(amp|colon|sol|period|commat|quot|apos);/gi,(_,n)=>({amp:'&',colon:':',sol:'/',period:'.',commat:'@',quot:'"',apos:"'"}[n.toLowerCase()])).replace(/\\([0-9a-f]{1,6})\s?/gi,(_,n)=>String.fromCodePoint(Math.min(parseInt(n,16),0x10ffff))).replace(/\\([/:.])/g,'$1');
   if(percent)out=out.replace(/(?:%[0-9a-f]{2})+/gi,part=>{try{return decodeURIComponent(part);}catch(_){return part.replace(/%([0-9a-f]{2})/gi,(_,n)=>String.fromCharCode(parseInt(n,16)));}});
  }
  return out;
 };
 const brandText=(s,from,to)=>String(s).replace(from==='fish'?/fishermans/gi:/o\s+aristocrata|aristocrata/gi,contract().BRANDS[to].name).replace(from==='fish'?/(?<![a-z0-9])fish(?![a-z0-9])/gi:/(?<![a-z0-9])aristo(?![a-z0-9])/gi,to).replace(new RegExp(contract().BRANDS[from].color,'gi'),contract().BRANDS[to].color);
 const sourceRemains=(s,from)=>{const text=decode(s).toLowerCase();return text.includes(contract().BRANDS[from].domain)|| (from==='fish'?/fishermans|(?<![a-z0-9])fish(?![a-z0-9])/i:/aristocrata|(?<![a-z0-9])aristo(?![a-z0-9])/i).test(text);};
 // Exact transport fields; ordinary product/variant/id parameters are deliberately untouched.
 const transportKeys=new Set(['crm_dispatch_id','dispatch_id','subscriber_id','subscriber_uuid','sub_uuid','campaign_id','campaign_uuid','camp_uuid','list_id','list_ids','claim_token','journey_entry_id','crm_test','utm_id','utm_term']);
 const uuid='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
 const personalPath=new RegExp('^/(?:link/'+uuid+'/'+uuid+'/'+uuid+'|campaign/'+uuid+'/'+uuid+'(?:/px\\.png)?|subscription/(?:'+uuid+'/'+uuid+'|(?:optin|export|wipe)/'+uuid+'))/?$','i');
 const transportValue=value=>/(?:^|[^a-z0-9])lm-\d+(?:$|[^a-z0-9])|(?:^|[^a-z0-9])(?:crm[_-])?dispatch[=:_-]/i.test(decode(value))||new RegExp('(?:^|[^a-z0-9])'+uuid+'(?:$|[^a-z0-9])','i').test(decode(value));
 function tracking(raw,{inherited=false}={},depth=0){
  const literal=decode(raw,false).replace(/@TrackLink$/,''),relative=literal.startsWith('/')&&!literal.startsWith('//');let u;
  try{u=new URL(literal.startsWith('//')?'https:'+literal:literal,'https://replication.invalid');}catch(_){return {url:literal,removed:[],directRequired:false};}
  if(!/^https?:$/.test(u.protocol)||!/^https?:\/\/|^\//i.test(literal))return {url:literal,removed:[],directRequired:false};
  const removed=[],path=decode(u.pathname);let directRequired=personalPath.test(path);
  for(const [key,value] of [...u.searchParams]){
   const k=decode(key).toLowerCase();
   if(transportKeys.has(k)||inherited&&k==='utm_campaign'||/^utm_/i.test(k)&&transportValue(value)){u.searchParams.delete(key);removed.push(key);continue;}
   if(k==='redirect'&&/^(?:https?:\/\/|\/)/i.test(value)){
    if(depth>=3)fail('Simplifique o redirecionamento antes de copiar este endereço.');
    const nested=tracking(value,{inherited},depth+1);directRequired=directRequired||nested.directRequired;removed.push(...nested.removed);if(nested.url!==value)u.searchParams.set(key,nested.url);
   }else if(/^https?:\/\//i.test(decode(value))){
    try{directRequired=directRequired||personalPath.test(new URL(decode(value)).pathname);}catch(_){}
   }
  }
  return {url:relative?u.pathname+u.search+u.hash:u.href,removed:[...new Set(removed)],directRequired};
 }
 const campaigns=raw=>{
  let u;try{u=new URL(decode(raw,false));}catch(_){return [];}
  const values=u.searchParams.getAll('utm_campaign');
  if(u.searchParams.has('redirect')){try{values.push(...new URL(u.searchParams.get('redirect'),u.origin).searchParams.getAll('utm_campaign'));}catch(_){}}
  return [...new Set(values)];
 };
 function strings(r){const out=[];for(const k of ['nome','peca','cabecalho','corpo','rodape','assunto','preheader','from_email','reply_to'])out.push({key:k,value:String(r[k]||'')});(r.botoes||[]).forEach((b,i)=>{for(const k of ['texto','valor','exemplo_url'])if(b[k]!==undefined)out.push({key:`botoes.${i}.${k}`,value:String(b[k])});});Object.entries(r.exemplos||{}).forEach(([k,v])=>out.push({key:'exemplos.'+k,value:String(v)}));return out;}
 function put(r,key,value){const p=key.split('.');if(p.length===1)r[key]=value;else if(p[0]==='botoes')r.botoes[+p[1]][p[2]]=value;else r.exemplos[p[1]]=value;}
 function scan(text,field){
  const hits=[],add=(start,end,context,resource=false)=>{if(hits.length>=100)fail('Este e-mail tem muitos endereços. Simplifique o conteúdo antes de copiar.');if(start>=end||hits.some(h=>start<h.end&&end>h.start))return;const raw=text.slice(start,end);if(raw.length>4096)fail('Um endereço é longo demais para esta revisão. Simplifique o recurso no template.');if(raw.trim())hits.push({start,end,raw,context,field,resource});};
  // CSS and VML are scanned as source, including conditional comments.
  for(const m of text.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)){const start=m.index+m[0].indexOf(m[2]);add(start,start+m[2].length,'css',true);}
  for(const m of text.matchAll(/\b(?:href|src|background|action|poster)\s*=\s*(['"])(.*?)\1/gi)){const start=m.index+m[0].indexOf(m[1])+1;add(start,start+m[2].length,'attribute',/^(?:src|background|poster)\s*=/i.test(m[0]));}
  for(const m of text.matchAll(/\b(?:href|src|background|action|poster)\s*=\s*([^\s'"=<>`]+)/gi)){const start=m.index+m[0].lastIndexOf(m[1]);add(start,start+m[1].length,'attribute',/^(?:src|background|poster)\s*=/i.test(m[0]));}
  for(const m of text.matchAll(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi))add(m.index,m.index+m[0].length,'text');
  for(const m of text.matchAll(/(?:https?:\/\/|\/\/|mailto:|tel:)[^\s<>"'\\]+/gi)){let raw=m[0].replace(/[),.;]+$/,'');add(m.index,m.index+raw.length,'text');}
  for(const m of text.matchAll(/(?:www\.)?(?:fishermans\.com\.br|oaristocrata\.com)(?:\/[^\s<>"']*)?/gi))add(m.index,m.index+m[0].length,'text');
  if(/^(?:botoes\.\d+\.(?:valor|exemplo_url))$/.test(field)&&!hits.length)add(0,text.length,'text');
  return hits.sort((a,b)=>a.start-b.start);
 }
 function pending(source,journal){
  if(source?.servidor?.pendente)return true;
  if(!journal||journal.available===false||journal.blocked)return true;
  return (journal.operations||[]).some(o=>(o.local_id===source.id||source.servidor?.draft_id&&o.request_payload?.draft_id===source.servidor.draft_id)&&(['pending','unknown','uncertain'].includes(o.phase)||o.applied===false&&o.phase==='confirmed'));
 }
 function prepare(source,to,{journal}={}){
  if(source?.canal!=='email'||!['fish','aristo'].includes(source.marca)||!['fish','aristo'].includes(to)||to===source.marca)fail('Escolha um template de e-mail e a outra marca.');
  if(pending(source,journal))fail('Confira a operação pendente ou incerta deste template antes de copiar.');
  if(/\bsrcset\s*=|@import\b/i.test(source.corpo||''))fail('Use uma imagem por src e estilos no próprio HTML antes de copiar. srcset e estilos importados precisam de revisão manual.');
  if(String(source.corpo||'').length>200000||(source.botoes||[]).length>10)fail('Reduza o conteúdo ou os botões antes de copiar.');
  const from=source.marca,r=drafts().conteudo(source),links=[];r.marca=to;
  const adapt=segment=>decode(segment).toLowerCase().includes(contract().BRANDS[from].domain)?segment:brandText(segment,from,to);
  for(const entry of strings(r)){
   if(['from_email','reply_to'].includes(entry.key))continue;
   const hits=scan(entry.value,entry.key);let cursor=0,out='';
   for(const hit of hits){out+=adapt(entry.value.slice(cursor,hit.start))+hit.raw;cursor=hit.end;
    let link=links.find(l=>l.raw===hit.raw);if(!link){const normalized=decode(hit.raw,false),clean=tracking(normalized,{inherited:true}),origin=sourceRemains(normalized,from),dynamic=/\{\{/.test(normalized),relative=!/^(?:https?:)?\/\/|^mailto:|^tel:/i.test(normalized);link={id:'url'+links.length,raw:hit.raw,url:clean.url,original_url:normalized,tracking_removed:clean.removed,directRequired:clean.directRequired,kind:clean.directRequired?'personal':origin?'origin':dynamic?'dynamic':relative?'relative':'external',resource:hit.resource,fields:[]};links.push(link);if(links.length>100)fail('Revise um template com até 100 endereços por vez.');}link.resource=link.resource&&hit.resource;if(!link.fields.includes(entry.key))link.fields.push(entry.key);
   }
   out+=adapt(entry.value.slice(cursor));put(r,entry.key,out);
  }
  const b=contract().BRANDS[to];r.from_email=b.name+' <contato@'+b.domain+'>';r.reply_to='contato@'+b.domain;r.nome=(r.nome||'Template')+' — cópia '+b.name;
  return {from,to,source_id:source.id,source_content:JSON.stringify(drafts().conteudo(source)),source_server:JSON.stringify(source.servidor||null),content:r,links};
 }
 function apply(plan,{fields={},links=[]}={}){
  const allowed=['nome','assunto','preheader','from_email','reply_to'];
  if(Object.keys(fields).some(k=>!allowed.includes(k)))fail('Campo de revisão não permitido.');
  const r=clone(plan.content);for(const k of allowed)if(fields[k]!==undefined)r[k]=String(fields[k]);
  const replacements=new Map();
  if(links.length!==plan.links.length||new Set(links.map(l=>l.id)).size!==links.length)fail('Confira todos os links e recursos da cópia.');
  for(const link of plan.links){
   const review=links.find(l=>l.id===link.id);if(!review?.reviewed)fail('Confira todos os links e recursos da cópia.');
   let target=String(review.target||'').trim();if(target.length>4096)fail('O endereço de destino é longo demais.');if(!target)fail('Informe o destino de cada link da marca de origem.');
   if(sourceRemains(target,plan.from))fail('Um destino ainda contém a marca de origem. Corrija o link completo.');
   if(link.kind==='dynamic'&&target===link.raw){/* Explicitly reviewed runtime data remains a variable. */}
   else if(/^https:\/\//i.test(target)){
    let u;try{u=new URL(target);}catch(_){fail('Use um endereço HTTPS completo para o destino.');}
    if(u.username||u.password||/[\s<>"'\\]/.test(target))fail('Use um endereço HTTPS sem credenciais ou caracteres inválidos.');
    const clean=tracking(target);if(clean.directRequired)fail('Informe o destino direto. Links pessoais ou de rastreamento do Listmonk não podem ser copiados.');
    u=new URL(clean.url);
    // Only descriptive UTMs may follow the content. Campaign/term/send IDs never do.
    let old;try{old=new URL(link.url);}catch(_){}
    for(const [k,v] of old?.searchParams||[])if(['utm_source','utm_medium','utm_content'].includes(k.toLowerCase())&&!u.searchParams.has(k))u.searchParams.set(k,brandText(v,plan.from,plan.to));
    target=u.href;
   }else if(!/^[^\s<>"'@]+@[^\s<>"'@]+$/.test(target)&&!/^mailto:[^\s<>"']+@[^\s<>"']+$/i.test(target)&&!/^tel:\+?[0-9-]+$/.test(target)&&!/^#[a-z][a-z0-9_-]*$/i.test(target))fail('Informe um link HTTPS, e-mail de contato ou âncora válida.');
   if(!link.resource&&['origin','relative'].includes(link.kind)&&/^https:\/\//i.test(target)){
    const host=new URL(target).hostname.toLowerCase(),domain=contract().BRANDS[plan.to].domain;
    if(host!==domain&&host!=='www.'+domain)fail('O link da loja precisa apontar para a marca de destino. Recursos externos devem ser revisados no conteúdo de origem.');
   }
   replacements.set(link.raw,target);
  }
  for(const entry of strings(r)){
   const hits=scan(entry.value,entry.key);let out='',cursor=0;
   for(const hit of hits){const target=replacements.get(hit.raw);if(target===undefined){if(['from_email','reply_to'].includes(entry.key))continue;fail('Os links mudaram durante a revisão. Reabra a cópia.');}out+=entry.value.slice(cursor,hit.start)+(hit.context==='attribute'?target.replaceAll('&','&amp;'):target);cursor=hit.end;}out+=entry.value.slice(cursor);put(r,entry.key,out);
  }
  if(strings(r).some(e=>sourceRemains(e.value,plan.from)))fail('Ainda há referência à marca de origem no conteúdo, HTML ou estilo. Revise o rascunho original e reabra a cópia.');
  const errors=[...contract().envelopeErrors(r),...contract().documentErrors(r)].map(e=>e.mensagem);const validation=drafts().valida(r);if(errors.length||validation.erros.length)fail([...new Set([...errors,...validation.erros])].join(' '));
  return drafts().conteudo(r);
 }
 const urls=r=>[...new Set(strings(r).filter(e=>!['from_email','reply_to'].includes(e.key)).flatMap(e=>scan(e.value,e.key).map(h=>decode(h.raw,false))))];
 return {prepare,apply,pending,decode,sourceRemains,urls,campaigns};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=GER;
