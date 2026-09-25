/* Read-only UTM inspection. No link rewriting, preview execution or send action. */
'use strict';
const GUT=(()=>{
 const keys=['source','medium','campaign','content','term'];
 const labels={source:'Origem · utm_source',medium:'Canal · utm_medium',campaign:'Campanha · utm_campaign',content:'Conteúdo · utm_content',term:'Variação · utm_term'};
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const values=v=>(Array.isArray(v)?v:[v]).filter(x=>typeof x==='string'&&x!=='');
 function fromContent(content){
  const original=String(content||'');let prefix='__CRM_UTM_GO_';while(original.includes(prefix))prefix+='X';
  const actions=[];const protectedText=original.replace(/\{\{[\s\S]*?\}\}/g,s=>prefix+(actions.push(s)-1)+'__');
  const token=new RegExp(prefix+'(\\d+)__','g'),restore=s=>s.replace(token,(_,n)=>actions[Number(n)]||'');
  const pattern=new RegExp('(?:https?:\\/\\/|'+prefix+'\\d+__)[^\\s<>"\']*','g');
  const candidates=protectedText.match(pattern)||[];
  // A native default may contain an entire literal URL inside its Go action.
  for(const action of actions)for(const m of action.matchAll(/https?:\/\/[^\s<>"'`]+/g))candidates.push(m[0]);
  const rows=[],seen=new Set(),expanded=[];
  for(const raw of candidates){
   const query=raw.indexOf('?'),controls=[...raw.matchAll(token)].filter(m=>/^\{\{-?\s*(?:if|else|end|range|with)\b/.test(actions[Number(m[1])]||''));
   if(query>=0&&controls.some(m=>m.index>query)){
    const chunks=raw.replace(token,(s,n)=>/^\{\{-?\s*(?:if|else|end|range|with)\b/.test(actions[Number(n)]||'')?'\n':s).split('\n').filter(Boolean);
    if(chunks.length>=2&&chunks.every(s=>/^(?:https?:\/\/)/.test(s)&&s.includes('?')&&!/[?&]=?$/.test(s))){expanded.push(...chunks);rows.conditional=true;}
    else rows.unresolvedConditional=true;
   }else expanded.push(raw);
  }
  for(const raw of expanded){
   const url=raw.replace(/@TrackLink$/,'').replace(/&(?:amp|#0*38|#x0*26);/gi,'&'),query=url.indexOf('?'),hash=url.indexOf('#');
   if(query<0||(hash>=0&&hash<query))continue;
   const params=new URLSearchParams(url.slice(query+1,hash<0?undefined:hash)),row={};
   for(const key of keys){const found=params.getAll('utm_'+key).map(restore);if(found.length)row[key]=found.length===1?found[0]:found;}
   if(!Object.keys(row).length)continue;const signature=JSON.stringify(row);if(!seen.has(signature)){rows.push(row);seen.add(signature);}
  }
  return rows;
 }
 function dynamicFields(content){
  return [...new Set([...String(content||'').matchAll(/\{\{[\s\S]*?\}\}/g)].flatMap(m=>[...m[0].matchAll(/\.Tx\.Data\.(?:[A-Za-z][A-Za-z0-9_]*_url|url)\b/g)].map(x=>x[0])))];
 }
 function templateContent(template){
  if(!template)return '';
  if(template.channel==='email')return String(template.components?.body_html||'');
  return (Array.isArray(template.components)?template.components:[]).filter(c=>c?.type==='BUTTONS').flatMap(c=>(c.buttons||[]).filter(b=>b?.type==='URL'&&typeof b.url==='string').map(b=>b.url)).join('\n');
 }
 function render({rows=[],label='UTMs e origem',evidence='',empty='UTMs não disponíveis nesta consulta.',mode='content',dynamic=[],open=false,key=''}={}){
  const unique=[];const seen=new Set();
  for(const input of Array.isArray(rows)?rows:[]){if(!input||typeof input!=='object')continue;const row=Object.fromEntries(keys.map(k=>[k,values(input[k])]));if(!keys.some(k=>row[k].length))continue;const sig=JSON.stringify(row);if(!seen.has(sig)){unique.push(row);seen.add(sig);}}
  const blocks=unique.map((row,index)=>{
   const source=row.source,expressions=source.flatMap(v=>v.match(/\{\{[\s\S]*?\}\}/g)||[]);
   const sourceRule=mode==='registered'?'A consulta registra o valor; não informa a variável que o gerou.':!source.length?'utm_source não informado no conteúdo.':expressions.length?[...new Set(expressions)].join(' · '):rows?.conditional?'Valor fixo em um dos caminhos do template':'Valor fixo no conteúdo';
   const query=keys.flatMap(k=>row[k].map(v=>'utm_'+k+'='+v)).join('&');
   return `<div class="crm-utm-pattern">${unique.length>1?`<strong>Padrão ${index+1}</strong>`:''}<dl>${keys.map(k=>`<div><dt>${labels[k]}</dt><dd>${row[k].length?row[k].map(v=>`<code>${esc(v)}</code>`).join(' · '):'<span>Não informado</span>'}</dd></div>`).join('')}<div><dt>Variável de source</dt><dd>${esc(sourceRule)}</dd></div></dl><code class="crm-utm-query">${esc(query)}</code></div>`;
  }).join('');
  const variables=[...new Set((Array.isArray(dynamic)?dynamic:[]).filter(x=>typeof x==='string'))];
  return `<details class="crm-utm"${open?' open':''}${key?` data-utm-key="${esc(key)}"`:''}><summary>${esc(label)}</summary>${evidence?`<div class="crm-utm-evidence">${esc(evidence)}</div>`:''}${rows?.conditional?'<div class="crm-utm-evidence">O padrão varia conforme o caminho do template.</div>':''}${rows?.unresolvedConditional?'<p class="crm-utm-empty">Há UTMs montadas por condições. Confira as expressões no conteúdo do template; os valores não podem ser reduzidos a um padrão fixo.</p>':''}${blocks||(!rows?.unresolvedConditional?`<p class="crm-utm-empty">${esc(empty)}</p>`:'')}${variables.length?`<div class="crm-utm-dynamic">Endereço preenchido no disparo: ${variables.map(v=>`<code>${esc(v)}</code>`).join(' · ')}. As UTMs contidas nesse endereço dependem do evento.</div>`:''}</details>`;
 }
 return {fromContent,dynamicFields,templateContent,render};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=GUT;
