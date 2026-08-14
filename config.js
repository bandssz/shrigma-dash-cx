// ================== CONFIG ==================
// Única coisa que o dev precisa trocar ao replicar no sistema interno.
const CX_API_URL = "https://n8n-n8n.tazdb8.easypanel.host/webhook/cx-dash-api-306742284c6fac1d";
const REFRESH_SEG = 60; // recarrega dados a cada 60s (lê Postgres via n8n; Gleap nunca é chamado daqui)
