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
