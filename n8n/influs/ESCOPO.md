# Escopo dos creators (a partir de outubro/2026)

Combinado × entregue no mês, por creator, na aba **Escopo** do painel de Influs.

## Como conta

- **Reels e posts** entram sozinhos. O coletor `AEJryR9aUywOl5Kx` roda todo dia às 06:10 e lê `GET /{ig}/tags`, as publicações em que alguém marcou a conta da marca. Contas lidas: `oaristocrata.br` e `oaristocratareserva` (aristo), `fishermans.com.br` e `fishermansreserva` (fish). Na Meta só há leitura.
- A publicação é ligada a um creator pelo @ do Instagram: primeiro o @ do escopo, depois o `crm_influ.handle`. Quem marcou a marca sem ter @ ligado aparece na lista "Marcaram a marca e não têm @ ligado". Ao ligar, as marcações antigas desse @ passam a contar.
- **Stories e TikTok** a Marcela marca à mão ("Marcar story"). A API não entrega stories de terceiros com marcação. O id é gerado no navegador, então repetir o envio não duplica.
- O escopo é uma **quantidade por mês** para cada tipo e vale a partir do mês escolhido, até ser trocado. Um creator sem escopo não recebe quantidade inventada.
- O ritmo compara o que foi entregue com o combinado proporcional aos dias já passados do mês. Meses fechados mostram "cumpriu" ou "não cumpriu".

## Peças

| Peça | Onde |
|---|---|
| Tabelas e funções | `escopo.sql`: `crm_influ_escopo_v1`, `crm_influ_conteudo_v1`, `crm_influ_conteudo_ingest_v1`, `crm_influ_escopo_painel_v1` |
| Workflows | `escopo-workflow.cjs`: coletor `AEJryR9aUywOl5Kx` e painel `4U9vXniriWnAY3yu` (chave de Influs; gravar pede `creators_edit`) |
| Painel | `influ-escopo.js` e `influ-escopo.css` |
| Testes | `tests/influ-escopo-postgres.cjs` e `tests/influ-escopo-ui.test.cjs` |

## Limites

- A `/tags` só devolve as publicações recentes em que a marca foi marcada. Uma menção só na legenda, sem marcação, não entra.
- Uma miniatura de reel pode expirar na CDN da Meta. Nesse caso o cartão mostra só o tipo e a data, e o link continua funcionando.
