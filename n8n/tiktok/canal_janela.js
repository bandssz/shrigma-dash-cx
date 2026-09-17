// Janela do coletor de canal.
// Cron (sem entrada): últimos 7 dias de shop/performance (1D) e de lives — a API atualiza o dia
// anterior com atraso (~1 dia) e corrige gmv_24h das lives depois; o upsert sobrescreve.
// Backfill pelo webhook: { "k": "...", "dias": 90 } → fatias de 30 dias (a API limita a janela).
// Vídeos: sempre o retrato dos últimos 30 dias (a API devolve acumulado da janela, não por dia).
const e = $json || {};
const dias = Number(e.dias) > 0 ? Math.min(Number(e.dias), 365) : 7;
const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
return [{ json: { dias, hoje, inicio_execucao: new Date().toISOString() } }];
