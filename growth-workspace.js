/* Presentation and navigation only. Editors, permissions and operation journals retain ownership of their state. */
'use strict';
const CRMWorkspace=(()=>{
 const titles={visao:'Início',camp:'Campanhas',regua:'Automações',templates:'Templates',base:'Público',resultados:'Resultados'};
 const brands={todas:'Todas as marcas',fish:'Fishermans',aristo:'O Aristocrata',olivas:'Olivas do Campo'};
 let report='overview',campaign='list',notify=()=>{},lastBrand=null,lastIssue='',bound=false;
 const el=id=>typeof document==='undefined'?null:document.getElementById(id);
 function select(kind,value){
  const values=kind==='report'?['overview','email','conversion']:['list','tests'];
  if(!values.includes(value))return false;
  if(kind==='report')report=value;else campaign=value;
  if(typeof document==='undefined')return true;
  document.querySelectorAll('[data-crm-'+kind+']').forEach(b=>{const yes=b.getAttribute('data-crm-'+kind)===value;b.classList.toggle('ativo',yes);b.setAttribute('aria-selected',String(yes));b.tabIndex=yes?0:-1;});
  document.querySelectorAll('[data-crm-'+kind+'-panel]').forEach(p=>{p.hidden=p.getAttribute('data-crm-'+kind+'-panel')!==value;});return true;
 }
 function init({navigate=()=>{},onChange=()=>{},initial={}}={}){
  notify=onChange;select('report',initial.report||report);select('campaign',initial.campaign||campaign);
  if(bound||typeof document==='undefined')return;bound=true;
  document.querySelectorAll('[data-crm-go]').forEach(b=>b.addEventListener('click',()=>navigate(b.dataset.crmGo)));
  for(const kind of ['report','campaign']){
   const buttons=[...document.querySelectorAll('[data-crm-'+kind+']')];
   buttons.forEach((b,i)=>{
    const choose=()=>{if(select(kind,b.getAttribute('data-crm-'+kind)))notify(kind);};b.addEventListener('click',choose);
    b.addEventListener('keydown',e=>{let next;if(e.key==='ArrowRight')next=(i+1)%buttons.length;else if(e.key==='ArrowLeft')next=(i+buttons.length-1)%buttons.length;else if(e.key==='Home')next=0;else if(e.key==='End')next=buttons.length-1;else return;e.preventDefault();select(kind,buttons[next].getAttribute('data-crm-'+kind));notify(kind);buttons[next].focus();});
   });
  }
  for(const id of ['crm-period-picker','crm-brand-picker'])el(id)?.addEventListener('keydown',e=>{if(e.key==='Escape'){el(id).open=false;el(id).querySelector('summary')?.focus();}});
 }
 function sync({section='visao',brand='todas',period,tab}={}){
  if(typeof document==='undefined')return;
  document.body.dataset.crmSection=Object.hasOwn(titles,section)?section:'visao';
  const heading=el('crm-screen-title');if(heading)heading.textContent=titles[section]||'CRM';
  const label=el('crm-brand-label');if(label)label.textContent=brands[brand]||'Marca não identificada';
  if(lastBrand!==null&&lastBrand!==brand&&el('crm-brand-picker'))el('crm-brand-picker').open=false;lastBrand=brand;
  document.querySelectorAll('#secoes button').forEach(b=>{if(b.dataset.s===section)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
  if(period?.ini&&period?.fim){
   const date=v=>/^\d{4}-\d{2}-\d{2}$/.test(v)?v.slice(8,10)+'/'+v.slice(5,7)+'/'+v.slice(0,4):'—';
   const label=el('crm-period-label');if(label)label.textContent=date(period.ini)+' — '+date(period.fim);
  }
  const issues=[...document.querySelectorAll('#fontes .crm-source-status')].filter(n=>['falta','ruim','velho','desconhecido'].includes(n.dataset.estado));
  const issue=issues.map(n=>n.dataset.estado+':'+n.textContent).join('|'),summary=el('crm-data-summary'),box=el('crm-data-freshness');
  if(summary){summary.textContent=issues.length?'Atualização dos dados · '+issues.length+' ponto'+(issues.length===1?'':'s')+' de atenção':'Atualização por origem';summary.dataset.attention=String(issues.length>0);}
  if(box&&issue&&issue!==lastIssue)box.open=true;lastIssue=issue;
 }
 return {init,sync,setReport:value=>select('report',value),setCampaign:value=>select('campaign',value),state:()=>({report,campaign})};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=CRMWorkspace;
