/* Defence in depth for the copied preview frontend; the server independently
 * rejects all writes. No real API, iframe, message or external URL is called. */
(function(){'use strict';
 const READ_POSTS={influ:new Set(['listar']),tts:new Set(['listar']), 'tts-cobranca':new Set(['ler','produtos']), 'organico-links':new Set(['listar']),candidaturas:new Set(['ler']),aprovacao:new Set(['ler']),escopo:new Set(['ler'])};
 const original=window.fetch.bind(window);
 function denied(){return Promise.resolve(new Response(JSON.stringify({erro:'TESTE: escrita e conexões externas bloqueadas.',preview:true}),{status:403,headers:{'Content-Type':'application/json'}}));}
 window.fetch=function(input,init={}){
  let url;try{url=new URL(typeof input==='string'?input:input.url,location.href);}catch(_){return denied();}
  if(url.origin!==location.origin||!url.pathname.startsWith('/preview-api/'))return denied();
  if(/-blocked(?:\/|$)/.test(url.pathname))return denied();
  const method=String(init.method||(input instanceof Request?input.method:'GET')).toUpperCase();
  if(method==='POST'){
   let body;try{body=JSON.parse(init.body);}catch(_){return denied();}
   const route=url.pathname.split('/').pop();
   const read=body.acao||(route==='tts'&&Object.keys(body).every(k=>['ini','fim'].includes(k))?'listar':'');
   if(!READ_POSTS[route]?.has(read)||body.action||Object.keys(body).some(k=>!['acao','ini','fim','k','pilot','conciliacao_pedidos','marca','data',...(route==='escopo'?['mes']:[])].includes(k))||body.data&&Object.keys(body.data).length)return denied();
   const headers=new Headers(init.headers);if(!headers.has('Authorization')&&typeof body.k==='string')headers.set('Authorization','Bearer '+body.k);headers.delete('Content-Type');
   for(const [k,v]of Object.entries(body))if(!['k','data'].includes(k))url.searchParams.set(k,String(v));
   url.searchParams.set('acao',read);
   return original(url.href,{...init,method:'GET',headers,body:undefined,credentials:'omit',cache:'no-store',redirect:'error'});
  }
  if(!['GET','HEAD'].includes(method))return denied();
  return original(url.href,{...init,credentials:'omit',cache:'no-store',redirect:'error'});
 };
 window.XMLHttpRequest=class{constructor(){throw Error('TESTE: XMLHttpRequest bloqueado.');}};
 window.WebSocket=class{constructor(){throw Error('TESTE: WebSocket bloqueado.');}};
 window.EventSource=class{constructor(){throw Error('TESTE: EventSource bloqueado.');}};
 navigator.sendBeacon=()=>false;
 const open=window.open.bind(window);window.open=function(url,...args){try{if(new URL(url,location.href).origin===location.origin)return open(url,...args);}catch(_){}return null;};
 document.addEventListener('click',e=>{const link=e.target.closest?.('a[href]');if(!link)return;try{const url=new URL(link.href,location.href);if(url.origin!==location.origin&&!['blob:','data:'].includes(url.protocol)){e.preventDefault();e.stopImmediatePropagation();link.title='TESTE: acesso a serviço externo bloqueado.';}}catch(_){e.preventDefault();}},true);
})();
