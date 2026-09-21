// ================== CONFIG ==================
// Única coisa que o dev precisa trocar ao replicar no sistema interno.
const CX_API_URL = "https://n8n-n8n.tazdb8.easypanel.host/webhook/cx-dash-api-306742284c6fac1d";
// CX (17/09): leitura em cache — o mesmo JSON, montado a cada 10 min pelo workflow "CX — API cache" e servido com um SELECT (< 1 s).
// Se o cache falhar, app.js cai para CX_API_URL (a API viva). Só o painel de CX usa isto.
const CX_CACHE_URL = "https://n8n-n8n.tazdb8.easypanel.host/webhook/cx-dash-cache-a91f3c7e2d4b";
const REFRESH_SEG = 60; // recarrega dados a cada 60s (lê Postgres via n8n; Gleap nunca é chamado daqui)
// CX (17/09): o dado muda a cada 30 min (snapshot do Gleap) e cada leitura custa 2–4 s de Postgres — recarregar a cada minuto era o maior peso do banco.
const CX_REFRESH_SEG = 600;

// Endpoint de ESCRITA dos testes A/B. Chave PROPRIA (nao a de leitura):
// a sessão de leitura não concede permissão de escrita.
const AB_API_URL = 'https://n8n-n8n.tazdb8.easypanel.host/webhook/crm-teste-api-01d240f09eff8e39';

// Endpoint de LEITURA+ESCRITA do cadastro de influs (cupom <-> influ).
// 'listar' aceita a chave de leitura do painel; salvar exige chave PROPRIA de escrita,
// que nao mora neste repositorio e continua sujeita ao controle próprio de escrita.
const INFLU_API_URL = 'https://n8n-n8n.tazdb8.easypanel.host/webhook/crm-influ-api-7c41e0b93a5d8f26';

// Endpoint de LEITURA da aba Afiliados TikTok Shop (influs.html). Aceita a chave de leitura do painel
// de Influs (crm_dash_chave, painel influs/todos). Le as tabelas crm_tts_* do coletor diario.
const TTS_API_URL = 'https://n8n-n8n.tazdb8.easypanel.host/webhook/tts-painel-api-9d3f7a1c';
// Endpoint de ESCRITA do TikTok Shop (aprovar/rejeitar amostra, editar regra). Chave PROPRIA, que nao mora
// neste repositorio e continua sujeita ao controle próprio de escrita.
const TTS_ACAO_URL = 'https://n8n-n8n.tazdb8.easypanel.host/webhook/tts-acao-api-2c7e9f41';

/* Read credentials live only in this document. Never put them in a URL or cache. */
const SHRIGMA_SLOT_MESTRE = 'shrigma_k_mestre';
const SHRIGMA_READ_SESSION = Object.create(null);
const SHRIGMA_OPERATOR_SESSION=Object.create(null);
function shrigmaChaveOperador(area,cap){const p=SHRIGMA_OPERATOR_SESSION[area];return p&&Array.isArray(p.caps)&&p.caps.includes(cap)?shrigmaChave(area):'';}
function shrigmaAutorOperador(area){return SHRIGMA_OPERATOR_SESSION[area]?.label||'';}

const SHRIGMA_EMBEDDED = typeof location !== 'undefined' && new URLSearchParams(location.search || '').get('embed') === '1';
function shrigmaChave(painel) {
  if (SHRIGMA_READ_SESSION[painel]) return SHRIGMA_READ_SESSION[painel];
  if (SHRIGMA_EMBEDDED) return '';
  try {
    // Migrate a legacy saved reader into memory once. New portal sessions never import it.
    const key=localStorage.getItem('shrigma_k_'+painel)||localStorage.getItem(SHRIGMA_SLOT_MESTRE)||'';
    localStorage.removeItem('shrigma_k_'+painel);localStorage.removeItem(SHRIGMA_SLOT_MESTRE);
    if(key)SHRIGMA_READ_SESSION[painel]=key;
    return key;
  } catch (_) { return ''; }
}
function shrigmaGuardaChave(painel,key) { SHRIGMA_READ_SESSION[painel]=typeof key==='string'?key:''; }
function shrigmaMarcaMestra() { /* The server-validated portal owns cross-area navigation. */ }
function shrigmaEsqueceChave(painel) {
  delete SHRIGMA_READ_SESSION[painel];delete SHRIGMA_OPERATOR_SESSION[painel];
  try {localStorage.removeItem('shrigma_k_'+painel);localStorage.removeItem(SHRIGMA_SLOT_MESTRE);}catch(_){}
}
// A same-origin, exact-parent handshake. No key in local/session storage, URLs or referrers.
if(SHRIGMA_EMBEDDED && typeof window!=='undefined' && window.parent!==window){
 const area=document.body.dataset.panel==='index'?'cx':document.body.dataset.panel;
 document.body.classList.add('panel-embedded');
 window.addEventListener('message',event=>{
  if(event.source!==window.parent||event.origin!==location.origin||event.data?.type!=='shrigma:read-access'||event.data.panel!==area)return;
  if(typeof event.data.key!=='string'||!/^[a-z0-9-]{8,128}$/.test(event.data.key))return;
  let parentPath;try{parentPath=new URL(window.parent.location.href).pathname;}catch(_){return;}
  if(!/(?:cx|crm|organico|creators|gestao)\/(?:index.html)?$/.test(parentPath))return;
  shrigmaGuardaChave(area,event.data.key);
  const op=event.data.permission;delete SHRIGMA_OPERATOR_SESSION[area];
  if(op&&Array.isArray(op.caps)&&typeof op.label==='string')SHRIGMA_OPERATOR_SESSION[area]={caps:op.caps.filter(x=>typeof x==='string'),label:op.label};
  document.querySelector('#gate')?.remove();
  for(const id of ['growth-acesso','organico-acesso','influ-access-form']){const el=document.getElementById(id);if(el)el.hidden=true;}
  window.dispatchEvent(new Event('shrigma:access-ready'));
 });
 window.parent.postMessage({type:'shrigma:ready',panel:area},location.origin);
}
