// ================== CONFIG ==================
// Única coisa que o dev precisa trocar ao replicar no sistema interno.
const CX_API_URL = "https://n8n-n8n.tazdb8.easypanel.host/webhook/cx-dash-api-306742284c6fac1d";
const REFRESH_SEG = 60; // recarrega dados a cada 60s (lê Postgres via n8n; Gleap nunca é chamado daqui)

// Endpoint de ESCRITA dos testes A/B. Chave PROPRIA (nao a de leitura):
// a chave de leitura fica no localStorage de todo mundo que ja abriu o painel.
const AB_API_URL = 'https://n8n-n8n.tazdb8.easypanel.host/webhook/crm-teste-api-01d240f09eff8e39';

// Endpoint de LEITURA+ESCRITA do cadastro de influs (cupom <-> influ).
// 'listar' aceita a chave de leitura do painel; salvar exige chave PROPRIA de escrita,
// que nao mora neste repositorio - a Marcela digita uma vez e fica no localStorage dela.
const INFLU_API_URL = 'https://n8n-n8n.tazdb8.easypanel.host/webhook/crm-influ-api-7c41e0b93a5d8f26';

/* ---------- chave de acesso, compartilhada entre as paginas ----------
   Cada painel tem seu proprio cofre no localStorage, para que a chave do Suporte nao
   abra o Growth. Mas a chave MESTRA (painel=todos) e uma so e tem que valer no
   dispositivo inteiro: sem isto, quem tem acesso total teria que colar a mesma chave
   quatro vezes, uma por aba. Por isso existe um cofre extra, o mestre, que serve de
   reserva para todas as paginas. */
const SHRIGMA_SLOT_MESTRE = 'shrigma_k_mestre';

function shrigmaChave(painel) {
  try {
    return localStorage.getItem('shrigma_k_' + painel)
        || localStorage.getItem(SHRIGMA_SLOT_MESTRE) || '';
  } catch (e) { return ''; }
}

function shrigmaGuardaChave(painel, k) {
  try { localStorage.setItem('shrigma_k_' + painel, k); } catch (e) {}
}

/* Chamado depois de uma carga bem-sucedida: se a API disse que a chave e de acesso
   total, ela vira reserva de todas as paginas. E dado da resposta, nao adivinhacao
   pelo formato da chave. */
function shrigmaMarcaMestra(k, painel) {
  try {
    if (painel === 'todos' && k) localStorage.setItem(SHRIGMA_SLOT_MESTRE, k);
  } catch (e) {}
}

function shrigmaEsqueceChave(painel) {
  try {
    localStorage.removeItem('shrigma_k_' + painel);
    localStorage.removeItem(SHRIGMA_SLOT_MESTRE);
  } catch (e) {}
}
