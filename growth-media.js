/* Existing public hosts only. No remote uploads, server writes or stored credentials. */
const GMedia=(()=>{
 'use strict';
 const brands={fish:'Fishermans',aristo:'O Aristocrata',olivas:'Olivas do Campo'},drafts=new Map();
 let brand=null;
 function publicImage(value){
  if(typeof value!=='string'||value.length>2048||/[\s<>"'\\]/.test(value))return null;
  try{
   const u=new URL(value),shopify=u.hostname==='cdn.shopify.com'&&u.pathname.startsWith('/s/files/'),listmonk=u.hostname==='email.shrigma.com.br'&&u.pathname.startsWith('/uploads/');
   if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash||(!shopify&&!listmonk)||!/[.](png|jpe?g|gif|webp)$/i.test(u.pathname))return null;
   if([...u.searchParams.keys()].some(k=>!['v','width','height','crop','format','quality'].includes(k)))return null;
   return {url:u.href,host:shopify?'Shopify':'Listmonk'};
  }catch{return null;}
 }
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 function snippet(url,alt){const image=publicImage(url);return image?`<img src="${esc(image.url)}" alt="${esc(alt)}" width="600" style="display:block;max-width:100%;height:auto;border:0;">`:null;}
 function mount({marca}={}){
  const root=document.getElementById('crm-media');if(!root)return;
  const next=Object.hasOwn(brands,marca)?marca:null;
  if(root.querySelector('#crm-media-url')&&brand!==next&&brand)drafts.set(brand,{url:root.querySelector('#crm-media-url').value,alt:root.querySelector('#crm-media-alt').value});
  if(!root.querySelector('#crm-media-url')){
   root.innerHTML=`<div class="painel-cab"><h2>Imagens públicas</h2></div><p id="crm-media-brand" class="mini"></p><p>Suba a imagem na biblioteca que você já usa e copie o endereço público para preparar o e-mail.</p><div class="crm-media-hosts"><a class="btn sec" href="https://email.shrigma.com.br/admin/campaigns/media" target="_blank" rel="noopener noreferrer">Subir imagem no Listmonk ↗</a><a class="btn sec" href="https://admin.shopify.com/" target="_blank" rel="noopener noreferrer">Abrir Shopify ↗</a></div><p class="mini">Os links abrem o serviço em outra aba e usam seu acesso a ele. Na Shopify, selecione a loja e acesse <b>Conteúdo → Arquivos → Fazer upload</b>; depois copie o link da imagem. <a href="https://help.shopify.com/pt-BR/manual/shopify-admin/productivity-tools/file-uploads" target="_blank" rel="noopener noreferrer">Ajuda sobre arquivos</a>.</p><p class="nota">O upload é feito no Listmonk ou na Shopify. O painel ainda não hospeda arquivos. Use imagens destinadas ao público e mantenha o endereço após o envio.</p><fieldset id="crm-media-fields"><legend>Preparar imagem para o e-mail</legend><label for="crm-media-url">Endereço público da imagem<input id="crm-media-url" type="url" inputmode="url" maxlength="2048" placeholder="https://cdn.shopify.com/s/files/…/imagem.jpg" autocomplete="off" spellcheck="false"></label><label for="crm-media-alt">Descrição da imagem<input id="crm-media-alt" type="text" maxlength="240" placeholder="Descrição curta para quem não consegue ver a imagem"></label><div class="crm-media-actions"><button type="button" class="btn sec" id="crm-media-preview">Conferir imagem</button><button type="button" class="btn sec" id="crm-media-copy-url" disabled>Copiar endereço</button><button type="button" class="btn sec" id="crm-media-copy-html" disabled>Copiar HTML para o e-mail</button></div><p id="crm-media-status" role="status" class="mini"></p><div id="crm-media-picture" hidden></div><label for="crm-media-output" id="crm-media-output-label" hidden>Conteúdo pronto para copiar<textarea id="crm-media-output" readonly rows="3"></textarea></label></fieldset>`;
   const reset=()=>{root.querySelector('#crm-media-picture').replaceChildren();root.querySelector('#crm-media-picture').hidden=true;root.querySelector('#crm-media-output-label').hidden=true;root.querySelector('#crm-media-output').value='';const valid=!!brand&&!!publicImage(root.querySelector('#crm-media-url').value);for(const id of ['crm-media-copy-url','crm-media-copy-html'])root.querySelector('#'+id).disabled=!valid;root.querySelector('#crm-media-status').textContent='';};
   root.querySelector('#crm-media-url').addEventListener('input',reset);root.querySelector('#crm-media-alt').addEventListener('input',reset);
   root.querySelector('#crm-media-preview').addEventListener('click',()=>{
    const image=publicImage(root.querySelector('#crm-media-url').value),status=root.querySelector('#crm-media-status');if(!brand||!image){status.textContent='Selecione uma marca e cole o link HTTPS de uma imagem PNG, JPG, GIF ou WebP da Shopify ou do Listmonk, sem link de acesso temporário.';return;}
    const box=root.querySelector('#crm-media-picture'),img=document.createElement('img'),selection=brand;box.replaceChildren(img);box.hidden=false;img.alt=root.querySelector('#crm-media-alt').value;img.referrerPolicy='no-referrer';
    status.textContent='Carregando a prévia…';img.onload=()=>{if(brand===selection&&box.contains(img))status.textContent='Prévia carregada. Confira se a imagem corresponde à marca e ao conteúdo do e-mail.';};img.onerror=()=>{if(brand===selection&&box.contains(img))status.textContent='A prévia não pôde ser carregada. Confira o link público na biblioteca de origem.';};img.src=image.url;
   });
   for(const kind of ['url','html'])root.querySelector('#crm-media-copy-'+kind).addEventListener('click',async()=>{
    const image=publicImage(root.querySelector('#crm-media-url').value);if(!brand||!image)return;
    const selection=brand,text=kind==='url'?image.url:snippet(image.url,root.querySelector('#crm-media-alt').value),output=root.querySelector('#crm-media-output');output.value=text;root.querySelector('#crm-media-output-label').hidden=false;output.focus();output.select?.();
    try{await navigator.clipboard.writeText(text);if(brand===selection)root.querySelector('#crm-media-status').textContent='Copiado. Cole no conteúdo do e-mail e confira a prévia antes de salvar.';}catch{if(brand===selection)root.querySelector('#crm-media-status').textContent='Selecione e copie o conteúdo exibido abaixo.';}
   });
  }
  if(brand!==next){brand=next;const saved=drafts.get(brand)||{url:'',alt:''};root.querySelector('#crm-media-url').value=saved.url;root.querySelector('#crm-media-alt').value=saved.alt;root.querySelector('#crm-media-picture').replaceChildren();root.querySelector('#crm-media-picture').hidden=true;root.querySelector('#crm-media-output-label').hidden=true;root.querySelector('#crm-media-output').value='';root.querySelector('#crm-media-status').textContent='';}
  root.querySelector('#crm-media-brand').textContent=brand?'Preparando imagem para '+brands[brand]+'. O link não identifica a marca automaticamente.':'Selecione uma marca para preparar a imagem.';
  root.querySelector('#crm-media-fields').disabled=!brand;
  for(const id of ['crm-media-copy-url','crm-media-copy-html'])root.querySelector('#'+id).disabled=!brand||!publicImage(root.querySelector('#crm-media-url').value);
 }
 return {publicImage,snippet,mount};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=GMedia;
