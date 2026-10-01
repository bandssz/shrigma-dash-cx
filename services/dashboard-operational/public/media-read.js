/* Read-only Listmonk library for the operational CRM. No image bytes or links are loaded. */
const GMediaRead=(()=>{'use strict';
 const LABELS={fish:'Fishermans',aristo:'O Aristocrata'};
 const ENDPOINT='/api/campaigns_media',PER_PAGE=24;
 let view=null,state={brand:null,enabled:false,busy:false,loaded:false,items:[],next:null,error:''},pending=null;
 const make=(tag,content)=>{const node=document.createElement(tag);if(content!==undefined)node.textContent=content;return node;};
 function ready(api){
  const endpoint=api?.capabilities?.endpoints?.campaigns_media;
  return typeof endpoint==='string'&&endpoint===new URL(ENDPOINT,location.origin).href;
 }
 function validItem(item){
  return item&&Number.isSafeInteger(item.id)&&item.id>0&&
   typeof item.filename==='string'&&item.filename.length>0&&item.filename.length<=180&&
   !/[\x00-\x1f\x7f-\x9f]/.test(item.filename)&&
   ['image/png','image/jpeg','image/gif'].includes(item.content_type)&&
   Number.isSafeInteger(item.width)&&item.width>0&&Number.isSafeInteger(item.height)&&item.height>0&&
   item.width*item.height<=4*1024*1024;
 }
 function validPage(value,brand,page){
  return value?.contract==='crm-media-v1'&&value.brand===brand&&value.page===page&&
   value.per_page===PER_PAGE&&Number.isSafeInteger(value.total)&&value.total>=0&&value.total<=1000000&&
   Array.isArray(value.items)&&value.items.length<=PER_PAGE&&value.items.every(validItem)&&
   (value.next_page===null||value.next_page===page+1&&value.next_page<=10000);
 }
 function ensureView(root){
  if(view?.root===root)return view;
  pending?.abort();
  const title=make('h2','Biblioteca de imagens'),intro=make('p','Biblioteca compartilhada do Listmonk para Fishermans e O Aristocrata. Consulta de metadados, sem carregar imagens.');
  const heading=make('div');heading.className='painel-cab';heading.append(title);
  const status=make('p');status.id='crm-media-read-status';status.setAttribute('role','status');status.className='mini';
  const controls=make('div'),load=make('button','Consultar biblioteca'),more=make('button','Carregar mais'),list=make('ul');
  controls.id='crm-media-read-controls';load.type='button';load.className='btn sec';load.id='crm-media-read-load';
  more.type='button';more.className='btn sec';more.id='crm-media-read-more';more.hidden=true;
  list.id='crm-media-read-list';list.setAttribute('aria-label','Arquivos da biblioteca compartilhada');
  controls.append(load,list,more);root.replaceChildren(heading,intro,status,controls);
  view={root,status,controls,load,more,list};
  load.addEventListener('click',()=>loadPage(false));more.addEventListener('click',()=>loadPage(true));
  return view;
 }
 function render(){
  if(!view)return;
  const {status,controls,load,more,list}=view;
  const active=state.enabled&&state.brand!==null;
  controls.hidden=!active;
  if(!active){
   list.replaceChildren();more.hidden=true;
   status.textContent=state.brand===null?'Selecione Fishermans ou O Aristocrata para consultar a biblioteca.':'A biblioteca integrada ainda não está disponível neste painel.';
   return;
  }
  load.disabled=state.busy;more.disabled=state.busy;
  more.hidden=!state.loaded||state.next===null;
  status.textContent=state.error|| (state.busy?'Consultando a biblioteca…':state.loaded?`${state.items.length} arquivo(s) listado(s) para ${LABELS[state.brand]}. A biblioteca é compartilhada entre as marcas.`:'Consulte os arquivos da biblioteca compartilhada.');
  list.replaceChildren();
  if(state.loaded&&!state.items.length)list.append(make('li','Nenhum arquivo compatível nesta página.'));
  for(const item of state.items){
   const line=make('li');line.append(make('strong',item.filename),make('span',` · ${item.width} × ${item.height} · ${item.content_type}`));list.append(line);
  }
 }
 async function loadPage(more){
  if(!state.enabled||!state.brand||state.busy||more&&(!state.loaded||state.next===null))return;
  const current=state,brand=current.brand,page=more?current.next:1;
  current.busy=true;current.error='';render();
  const controller=new AbortController();pending=controller;
  const timer=setTimeout(()=>controller.abort(),20000);
  try{
   const query=new URLSearchParams({brand,page:String(page),per_page:String(PER_PAGE)});
   const response=await fetch(ENDPOINT+'?'+query,{method:'GET',headers:{Accept:'application/json'},credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal});
   if(!response.ok)throw Error('READ_UNAVAILABLE');
   const data=await response.json();
   if(!validPage(data,brand,page))throw Error('READ_INVALID');
   if(state!==current)return;
   const seen=new Set(),items=more?[...current.items,...data.items]:data.items;
   current.items=items.filter(item=>{if(seen.has(item.id))return false;seen.add(item.id);return true;});
   current.next=data.next_page;current.loaded=true;
  }catch(_){
   if(state!==current)return;
   current.items=[];current.next=null;current.loaded=false;
   current.error='A biblioteca não pôde ser confirmada agora. Nenhum arquivo foi exibido.';
  }finally{
   clearTimeout(timer);if(pending===controller)pending=null;
   if(state===current){current.busy=false;render();}
  }
 }
 function mount(options={}){
  const root=document.getElementById('crm-media');if(!root)return;
  const brand=Object.hasOwn(LABELS,options.marca)?options.marca:null,enabled=ready(options.api);
  ensureView(root);
  if(state.brand!==brand||state.enabled!==enabled){pending?.abort();state={brand,enabled,busy:false,loaded:false,items:[],next:null,error:''};}
  render();
 }
 return {mount};
})();
if(typeof module==='object'&&module.exports)module.exports=GMediaRead;
