/* Called only after the fixed parent hands this frame a validated read credential. */
if(typeof window!=="undefined"&&typeof window.addEventListener==="function")window.addEventListener('shrigma:access-ready',()=>{
 const panel=document.body.dataset.panel;
 if(panel==='growth'&&typeof carregar==='function')carregar();
 else if(panel==='influs'&&typeof carregarAbaAtiva==='function')carregarAbaAtiva();
 else if(typeof carrega==='function')carrega();
});
