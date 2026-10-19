'use strict';
const Models=require('./model-library.js'),Legacy=require('../../../../growth-message-preview.js');
const enabled=key=>typeof window==='object'&&window.ShrigmaCrmFeatureEnabled?.(key)===true;
function email(host,{html,subject='',brand,showSubject=true}={}){
 if(!host||!['fish','aristo'].includes(brand)||typeof html!=='string'||html.length>400000)throw Error('MESSAGE_PREVIEW_INPUT');
 host.replaceChildren();host.dataset.messagePreview='email';const doc=host.ownerDocument,bar=doc.createElement('div'),label=doc.createElement('div'),canvas=doc.createElement('div'),frame=doc.createElement('iframe');
 label.className='fw-medium mb-2 text-wrap';label.textContent=subject||'Prévia da peça';bar.className='d-flex gap-2 mb-2';bar.setAttribute('role','group');bar.setAttribute('aria-label','Largura da prévia de e-mail');canvas.className='border rounded';canvas.style.cssText='max-width:100%;overflow:auto;';
 frame.title='Prévia da peça de e-mail';frame.setAttribute('sandbox','');frame.setAttribute('referrerpolicy','no-referrer');frame.style.cssText='display:block;border:0;height:480px;max-width:none;background:white';frame.srcdoc=Models.isolate(html,doc,{images:true});
 const buttons=[];function width(value){frame.style.width=value+'px';for(const b of buttons)b.setAttribute('aria-pressed',String(Number(b.dataset.previewWidth)===value));host.dataset.previewWidth=String(value);}
 for(const [name,value]of [['Desktop',760],['Celular',390]]){const b=doc.createElement('button');b.type='button';b.className='btn btn-sm btn-outline-secondary';b.textContent=name;b.dataset.previewWidth=String(value);b.addEventListener('click',()=>width(value));buttons.push(b);bar.append(b);}canvas.append(frame);if(showSubject)host.append(label);host.append(bar,canvas);width(760);return Object.freeze({html,subject,brand,frame});
}
function upgrade(host,options){const frame=host?.querySelector('iframe');if(!frame)return null;const target=host.ownerDocument.createElement('div');frame.parentElement.insertBefore(target,frame);frame.remove();return email(target,{...options,showSubject:false});}
function whatsapp(host,template){
 if(!host||!template||!['fish','aristo'].includes(template.brand)||!Array.isArray(template.components))throw Error('WHATSAPP_PREVIEW_INPUT');
 const samples={nome:'Ana',name:'Ana',cliente:'Ana',pedido:'12345',order:'12345',prazo:'3 dias',1:'Ana',2:'12345',3:'3 dias'},sample=text=>String(text||'').replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g,(_m,key)=>samples[key.toLowerCase()]||'Exemplo');
 // Never display provider examples, destinations, phone values or media URLs.
 const safe={brand:template.brand,components:template.components.map(c=>({type:c.type,format:c.format,text:sample(c.text),...(c.type==='BUTTONS'?{buttons:(c.buttons||[]).map(b=>({type:b.type,text:sample(b.text)}))}:{})}))};
 host.dataset.messagePreview='whatsapp';host.className='border rounded p-3';host.style.cssText='max-width:390px;width:100%;overflow-wrap:anywhere;box-sizing:border-box;';host.innerHTML='<div class="form-hint mb-2">Exemplo de preenchimento · '+(template.brand==='fish'?'Fishermans':'O Aristocrata')+'</div>'+Legacy.publishedWhatsApp(safe);for(const b of host.querySelectorAll('button')){b.type='button';b.disabled=true;}return safe;
}
const api=Object.freeze({email,whatsapp,upgrade,enabled});if(typeof window==='object')window.ShrigmaCrmMessagePreview=api;module.exports=api;
