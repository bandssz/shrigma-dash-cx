'use strict';
// Pure URL and isolation rules ported from growth-media / growth-message-preview.
// No legacy uploader, credential, endpoint or persistent browser storage.
const ModelLibrary=(()=>{
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 function publicImage(value){
  if(typeof value!=='string'||value.length>2048||/[\s<>"'\\]/.test(value))return null;
  try{const u=new URL(value),shopify=u.hostname==='cdn.shopify.com'&&u.pathname.startsWith('/s/files/'),listmonk=u.hostname==='email.shrigma.com.br'&&u.pathname.startsWith('/uploads/');if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash||(!shopify&&!listmonk)||!/[.](png|jpe?g|gif|webp)$/i.test(u.pathname))return null;if([...u.searchParams.keys()].some(k=>!['v','width','height','crop','format','quality'].includes(k)))return null;return {url:u.href,host:shopify?'Shopify':'Listmonk'};}catch{return null;}
 }
 const snippet=(url,alt)=>{const image=publicImage(url);return image?'<img src="'+esc(image.url)+'" alt="'+esc(alt)+'" width="600" style="display:block;max-width:100%;height:auto;border:0;">':null;};
 function isolate(source){
  const box=document.createElement('template');box.innerHTML=String(source);
  box.content.querySelectorAll('script,iframe,object,embed,form,input,button,textarea,select,base,meta,link,svg,math,audio,video,source').forEach(n=>n.remove());
  for(const n of box.content.querySelectorAll('*'))for(const attr of [...n.attributes]){const k=attr.name.toLowerCase();if(k.startsWith('on')||['srcdoc','target','action','formaction','srcset','ping','background','src','href'].includes(k))n.removeAttribute(attr.name);}
  const policy="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none';";
  return '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="'+esc(policy)+'"><meta name="viewport" content="width=device-width,initial-scale=1"><style>a{pointer-events:none!important}body{overflow-wrap:anywhere}</style></head><body inert>'+box.innerHTML+'</body></html>';
 }
 const content=(t,brand)=>t?.brand===brand&&t.channel==='email'&&t.content_available===true&&typeof t.components?.body_html==='string'&&t.components.body_html.length<=400000;
 function images(templates,brand){
  const seen=new Map();
  for(const t of templates){if(!content(t,brand))continue;const box=document.createElement('template');box.innerHTML=t.components.body_html;for(const n of box.content.querySelectorAll('img[src]')){const image=publicImage(n.getAttribute('src'));if(!image)continue;if(!seen.has(image.url))seen.set(image.url,{...image,models:[]});const labels=seen.get(image.url).models;if(!labels.includes(t.name))labels.push(t.name);}}
  return [...seen.values()];
 }
 function mount(host,{templates,brand}){
  if(!host||!['fish','aristo'].includes(brand)||!Array.isArray(templates)||templates.some(t=>t.brand!==brand))throw Error('MODEL_LIBRARY_SCOPE');
  const library=images(templates,brand);
  host.innerHTML='<div id="model-preview" class="mb-3"></div><div class="card"><div class="card-header"><h2 class="card-title">Imagens públicas</h2></div><div class="card-body"><p class="text-secondary">Imagens encontradas nos modelos carregados desta marca. A URL sozinha não comprova a marca. Não carregamos imagens ou rastreadores automaticamente.</p><div id="model-image-list" class="mb-3"></div><label class="form-label" for="model-image-url">URL pública da Shopify ou do Listmonk</label><input id="model-image-url" class="form-control mb-3" type="url" maxlength="2048" autocomplete="off" spellcheck="false"><label class="form-label" for="model-image-alt">Descrição da imagem</label><input id="model-image-alt" class="form-control mb-3" maxlength="240"><button class="btn btn-outline-primary" type="button" id="model-image-prepare">Preparar HTML</button><p id="model-image-status" class="source-line mt-2" role="status"></p><label class="form-label" for="model-image-output">HTML para copiar</label><textarea id="model-image-output" class="form-control" readonly rows="3"></textarea><div class="d-flex gap-2 flex-wrap mt-3"><a class="btn btn-outline-secondary btn-sm" href="https://email.shrigma.com.br/admin/campaigns/media" target="_blank" rel="noopener noreferrer">Biblioteca completa no Listmonk</a><span class="badge bg-secondary-lt">Upload integrado · em breve</span></div></div></div>';
  host.querySelector('#model-image-list').innerHTML=library.length?library.map((im,i)=>'<div class="border-bottom py-2"><button class="btn btn-link p-0 text-start" type="button" data-model-image="'+i+'">Usar imagem '+(i+1)+' · '+esc(im.host)+'</button><div class="text-break source-line">'+esc(im.url)+'</div><div class="source-line">Modelos: '+esc(im.models.join(' · '))+'</div></div>').join(''):'<p class="text-secondary">Nenhuma URL admitida foi encontrada nos modelos carregados. Cole uma URL pública existente para preparar o HTML.</p>';
  const reset=()=>{host.querySelector('#model-image-output').value='';host.querySelector('#model-image-status').textContent='';};
  for(const id of ['model-image-url','model-image-alt'])host.querySelector('#'+id).addEventListener('input',reset);
  for(const b of host.querySelectorAll('[data-model-image]'))b.onclick=()=>{reset();host.querySelector('#model-image-url').value=library[Number(b.dataset.modelImage)].url;};
  host.querySelector('#model-image-prepare').onclick=()=>{const html=snippet(host.querySelector('#model-image-url').value,host.querySelector('#model-image-alt').value);host.querySelector('#model-image-output').value=html||'';host.querySelector('#model-image-status').textContent=html?'HTML preparado. Confira a marca e copie para o conteúdo do e-mail.':'Use uma URL HTTPS de PNG, JPG, GIF ou WebP da Shopify ou do Listmonk, sem credenciais.';};
  return {preview(t){if(!content(t,brand))return;const target=host.querySelector('#model-preview');target.innerHTML='<div class="card"><div class="card-header"><h2 class="card-title">'+esc(t.name)+'</h2><button class="btn btn-outline-secondary btn-sm ms-auto" type="button" data-model-close>Fechar</button></div><div class="card-body"><h3 class="h4">'+esc(t.components.subject||'Assunto não fornecido')+'</h3><p class="source-line">Conteúdo registrado. Variáveis não resolvidas; links, imagens externas e ações desabilitados. Não comprova entrega nem compatibilidade com campanha.</p><iframe class="w-100 border rounded" style="height:600px" title="Prévia isolada do modelo" sandbox="" referrerpolicy="no-referrer" srcdoc="'+esc(isolate(t.components.body_html))+'"></iframe></div></div>';target.querySelector('[data-model-close]').onclick=()=>target.replaceChildren();target.scrollIntoView({block:'start'});}};
 }
 return Object.freeze({publicImage,snippet,isolate,content,images,mount});
})();
if(typeof module==='object'&&module.exports)module.exports=ModelLibrary;
if(typeof window==='object')window.ShrigmaCrmModels=ModelLibrary;
