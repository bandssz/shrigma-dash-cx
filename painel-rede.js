// Leitura com nova tentativa (28/09/2026). Só para consultas: gravação nunca passa por aqui,
// porque repetir uma gravação com resposta incerta pode duplicar a ação.
// Quando o n8n engasga, a primeira chamada às vezes volta "Failed to fetch" ou 502 e a segunda funciona.
// ler(fn) chama fn de novo depois de 1,5 s e de 4 s, só se o erro for de rede ou do servidor (5xx, 429).
// mensagem(e) troca o texto técnico do navegador por uma frase que quem opera entende.
(function(root){'use strict';
 const REDE=/failed to fetch|load failed|networkerror|network request failed|err_[a-z_]+/i;
 const ESPERA=[1500,4000];
 function transitorio(e){
  if(!e)return false;
  if(e.name==='AbortError')return false; // tempo esgotado ou consulta substituída: quem chamou decide
  return e.transitorio===true||e.name==='TypeError'||REDE.test(String(e.message||''));
 }
 function mensagem(e){
  if(transitorio(e))return 'O servidor demorou para responder. Tente de novo em instantes.';
  return (e&&e.message)||'Não foi possível carregar.';
 }
 // Marca um erro de resposta HTTP como passageiro quando o problema é do servidor.
 function marca(erro,status){if(status>=500||status===429)erro.transitorio=true;return erro;}
 async function ler(fn,{espera=ESPERA,parar=()=>false,dormir}={}){
  const pausa=dormir||(ms=>new Promise(r=>setTimeout(r,ms)));
  for(let i=0;;i++){
   try{return await fn();}
   catch(e){
    if(i>=espera.length||!transitorio(e)||parar())throw e;
    await pausa(espera[i]);
    if(parar())throw e;
   }
  }
 }
 root.PainelRede={ler,mensagem,transitorio,marca};
})(typeof window!=='undefined'?window:globalThis);
if(typeof module!=='undefined'&&module.exports)module.exports=globalThis.PainelRede;
