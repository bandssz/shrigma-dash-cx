# Dashboard CX · Grupo Shrigma

Painel interno de CS/CX. Site estático que lê snapshots do Postgres (via webhook do n8n) —
**nunca chama o Gleap diretamente**.

## Arquitetura (3 camadas, nesta ordem)

1. **Coleta** — workflow n8n `CX — Dashboard · Snapshot Gleap→Postgres`
   - A cada 30 min (07–20h SP): atualiza a janela `1d` de hoje.
   - Às 01:15: consolida o dia anterior fechado e grava as janelas `7d` e `30d`.
   - Falha de chamada grava **NULL, nunca 0**. `coletas_ok < coletas_total` marca a linha
     como incompleta e o painel avisa.
2. **Leitura** — workflow n8n `CX — Dashboard · API de leitura` (GET → JSON + CORS).
   Uma chamada devolve tudo: séries diárias, janelas exatas, agentes, votos NPS e fontes semanais.
3. **Tela** — estes arquivos. `dados.js` só faz matemática (testável com node),
   `app.js` só pinta, `config.js` tem a URL da API.

## Tabelas no Postgres (banco do Listmonk, Easypanel)

- `cx_snapshot` — marca × janela × dia (métricas de marca)
- `cx_snapshot_agente` — marca × agente × janela × dia
- `cx_manual_semanal` — Reclame Aqui e Replient (jsonb, semanal)
- NPS não tem tabela própria: é lido de `subscribers.attribs->'nps'`

Cada coluna tem `COMMENT` no banco explicando origem e pegadinha
(`SELECT obj_description('cx_snapshot'::regclass)` e afins).

## Regras de interpretação (não mude sem entender)

- `trabalhados` por agente = `ticketActivityCount` do Gleap ("Tickets worked on").
  Usar `totalCountForUser` subnotifica o agente pela metade.
- `primeiro_fechamento_seg` é tempo até o **primeiro** fechamento, não resolução total.
- `fila_aberta` é foto do momento da coleta — não existe para dias retroativos (NULL).
- Medianas **não somam**: períodos de 7/30 dias usam a linha de janela exata quando ela
  existe; senão, aproximação ponderada por volume, marcada com "≈" na tela.

## Publicar no GitHub Pages

1. Crie um repositório (ex.: `shrigma-dash-cx`).
2. Suba estes arquivos na raiz (index.html, styles.css, app.js, dados.js, config.js).
   **Não suba** `payload_teste.json` e `teste_dados.js` (são só de desenvolvimento).
3. Settings → Pages → Source: `main` / root → Save.
4. Em ~1 min o painel estará em `https://<usuario>.github.io/shrigma-dash-cx/`.
5. Monitor de parede: abra com `?janela=dia` (ou `?marca=aristocrata&janela=7d` etc.).

> Acesso: o site é público, mas a API exige chave (`?k=`), validada no workflow
> `CX — Dashboard · API de leitura` (nó "Valida chave" — é lá que se troca).
> O painel pede a chave uma vez por dispositivo e guarda em localStorage.
> A chave nunca aparece neste repositório.

## Rodar local

Qualquer servidor estático: `python3 -m http.server` na pasta e abrir `http://localhost:8000`.
