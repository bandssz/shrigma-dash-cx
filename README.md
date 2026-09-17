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
- `cx_manual_semanal` — Reclame Aqui (jsonb, semanal, via bookmarklet)
- `cx_social_comentarios` — comentários IG/FB via Meta Graph, com sentimento próprio
  (OpenAI). Independe da Replient: volume, respondido, oculto e sentimento são nossos.
  Coleta automática a cada 2h; sentimento classificado 1× por comentário (nunca reprocessa).
- NPS não tem tabela própria: é lido de `subscribers.attribs->'nps'`
- `crm_tts_*` — afiliados do TikTok Shop (lane separada dos cupons Shopify): `crm_tts_pedido`
  (1 linha por SKU de pedido de afiliado), `crm_tts_amostra` (pedidos de amostra + decisão da esteira),
  `crm_tts_criador`, `crm_tts_colaboracao` (open/target × produto), `crm_tts_convite`, `crm_tts_regra`
  (parâmetros da esteira por marca) e `crm_tts_coleta_log`. DDL em `n8n/tiktok/ddl_crm_tts.sql`.
  Ver "Afiliados TikTok Shop" abaixo.

Cada coluna tem `COMMENT` no banco explicando origem e pegadinha
(`SELECT obj_description('cx_snapshot'::regclass)` e afins).

## Regras de interpretação (não mude sem entender)

- `trabalhados` por agente = `ticketActivityCount` do Gleap ("Tickets worked on").
  Usar `totalCountForUser` subnotifica o agente pela metade.
- `primeiro_fechamento_seg` é tempo até o **primeiro** fechamento, não resolução total.
- `fila_aberta` é foto do momento da coleta — não existe para dias retroativos (NULL).
- **1ª resposta em expediente** (seg–qui 8h–18h SP desde 14/09; sex e sáb sem expediente humano) é cálculo nosso, feito no workflow
  noturno `CX — 1ª resposta em horário comercial`: o Gleap não oferece o recorte e o
  parâmetro `businessHours` **zera o resultado com HTTP 200**. Fonte: `/tickets?createdAt>=…`
  (o operador vai no NOME do parâmetro) + `/messages` procurando `type=TEXT` com `bot=false`.
  O painel mostra as duas: expediente (o que o time controla) e espera total (o que o cliente sente).
- Comentários: `respondido_pela_marca` é o que conta como atendimento — `respondido` sozinho
  incluiria resposta de outro usuário. `apagado` é inferência (o comentário desapareceu do post
  entre duas coletas) e só é marcado quando a lista do post foi lida por completo.
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


## Painel de CX — repaginação (12/09/2026)

`index.html` reorganizado em torno de **seis números** (o que a liderança e o CX analyst decidem com eles):

| # | Cartão | Fonte | Base (ago 1–15) | Alvo |
|---|---|---|---|---|
| 1 | Contatos / 100 pedidos | `cx_csat` (todos os canais) ÷ `cx_pedidos` | Aris 20 · Fish 17 | < 12 |
| 2 | WISMO / pedido | tag `wismo` (só chat) ÷ `cx_pedidos` | Aris 8% · Fish 2% | < 4% |
| 3 | CSAT · bom | `cx_csat` (só chat), três níveis | Aris 53% · Fish 65% | subir |
| 4 | Kai sozinho | `cx_desfecho` por transferência (sem e-mail) | — | subir |
| 5 | RA · resposta | `cx_ra` (metatags) | Aris 86,2% · Fish 99,5% | > 90% |
| 6 | RA · solução | `cx_ra` | Aris 85,0% · Fish 71,0% | > 90% |

Depois vêm, nesta ordem: **motivo × CSAT** (volume, Δ, quanto o Kai fecha sozinho e CSAT em três níveis por motivo,
com Kai/pessoa), **CSAT em três níveis** (distribuição, série semanal com a quebra de série de 29/08, Kai × pessoa),
desfecho do ticket, operação (saldo, fila, 1ª resposta, evolução, marcas lado a lado), agentes, NPS, Reclame Aqui e comentários.

Arquivos: `cx-metricas.js` (funções puras, testes em `tests/cx-metricas.test.cjs`), `cx-tela.js` (pintura dos blocos
novos), `cx.css` (estilos novos, sem tocar em `styles.css`), `tests/cx-render.test.cjs` (DOM local com fixture sintética).
Contrato da API e coletores: `BACKEND_REQUESTS.md` › R7.

### Leitura em 10 segundos (UX de 13/09)

- **Leitura rápida** no topo: uma linha com o que está *fora do alvo*, em *atenção* e *no alvo*, com valor e alvo entre parênteses.
- **Status nos seis números**: ponto e filete colorido por cartão — verde dentro do alvo, âmbar entre o alvo e a linha de base
  (ago 1–15), vermelho pior que a base. Alvos: contatos/100 pedidos < 12, WISMO < 4%, CSAT bom ≥ 80%, RA ≥ 90%. "Kai sozinho" não tem alvo declarado.
- **Subtítulo em cada bloco** dizendo a pergunta que ele responde; o detalhe metodológico fica no `title` (passar o mouse).
- **Motivos ordenados por volume**, com etiqueta **atacar** quando fatia ≥ 20% e (volume subindo > 10% ou CSAT bom < 50%).
- **Período padrão: últimos 7 dias** ("hoje" é dia em andamento e distorce nota e motivo; fila e saldo de hoje continuam na Operação).

### Corte de gordura (13/09, tarde)

Diagnóstico: o mesmo número aparecia em até cinco lugares e a metade de baixo respondia perguntas de outro time. O que mudou:
- **"O que acontece com o ticket" virou parte do bloco de CSAT** ("CSAT e desfecho no chat"): faixa Kai · pessoa · ninguém embaixo
  do hero; barras por canal e os três cortes ficam em "ver detalhe".
- **"Por agente" perdeu a coluna CSAT** — era a média do Gleap, contradizia o resto do painel. Volta quando existir em três níveis por agente.
- **Evolução, NPS e Comentários recolhidos por padrão**, com resumo na linha do título (NPS, nota, votos · comentários, % respondidos,
  aguardando). **Reclame Aqui abre sozinho quando está fora do alvo**; um clique do usuário prevalece sobre a regra.
- Barra de âncoras no topo (Números · Motivos · CSAT e Kai · Operação · Agentes · Reputação). Comentários ficam no CX (negativo sem
  resposta é atendimento); mover para o orgânico exigiria mexer na whitelist e no front de outra página.

### Abas por fonte e gráficos no tempo (13/09, noite)

Cinco abas, uma por fonte: **Visão geral** (seis números, tendências, motivos), **Chat e e-mail** (Gleap: CSAT em três níveis,
Kai × pessoa, desfecho, operação, agentes, evolução), **Reclame Aqui**, **NPS** e **Comentários** (Replient/Meta). A **leitura
rápida fica acima das abas**; filtros de marca e período são globais; a aba vai no hash (`#aba=chat`). Tudo é pintado sempre.

Gráficos (`cx-graficos.js`, SVG puro, duas formas — linhas e barras empilhadas): contatos por 100 pedidos por semana e por marca
com alvo/base; contatos por semana por motivo (4 grupos, cores fixas); CSAT por semana em barras 100% ruim/neutro/bom com a fatia
de bom no topo; Kai resolve por semana com a quebra de 29/08; quem fechou (Kai/pessoa/ninguém) por semana; índices do RA por dia
e marca; NPS por semana e marca (semana com < 10 votos fica em branco); comentários respondidos × sem resposta e sentimento por
semana. Janela fixa de 12 semanas até o fim do período (8 para a razão por pedido); semanas iniciais sem dado são cortadas.
Regras: um eixo só, hairline sólida, legenda sempre com ≥ 2 séries, rótulo direto só no último ponto, texto nunca na cor da série.

### Visão geral enxuta (13/09, madrugada) — padrão Plausible/Intercom

A referência é o painel que se lê em cima e se explica ao passar o mouse: **cartão de três camadas** (rótulo com ponto de
status · valor · chip de variação) e **um gráfico só**, dirigido pelo cartão clicado. Os seis números viraram botões
(`.six2`); o detalhe que antes era subtítulo (alvo, base, método, quebra por marca) foi para o `title` do cartão e para
um `ⓘ` ao lado do rótulo de cada bloco — a tela deixa de repetir o que o tooltip já conta. A **leitura rápida saiu**; no
lugar dela, o rótulo da seção diz "N fora do alvo · N em atenção" (ou "tudo no alvo"). A tabela de motivos tem **4
colunas** (motivo · contatos · Δ volume · CSAT) com a marca `atacar` quando o motivo pesa ≥ 20% e piora (volume > +10% ou
bom < 50%); a tabela Kai × pessoa por motivo foi para a aba Chat, ao lado do gráfico de motivos. Sombras dos painéis
saíram; a hierarquia é só tipografia e espaço. Paleta: azul da marca, quatro cores fixas dos motivos, cinza para tudo que
é contexto.

O mesmo padrão nas outras abas (`CX_BLOCOS` em `cx-tela.js`: cartões → `estado[chave]` → um gráfico):

- **Chat e e-mail**: Contatos · CSAT bom · Kai resolve sozinho · Ninguém respondeu · Fila · 1ª resposta (expediente).
  O cartão dirige: contatos por semana e motivo (barras), CSAT ruim/neutro/bom por semana, Kai por marca com a quebra
  de 29/08, quem fechou por semana, fila por dia e 1ª resposta por dia (8 semanas, uma linha por marca). Tabela:
  motivo × Kai e pessoa. Recolhidos e fechados: **Por agente** e **Desfecho por canal e detalhe do Kai**. Saíram os
  cartões de operação, o "Marcas lado a lado" (o corte por marca está no ⓘ de cada cartão) e o gráfico "Evolução"
  com seletor — o cartão de Fila faz o mesmo papel.
- **Reclame Aqui**: os cinco critérios do RA1000 (nota, respondidas, solução, voltaria, avaliações) + aguardando como
  cartões; com as duas marcas o cartão mostra a **pior** (aguardando soma). Gráfico por leitura com a linha da meta;
  tabela por marca com verde/vermelho por critério, aguardando, tempo de resposta, reclamações e nota do consumidor.
- **NPS**: NPS · nota média · promotores · detratores · votos. Gráficos: NPS e nota por semana por marca (branco com
  menos de 10 votos), distribuição detrator/passivo/promotor em barras 100% com o NPS no topo, votos por semana por
  marca. Tabela por marca + a área apontada por quem votou.
- **Comentários**: comentários · respondidos pela marca · aguardando resposta · negativos · tempo até responder.
  Gráficos: respondidos × sem resposta, % respondidos com alvo 80%, sentimento em barras 100%, tempo mediano por
  semana. Tabela por marca com sentimento em barra de três níveis e bot × pessoa (inferido pelo tempo); embaixo, as
  filas de atenção e oportunidade.

Faixas sem alvo declarado no handoff, escolhidas para dar cor ao ponto de status (mude em `cx-tela.js` se o time
fixar outras): "ninguém respondeu" ≤ 5% ok / ≤ 10% atenção; NPS ≥ 50 ok / ≥ 30 atenção; respondidos nos comentários
≥ 80% ok / ≥ 50% atenção; aguardando 0 ok / ≤ 5 atenção. Variações de tempo (1ª resposta, tempo até responder) vêm em
diferença de duração, nunca em % ("▲ 1,7h · ant. 6min", não ">500%").

### Reclame Aqui sem depender da N2 (14/09)

A leitura diária do RA agora é uma **tarefa agendada do Claude** (08:30 SP, roda no Mac do Felipe pelo navegador do app,
porque o RA bloqueia curl e n8n com 403) que lê as metatags `reclameaqui:*` das duas marcas e faz o mesmo POST do
bookmarklet para `cx-ra-metatags`. Validado em 13/09: as duas marcas gravaram em `cx_ra_dia` com `fonte='bookmarklet'`.
O bookmarklet (`n8n/ra-bookmarklet.js`) continua como plano B para dia em que o Mac estiver desligado — a tarefa avisa
por push quando não consegue rodar. Correções no bookmarklet: "nota média do consumidor", aguardando lido depois do
rótulo, status pela metatag `reputation-status`.

**Agentes (`cx_snapshot_agente` janela 1d) parados desde 12/09 — causa é do Gleap**: `TEAM_PERFORMANCE_LIST` devolve
zero para todos os agentes em janelas de 1 dia de 12/09 e 13/09, nas duas marcas (11/09 e a janela 7d vêm normais).
O coletor só grava agente com atividade > 0, então o dia fica sem linha; e a consolidação só revisita "ontem", logo o
backfill do Gleap nunca entra. **Correção aplicada em 14/09 no workflow `SIzi3oTMH39LTbDj`** (backup do JSON anterior em
`~/work/n8n-snap/snap_backup_*.json` no Mac): a lista de agentes virou `coletarAgentes()` e a consolidação a repete para
D-2 e D-3 (1 chamada por dia por marca). Primeira rodada com o código novo: 14/09 12:00 UTC, sucesso em 45 s. As linhas
de 12/09 e 13/09 entram sozinhas quando o Gleap fechar a conta — se em 16/09 ainda não houver linha 1d de 13/09, o problema
é permanente do lado deles e vale abrir chamado.

**Tarefa agendada do RA e Mac desligado**: quando o Mac não está ligado na hora (08:30), a plataforma **desativa a tarefa**
(`suspension_reason: device_absent`) em vez de só pular o dia — foi o que aconteceu em 14/09; reativei e disparei à mão
(as duas marcas gravaram às 08:53). Se o painel mostrar leitura do RA com mais de um dia, conferir em claude.ai › tarefas
agendadas se ela está ativa. Plano B continua sendo o bookmarklet.

### Auditoria dos números (14/09) — o que estava furado e o que mudou

Conferido número a número contra `cx_ticket` (uma linha por ticket), o Gleap direto e transcrições. Achados e correções:

1. **Razões por pedido explodiam em "hoje"** (361 contatos/100 pedidos, WISMO 190%): `cx_pedido_dia` de hoje é a foto das
   01:20 (17 pedidos) e os contatos entram a cada 30 min. Agora as razões usam **só dia completo** (período que só tem
   hoje cai para ontem e a etiqueta diz); a série semanal também para em ontem. O chip da razão virou diferença absoluta
   ("▲ 23,4 · ant. 31,6"), não "pp".
2. **"Kai resolve sozinho" estava inflado** (47% quando o real era 26–30%). A conta antiga era Kai ÷ (Kai + fechados por
   pessoa): ticket **transferido e ainda aberto ficava fora do denominador** — e com a fila em 1.400 isso era 35% dos
   tickets. Agora é `desfechoMaduro()`: Kai fechou ÷ **todos** os tickets de chat criados até D-2, com o resto explícito
   (pessoa respondeu · transferido e ninguém respondeu · aberto/inatividade). Colunas novas na view `cx_csat_dia`
   (`fechados, resposta_humana, kai_fechou, fechado_inatividade`) e na API. "Ninguém respondeu" saiu de 12,8% para
   **36,2%** — esse é o número verdadeiro da semana.
3. Ainda dentro do Kai: em 10 transcrições de "Kai resolveu" (13/09), 6 eram informação entregue (rastreio, status),
   **3 eram o Kai prometendo "o time responde por aqui" sem transferir o ticket** (troca de endereço que ninguém fez) e
   1 era cliente com pedido parado há 8 dias que deu 😡. A promessa sem transferência não tem tag (`kai-aviso` não foi
   aplicada) e por isso conta como resolvido. Correção é no fluxo do Kai (transferir quando promete), não no painel.
4. **CSAT de hoje sempre zerava**: o coletor só buscava ratings no noturno. Agora busca em toda rodada de 30 min;
   e quando o período não tem avaliação nenhuma o cartão cai para a última janela com avaliação e diz.
5. **Dia do desfecho era UTC** no snapshot (21h–24h SP caíam no dia seguinte): corrigido para São Paulo.
6. **Δ de motivos em "hoje"** comparava meio dia com ontem inteiro (sempre seta para baixo de manhã): suprimido em dia
   em andamento, com etiqueta.
7. Coluna "Kai sozinho" da tabela de motivos media "não foi transferido"; virou **"Kai fechou"** (`kai_fechou`).

O que **bateu**: contatos (todos os 40 tickets amostrados foram abertos pelo cliente; 406 sessões distintas em 408 tickets
de um dia — não há duplicata por cliente), pedidos (Shopify), motivos com tag final (o coletor refaz hoje a cada 30 min
e 45 dias no noturno, então retag entra; a precedência problema > cancelamento > troca > wismo > pré-venda > outros faz
`outros + wismo` virar wismo), WISMO/pedido (883 ÷ 5.184 = 17,0% em 07–13/09) e RA. **"Outros" 53%** é real: são tickets
cuja única tag de rota é `outros` depois de todas as passadas — inclui casos em que o Kai respondeu rastreio (WISMO de
fato) e o classificador não marcou.

### Expediente do CX (14/09)

Sexta e sábado **não têm expediente humano** — só o Kai atende; domingo está tratado como sem expediente até o Felipe
confirmar. Isso entra em dois lugares: (1) a **maturação** do desfecho conta 2 dias de expediente, não 2 dias corridos
(`CX_DIAS_SEM_EXPEDIENTE` em `cx-metricas.js`; ticket de quinta só tem desfecho justo na terça); (2) a **1ª resposta em
horário comercial** (workflow `wNGvs4jiZFEjyyT6`) passou de seg–sex para **seg–qui 8h–18h** — ticket de sexta não soma
10 h de "expediente" que não existiu. Zero resposta humana em sex/sáb no painel é o esperado, não incidente.

### Tempo de resposta em expediente, ticket a ticket (14/09, tarde)

O "1ª resposta · expediente" antigo só media tickets de ontem que **já tinham resposta humana à 01:40** — a mediana dos
atendidos rápido; ticket de quarta respondido segunda nunca entrava. Agora a hora da primeira resposta humana fica **no
ticket** (`cx_ticket.primeira_resposta_humana_em/_por/_nome/_seg/_comercial_seg`), gravada pelo workflow
`CX — 1ª resposta em horário comercial` (`wNGvs4jiZFEjyyT6`, 01:40, **delta**: só tickets com `has_agent_reply` e sem
hora; até 700 por rodada; `Forçar (GET)` em `/webhook/cx-comercial-forcar`) — backfill dos ~8.200 respondidos desde
16/07 feito em 14/09. "Resposta humana" = primeira mensagem `TEXT` com `bot=false` **ou** `CHANNEL_TEMPLATE_MESSAGE` de
pessoa (template de WhatsApp que o agente manda na janela de 24h — 17% dos casos). Expediente = seg–qui 8h–18h SP.

Views: `cx_tempo_dia` (marca × canal × dia de criação: tickets, respondidos, transferidos sem resposta, p50/p90 em
expediente, p50 relógio, ≤1h, ≤4h) e `cx_tempo_agente_dia` (por quem deu a primeira resposta). API: blocos `cx_tempo`
e `cx_tempo_agente`. Front (`tempoAgg`, `serieDiariaTempo`, `tempoPorAgente` em `cx-metricas.js`): mediana do período
= **mediana das medianas diárias ponderada pelo volume, marcada ≈**; "% em até 1h" é exata. Faixa do cartão: ≥ 70% em
até 1h ok, ≥ 50% atenção. Gráfico do cartão: mediana diária por marca, 8 semanas, alvo 1h. Tabela **Por agente** ganhou
"Abriu" (tickets em que a pessoa respondeu primeiro) e "1ª resposta · exped." medidos por nós — aparecem mesmo com o
Gleap parado (etiqueta no cabeçalho diz desde quando). `cx_snapshot.primeira_resposta_comercial_seg` continua sendo
preenchido (recalculado para 10 dias a cada noite) para quem ainda lê de lá.

### Trocas e devoluções direto do Troquecommerce (16/09)

O painel via "troca" só como motivo de contato no Gleap (~46/mês) — quem foi ao chat. A reversa aberta direto no portal
Troquecommerce não era puxada de lugar nenhum, e é o número que decide se trocas + RA cabem em uma pessoa.

**Fonte**: API pública do Troquecommerce, documentada em `https://api.troquecommerce.com.br/docs` (OpenAPI em
`/swagger/bundled.json`; a central de ajuda não linka). Header `token` (gerado em Painel › Automações › Tokens de API,
nível READ), base `https://www.troquecommerce.com.br/api/public`, **40 req/10 s por token**. `GET /order/list`
(paginado, filtros `since_updated_at`, `status`, `created_at_from/to`) + `GET /order?id=` (detalhe com itens, motivos,
`history` de eventos, cupom, estorno, rastreio). Um token por painel: Aristocrata (login admin@oaristocrata.com) e
Fishermans (login adm@fishermans.com.br). Tokens em `crm_credencial` (`troque_api_*`) e no nó do workflow — nunca no repo.
No Shopify o app não deixa rastro (sem returns nativos, sem tag, sem pedido criado) — só o portal tem o dado.

**Dados**: `cx_troca` — uma reversa por linha, **sem dado pessoal do cliente** (nome, CPF, PIX, conta ficam fora de
propósito): marca, pedido, criada/atualizada, mês (SP), status, tipo (Troca / Devolução / Sem Reembolso…), valor dos
itens, parcela troca (cupom), parcela estorno, retido, frete do pedido e reverso, cupom, estorno (valor, meio, data),
itens, motivo e submotivo mais comuns dos itens, coleta/completa/segunda solicitação, rastreio, `analise_ate` (1º evento
do histórico que não é criação nem e-mail = saída de "Em Análise"), finalizada/cancelada, nº de eventos. Views
`cx_troca_mes` (marca × mês × tipo: reversas, abertas, em_analise, em_analise_7d, canceladas, finalizadas, entregues,
analisadas, valores, dias_analise p50/p90, dias até entrega) e `cx_troca_motivo_mes`. Backfill 16/09 (scratch
`troque_load.py`, 384 reversas) e workflow **CX — Trocas · noturno** (`iF2t4UcPGJlK9Lvr`, a cada hora de 02:10 a 06:10; forçar em
`GET /webhook/cx-trocas-forcar`): lista `since_updated_at` 3 dias + tudo em status aberto, pula o que já leu nas
últimas 20 h (nó Postgres "Já lidas hoje"), detalha até 120 por rodada em lotes de 4 (o runner do Code node não aguenta
300 chamadas sequenciais — a 1ª versão morreu aos 3 min), upsert. Sem `URLSearchParams` no sandbox do n8n. JS conferido
contra o Python reversa a reversa; rodada forçada em 16/09: 320 listadas, 0 pendentes. API do painel: `cx_troca` (12 meses) e `cx_troca_motivo` (6 meses).

**Tela**: aba **Trocas**, grão mensal (o período do painel não se aplica; etiqueta diz). Cartões: reversas do último mês
fechado (chip contra o anterior), mês atual até hoje (com o dia do mês, sem projeção), **em análise agora** (fila de
todos os meses; vermelho com 10+ paradas há mais de 7 dias), até aprovar (mediana em dias, faixa 2/5), devolução em
dinheiro %, valor devolvido (estorno + cupom). Gráfico por mês (reversas por marca; troca × devolução; dias até aprovar;
valor; em análise por mês de abertura). Tabela mês × marca e tabela de motivos (3 meses fechados + atual).

**O que a leitura de 16/09 diz**: Aris jul 40 · ago 92 · set 70 em 16 dias (~130/mês); Fish jul 26 · ago 39 · set 17.
Fila **em análise agora: 122 na Aris, 82 há mais de 7 dias** — 57 das 92 de agosto e 65 das 70 de setembro nunca foram
tratadas; zero finalizadas na ferramenta. Fish está em dia (0 de agosto em análise). Motivos Aris jul–set: "me arrependi
/ quero outro" 104, **"recebi um produto diferente do que pedi" 70** (erro de expedição — kit errado 16, aroma errado 9),
problema de fabricação 20. Fish: "comprei a linha errada" 43, "produto diferente" 20. O buraco de jan–jun/26 na
Fishermans bate com a troca de conta de julho (adm@ ↔ software@ do Bling): se a outra conta tiver as reversas, um
token lá completa o histórico.

### Os seis números refeitos e o despacho da Shopify (17/09)

**Problema**: a Visão geral ainda mostrava os seis números do handoff de 12/09 enquanto as metas cobradas hoje (concessão
do Head de CX, produtividade do N1) viviam no fim de abas. E o WISMO — 47% dos contatos — era mostrado sem a causa.

**Medição antes de escrever** (scratch `med_despacho.py`, 28.409 pedidos Aris + 5.294 Fish de 01/08 a 14/09, Shopify
GraphQL: `createdAt` do primeiro `fulfillment` = etiqueta emitida pelo Bling; dias úteis seg–sex): semanas com **85–94%
dos pedidos despachados depois de 2 dias úteis** foram seguidas por pico de WISMO — Fish 10/08 e 17/08 (89% e 86%,
mediana 7,5 e 5,1 du) → WISMO 85 → 201 → 177; Aris 03/08 e 24/08 (93% e 94%) → 717 e 1.133. Agosto inteiro: mediana
3,2 du, 71% acima de 2 du, 26% acima de 5. Semana 07/09: 15% atrasado nas duas marcas e o WISMO Aris ainda em 815
(defasagem de uma semana). Entrou.

**Dados**: `cx_despacho_dia` (marca × dia de criação do pedido: pedidos pagos não cancelados, despachados, `ate_2du`,
`ate_5du`, `sem_despacho`, `du_p50`, `du_p90`). Workflow **CX — Despacho · diário** (`2Vv9Pt2ODSw2EK5m`, 02:00; recalcula
os últimos 14 dias inteiros porque o envio chega dias depois; forçar em `GET /webhook/cx-despacho-forcar`). Conferido
linha a linha contra o Python do backfill. API: `cx_despacho` (90 dias). **Maturação**: o dia D só conta quando 2 dias
úteis completos passaram depois dele (`cxFimMaduroDespacho`) — senão "ainda sem envio" vira atraso falso; período sem
dia maduro cai para os 7 maduros mais recentes e diz que caiu.

**Tela — os seis números agora**: Contatos / 100 pedidos · WISMO / pedido · CSAT bom · **Despacho > 2 dias úteis** (sem
alvo declarado: cinza, tendência; combinar SLA com a operação) · **Concessão · % da receita** (grão mensal, último mês
fechado, faixa provisória < 1%) · Reclame Aqui nota. **Kai resolve sozinho** e **Ninguém respondeu** saíram da Visão
geral para a aba Chat, onde já tinham cartão — Visão geral = resultado do negócio; operação do time = aba Chat. Nenhum
bloco novo. Etiqueta de frescor no cabeçalho passou a falar em nomes ("Reclame Aqui parado há 2 d", não "cx_ra").
Cartão "Pagos pelo financeiro" ganhou a mediana de dias até pagar (`dias_ate_pagar_p50`, date_done do ClickUp; 3+ casos).

**O que a leitura de 17/09 diz**: contatos por 100 pedidos na Aris subiu de ~28 (semana 24/08) para **58 (semana 07/09)**
e 80+ nos três dias de 14–16/09 — ~500 tickets/dia contra ~600 pedidos/dia, conferido contra o snapshot do Gleap; WISMO
17% dos pedidos; 1ª resposta em 66 h no alerta. Não é artefato de coleta. Despacho normalizou (mediana < 1 du) — a
causa agora é outra e precisa de olho humano.

### Cadê meu pedido · onde estava o pedido (17/09)

**Problema**: WISMO é quase metade dos contatos e o painel só sabia contar. O ticket do Gleap não carrega o número do
pedido — mas os fluxos **Gleap – WISMO Consulta Pedido** (Kai; Aris `yH37IridSjvKgk75`, Fish `QhcUt1yGZ9RELY6r`) já
localizam o pedido na Shopify (número digitado, e-mail ou telefone da sessão) e leem o rastreio na J&T para responder — e
jogavam o resultado fora.

**O que mudou nos fluxos**: dois nós novos em paralelo ao "Responder", ligados na mesma saída de "Formatar resposta":
Code **Registrar WISMO (sem PII)** → Postgres **Grava cx_wismo_consulta**, ambos com `onError: continuar`. Nenhum nó
existente foi alterado (diff campo a campo: só a conexão nova); a resposta ao cliente sai antes e independe do registro.
Script `wismo_registro_patch.py`, backups em `~/work/n8n-snap/wismo_*_backup_*.json`. Grava só: marca, ticket, número do
pedido, como achou (`via`), situação, dias desde a compra/despacho, transportadora, se escalou — sem nome, telefone,
e-mail ou código de rastreio.

**Dados**: `cx_wismo_consulta` (uma consulta por linha) e view `cx_wismo_situacao_dia` (um ticket por linha-base: a última
consulta do ticket decide; marca × dia × situação). Situações: `sem-despacho`, `despachado-sem-movimento` (expedição);
`em-transito`, `saiu-para-entrega`, `ocorrencia`, `devolvido`, `outra-transportadora` (transportadora); `entregue`;
`nao-encontrado` (o Kai não localizou o pedido em nenhuma tentativa — falha do fluxo, não do cliente). API: `cx_wismo` (60 d).

**Tela**: painel **Cadê meu pedido · onde estava o pedido** na aba Chat (só aparece com dado; base < 30 mostra contagem, não
%; etiqueta vermelha quando o Kai não acha o pedido em mais da metade), e o cartão WISMO da Visão geral ganhou "Kai achou o
pedido em X%" no subtítulo com 20+ tickets. Nenhum cartão novo.

**Primeira hora de registro (17/09, 09:41–09:55)**: 32 tickets — **o Kai não localizou o pedido em 23 (72%; Fish 11 de 12)**.
Dos 9 localizados: 3 despachados sem movimento na J&T, 1 sem despacho, 4 em trânsito, 1 outra transportadora. Se a
proporção se mantiver no dia, o buraco do WISMO não é a expedição de hoje — é o fluxo não achar o pedido (cliente sem
número, busca por telefone que não bate) e mandar o cliente digitar de novo.

### Custo de concessão sobre receita (16/09)

**Problema**: é a meta do Head de CX e não tinha fonte. Os valores estão nas listas de reembolso do ClickUp (Suporte ›
Reembolsos `901327245214`, 91 casos desde mai/26; Formulários › Forms Reembolso `901327137956`, vazia mas lida também) e a
receita está na Shopify.

**Definição** (Felipe, 16/09; meta em número ainda com o Samuel): concessão do mês = **reembolsos registrados no ClickUp
que o financeiro já executou** — status `feito`, `redigindo resposta`, `retorno concluído` (os três vêm depois do
pagamento no fluxo da lista), campo `➤Valor do reembolso` — ÷ **receita Shopify do mês**. `em negociação`, `ag. n2`,
`ag. samuel`, `enc. financeiro` e `com erro` ficam em "em andamento" (valor mostrado à parte, fora da %); `negado` nunca
entra. **Só ClickUp de propósito**: o estorno da Shopify inclui cancelamento de pedido que nunca passou pelo CX (Aris
ago R$ 32,5 mil na Shopify contra R$ 1,7 mil pagos via ClickUp), e a devolução pelo Troque já tem o card dela na parte
de trocas. O caso conta no mês em que foi criado. Nível (régua do CX): N1 cupom, N2 parcial, N3 total.

**Dados**: `cx_concessao` — um caso do ClickUp por linha, **sem dado pessoal** (nome da task = cliente, CPF, e-mail,
PIX, telefone e textos livres não saem do ClickUp): marca, status e tipo do status, datas, nível, degrau, tipo de caso
(campo novo de 10 opções; o antigo entra quando só ele está preenchido), valor do pedido e do reembolso (texto "135,47"
→ numérico), nº do pedido Shopify, quem abriu/atende (equipe). Views `cx_concessao_mes` (marca × mês: casos, concedidos =
pagos, negados, andamento, valores, N1/N2/N3, concedidos_sem_valor) e `cx_concessao_tipo_mes`; `cx_receita_mes` soma
`cx_pedido_dia`, que ganhou `receita` (e `estornos`, coletado mas não mostrado). Workflows: **CX — Concessões · noturno**
(`4SUih2vegFK5RVjS`, 01:50; ClickUp API v2 `GET /list/{id}/task?include_closed=true&page=N` com a credencial `clickUpApi`
referenciada por ID; forçar em `GET /webhook/cx-concessao-forcar`) e **CX — Receita · diário** (`3qHS19o4d301kKK3`, 01:40;
ShopifyQL `FROM sales SHOW total_sales, returns GROUP BY day` = o total de vendas do Analytics; a Fishermans ainda não tem
o escopo `read_reports`, então cai para a soma de `currentTotalPriceSet` dos pedidos não cancelados do dia — conferido
na Aris em 15/09: 98,0k nos dois caminhos; forçar em `GET /webhook/cx-receita-forcar`). Backfill de receita desde 01/07
(scratch `receita_backfill.py`; a loja Shopify da Fishermans só existe desde 14/07). API do painel: `cx_concessao`
(12 meses, já com receita na linha) e `cx_concessao_tipo` (6 meses).

**Tela**: bloco **Concessão sobre receita** no fim da aba Trocas, grão mensal. Cartões: % do último mês fechado (faixa
**provisória** < 1% / 2% até o Samuel fixar a meta; chip em pp), mês atual até hoje, pagos pelo financeiro (casos ·
ticket médio), em andamento agora (foto, vermelho com 10+), negados % entre os decididos, casos por 1.000 pedidos. Mês
com dia sem receita coletada não vira % — a tabela mostra "≥ R$" e a linha do gráfico fica em branco. Gráfico: % por
marca por mês, valor pago, casos por desfecho, casos/mil. Tabela mês × marca e tabela por tipo de caso (3 meses fechados
+ atual), ordenada por valor pago.

**O que a leitura de 16/09 diz**: receita Aris jul 1,97 mi · ago 2,74 mi · set 1,99 mi em 16 dias; Fish jul 225 mil ·
ago 670 mil · set 345 mil. **ago/26 pago: Aris R$ 1.709 (9 casos, 0,06%), Fish R$ 135 (1 caso, 0,02%)**. Dos 91 casos da
lista, 14 pagos, 10 negados e **67 em andamento (R$ 9,3 mil)** — 41 em `ag. n2` (movidos em bloco em 12/09), 15 em
negociação, 11 com erro. Os 45 casos de setembro são todos "Atrasado — nunca foi enviado". Todo caso com nível é N3:
cupom de cortesia (N1) e compensação parcial (N2) não passam por essa lista. Fish estorna fora da Shopify.

### Fechamento não é resolução: cx_fechamento, "voltou em 7 dias", FCR e a meta do N1 (15/09)

**Problema**: a coluna Fechados por agente vinha do Gleap (CLOSED por agente) e conta fechamento, não desfecho — o
mesmo ticket fechado três vezes conta três, e reabertura concentra em incidente, quando a leitura mais importa. A meta
do N1 passou a ser **fechamentos resolutivos > 120/dia, tempo de resposta < 8 min e CSAT > 75**, então o painel precisa medir resolução.

**Fonte** (verificada em 150 tickets de 18/08–08/09): o Gleap guarda por ticket `GET /tickets/{id}/history` com cada
mudança de status (`FEEDBACK_UPDATED` / `STATUS`, valor, hora e usuário) desde a criação — é histórico completo, dá
para reconstruir tudo desde 16/07. Duas pegadinhas: (1) a **reabertura automática** (cliente escreve num ticket
fechado) **não gera evento de status** — só 9 "OPEN" para 248 "DONE" — então "voltou" sai de `/messages`: primeira
mensagem do cliente (`USER_TEXT`/`BOT_REPLY`) depois do fechamento e antes do próximo, em até **7 dias corridos**;
(2) a **resposta do CSAT** (🤩/😐/😡, "[Button clicked: …]", número) chega como mensagem do cliente depois do
fechamento — sem filtrar, 51% dos tickets "voltavam"; filtrando, sobram retornos de verdade ("alguma atualização do
envio?", "que demora é essa"). Polling, não webhook: webhook só dá tempo real e não dá backfill.

**Dados**: tabela `cx_fechamento` — uma linha por fechamento: `ticket_id, ordem, marca, canal, ticket_dia,
fechado_em, fechado_dia (SP), fechado_por_tipo (pessoa | kai | n8n | servico | sistema), fechado_por_id/nome,
voltou_em, voltou_horas, humano_depois, msgs_humanas/msgs_cliente/msgs_bot (no trecho até este fechamento),
agentes_ate_aqui, checado_em`. Contas de serviço do Gleap são `noreply-…@gleap.io`: "claude" = Kai (uma conta por
projeto), "N8N Access" = n8n. Views `cx_fechamento_dia` (marca × canal × dia do fechamento: fechados, por_pessoa,
por_kai, por_sistema, maduros, resolutivos, voltaram, voltaram_humano, pessoa_/kai_maduros e _resolutivos, fcr_base,
fcr, msgs p50/média) e `cx_fechamento_agente_dia` (só pessoa). **Maduro** = `fechado_em + 7 dias <= now()`;
**resolutivo** = maduro sem volta; **FCR** = 1º fechamento do ticket por pessoa, um agente humano só até ali, sem
volta. `cx_ticket.fechamento_checado_em` marca o que já foi lido.

**Coleta**: backfill de 15/09 (scratch `backfill_fechamentos.py`, 2 chamadas por ticket, ~15 mil tickets) e o
workflow **CX — Fechamentos · noturno** (`VKtqiQ7LkEMsz9TT`, 01:10–06:10 a cada hora, 500 tickets por rodada, forçar
em `GET /webhook/cx-fechamentos-forcar`): revisita ticket novo, ticket atualizado depois da última leitura e ticket
com fechamento ainda imaturo (até 7 dias), apagando e reinserindo as linhas dele. Mesma função nos dois (JS validado
contra o Python nos mesmos tickets). API: blocos `cx_fechamento` e `cx_fechamento_agente` (120 dias).

**Tela**: aba Chat ganhou o cartão **"Voltou em 7 dias"** (fechamentos por pessoa maduros em que o cliente voltou;
faixa proposta < 15% / 25% — não é meta declarada; title traz resolutivos, FCR, Kai e mensagens por fechamento;
gráfico semanal por marca, ponto claro = semana maturando) com etiqueta "voltou: até dd/mm" quando o período ainda
matura. A tabela **Por agente** virou a tabela da meta: **Fechados** (nossos, com /dia e dias com fechamento; meta
120/dia colore o número), **Resolutivos** (% dos maduros; base < 30 vira contagem), **FCR**, **Msgs/fech.** (mediana
de mensagens humanas; embaixo, do cliente), **CSAT** (escala do Gleap; meta 75), 1ª resposta, Trabalhados e Horas
ativas (Gleap). Saíram Respostas, T. resposta e Resolução do Gleap. Etiqueta "resolutivos maduros até dd/mm".

**Tempo de resposta < 8 min (terceira meta, 15/09)**: o "T. resposta" do Gleap por agente é relógio corrido e mistura a
1ª resposta (a fila, horas) com a conversa — dava 6 min para uns e 400+ para outros, e está parado desde 12/09. Medimos
o nosso: tabela `cx_resposta`, **uma resposta humana por linha** — mensagem de pessoa que vem logo depois de uma
sequência de mensagens do cliente; `espera` desde a **primeira** mensagem do cliente daquela sequência, em relógio e em
**expediente** (seg–qui 8–18); se antes falou o Kai ou outro humano, não é resposta a cliente. `primeira` marca a 1ª
resposta humana do ticket, que fica fora das views (`cx_resposta_dia`, `cx_resposta_agente_dia`: respostas, p50/p90
em expediente, p50 relógio, até 8 min, até 30 min). Sai das mesmas `/messages` do noturno de fechamentos (que agora
busca mensagens de todo ticket pendente) e do backfill `backfill_respostas.py`. API: `cx_resposta`,
`cx_resposta_agente`. Tabela por agente: coluna **T. resposta · exped.** (mediana; embaixo, % em até 8 min e nº de
respostas), meta 8 min colore o número; a 1ª resposta continua na coluna ao lado, separada de propósito.

**Backfill de respostas (16/07 em diante)**: 31.059 respostas humanas em 7.112 tickets (3.978 são a 1ª do ticket e
ficam fora). De 11/08 a 14/09, mediana em expediente por agente: Carlos 1,6 min · Juliano 2,3 · Adão 2,6 · Letícia
2,6 · Giovanny 3,8 · Maria Eduarda 4,1 · Vivian 5,8 · **Vitória 11,3** — quase todo mundo bate "mediana < 8 min". O
que não bate é a cauda: só **44–80% das respostas** saem em até 8 min (p90 de 1,5 h a 5 h), então a régua que
diferencia o time é a fatia em até 8 min, não a mediana. A cor da coluna usa essa fatia (≥ 50% ⇔ mediana < 8 min,
exato; a mediana mostrada é ≈ quando pondera dias).

**Meta subiu para 150 (16/09)** e a tabela por agente colore Fechados/dia contra 150 (atenção a partir de 110).
**Mensagens por motivo**: view `cx_fechamento_motivo_dia` (fechamentos por pessoa × motivo do ticket × canal × dia:
fechados, maduros, resolutivos, FCR, mensagens humanas/cliente p50), API `cx_fechamento_motivo`; a tabela "Kai × pessoa
por motivo" da aba Chat ganhou **Msgs/fech.** e **Voltou** por motivo. Leitura de 11/08–16/09 (Aris, por pessoa): WISMO
4.583 fechamentos, 2,6 msgs, resolutivo 62%; outros 3.295, 2,4 msgs, 68%; sem tag 1.213, 1,3 msg, 76%; pré-venda 822,
1,8 msg, 81%; cancelamento 113, 3,2 msgs, 63%; problema 104, 3,4 msgs, 72%. Ou seja: 150/dia é plausível onde o
fechamento é de 1–2 mensagens (pré-venda, sem tag, boa parte de "outros") e não onde é WISMO em incidente — 62% de
resolutivo significa que 4 em 10 fechamentos de WISMO voltam e viram trabalho de novo.

**Nomes que enganavam**: `cx_reabertura_dia` não é reabertura — é ticket criado antes do período com atividade dentro
(comentário da própria tabela); a tira do detalhe passou a se chamar "Ativos de antes do período". `cx_agente_resolucao`
(fechados/reabertos/resolvidos por agente) foi uma tentativa de 18/08–01/09 sem fonte declarada e parou; ficou como
está, sem uso.

**Backfill de 15/09 (16/07 em diante, 15.330 tickets, 22.438 fechamentos)**: por pessoa 16.766 fechamentos em
10.851 tickets — o cliente voltou em 7 dias em **31% (Aris) / 26% (Fish)**; Kai 4.371 → 39% / 21%; sistema 1.301.
Por semana (Aris, fechamentos por pessoa): 27–29% em julho, 36% na semana de 17/08, **41% na de 24/08 (incidente)**,
27% na de 31/08; FCR 73–82% fora do incidente, 65% dentro. Por agente, seg–qui de 11/08 a 07/09: Juliano 140
fechamentos/dia brutos → **87 resolutivos/dia**; Vivian 108 → 73; Adão 97 → 69; Giovanny 97 → 65; Maria Eduarda
55 → 44; Vitória 52 → 38; Carlos 48 → 37. Ninguém chega a 120 resolutivos/dia; só o Juliano passa de 120 no bruto.
Nosso "Fechados" é maior que o do Gleap (Juliano 140 × 67/dia) porque o Gleap conta ticket designado ao agente e
fechado; o nosso conta o clique de fechar, de quem quer que seja o ticket. Mensagens humanas por fechamento: mediana
1–3 por agente — metade dos fechamentos feitos por pessoa tem no máximo uma mensagem dela.

### RA: 102 na página × 260 no RA Empresas — os dois números de "sem resposta" (14/09, noite)

O Samuel apontou que o painel mostrava 102 aguardando quando o RA Empresas tem bem mais. Verificado na página pública
(navegador do Mac): o **"aguardando resposta" da página é o da régua de reputação**, uma janela **fechada de 6 meses**
("Dados de 01/03/2026 até 31/08/2026"), recalculada na virada do mês — setembro inteiro fica de fora; as abas
6 meses / 12 meses / Geral mostram o mesmo `totalNotAnswered=102`. A **fila real** está na busca pública do próprio RA
(`iosearch…/companyComplains?company=<id>&status=PENDING`), que só responde de dentro da página (curl/n8n: 403 Cloudflare):
Aris **260** sem resposta (337 respondidas sem avaliação + 717 avaliadas = 1.314 ativas), Fish 2.

O que mudou:
- `cx_ra_dia` ganhou `periodo_ini/periodo_fim` (janela da régua), `pendentes_agora`, `respondidas_agora`, `avaliadas_agora`,
  `ativas_agora`. `aguardando` continua sendo o número da régua (comentário na coluna diz isso).
- Bookmarklet (`n8n/ra-bookmarklet.js`) e a tarefa agendada coletam os campos novos: período pelo texto da página, id da
  empresa pelo JSON-LD (`identifier`) ou pelo script de analytics (`raichuId`), contagens pela busca pública de dentro da
  página. Receiver `cx-ra-metatags` grava com COALESCE (leitura sem os campos não apaga a anterior). API expõe tudo em `cx_ra`.
- Painel: o cartão RA da Visão geral mostra **"260 sem resposta"** (soma das marcas mostradas; title dá por marca e o
  número da régua); a aba Reclame Aqui tem o cartão **"Sem resposta agora"** (fila real · na régua: N), etiqueta
  **"régua do RA: 01/03–31/08"** no cabeçalho, e a tabela mostra a fila com a régua embaixo. Leitura antiga sem o campo cai
  para a régua e diz "(régua)". Gráfico da fila começa em 14/09.
- Leitura: os cinco critérios do RA1000 são da régua (janela fechada) — o que o time faz em setembro só aparece neles em
  1º/10. A fila real é o que dá para agir hoje: cada uma das 260 que for respondida antes da virada entra na conta de
  outubro; as que ficarem viram "não respondida" na régua e derrubam o índice de resposta (86% hoje, alvo 90%).

### Seis números revistos e fila agora (14/09, tarde)

- **Reclame Aqui virou um cartão só**: a **nota da empresa** (pior marca, alvo ≥ 7) com a composição do RA1000 embaixo
  — resp. · sol. · voltaria · avaliações com ✓/✗ e o "aguardando". O gráfico do cartão é a nota por leitura. Resposta e
  solução continuam como cartões na aba Reclame Aqui.
- **"Ninguém respondeu" entrou nos seis** (transferido e sem resposta humana ÷ tickets de chat maduros; alvo < 5%, atenção
  até 10%) — hoje é o número mais importante do painel e estava escondido na aba Chat.
- **CSAT mostra a taxa de resposta sempre** ("responderam 19%", vermelho abaixo de 25%). Referência: pesquisa pós-chat no
  WhatsApp costuma responder 15–30%; 19–20% não é anormal em si — o problema é que caiu de 42–46% em agosto e que quem o
  Kai fecha responde 9–22% contra 31–53% de quem passou por pessoa, então o CSAT fala mais pelo atendimento humano.
- **Fila agora** (aba Chat, cartão Fila): bloco `cx_fila` na API (um ticket aberto por linha, 90 dias) → esperando pessoa
  (transferido sem resposta humana), espera mediana e p90 em **horas de expediente**, quantos há mais de 1 dia útil e mais de
  1 semana útil, com pessoa, com o Kai, e os **10 tickets há mais tempo esperando** com link para o Gleap
  (`app.gleap.io/projects/<projeto>/inbox/<ticket>` — padrão observado; ajustar se não abrir). Acima de 20 h a espera
  aparece em dias úteis (10 h cada).
- Cabeçalho da Visão geral diz até que dia o Kai/ninguém respondeu estão maduros ("até 08/09" numa segunda).

**"Outros" é WISMO não classificado.** Amostra de 40 dos 835 tickets `outros` do Aristocrata (WhatsApp, 08–13/09): 35 eram
"cadê meu pedido" (rastreio, entrega, pedido) respondidos pelo Kai; 2 só "boa tarde"; 1 cancelamento; 2 sem texto útil. Ou
seja, WISMO real ≈ 37% + 85% de 53% ≈ **80% do chat**. A classificação é do Kai (Gleap); o atalho em nossas mãos é o
workflow `Gleap – WISMO Consulta Pedido` (`yH37IridSjvKgk75`), que o Kai chama para localizar o pedido e hoje **não marca
tag** — marcar `wismo` ali quando o pedido é localizado resolveria a maior parte. Não aplicado: tags dirigem roteamento no
Gleap e é decisão do Samuel/CX Ops.

### Regras que a repaginação fixou

- **CSAT do Gleap tem três opções** (2 ruim / 6 neutro / 10 bom). A coluna `csat` de `cx_snapshot` é a média disso em
  0–100 — não significa nada e saiu da tela. O que se mostra é % bom / neutro / ruim entre quem avaliou, só com 30+
  avaliações; abaixo disso, contagem.
- **E-mail** entra em "contatos", mas fica fora de motivo (a classificação não grava tag lá), de CSAT (não existe) e de Kai
  (não roda lá). A tela diz quantos ficaram de fora.
- **Escalado = transferência real** (`processingTeam`/`processingUser`), nunca `hasAgentReply`. `humanHandoff` do Gleap
  está poluído pela conta de serviço que fecha 81% dos tickets.
- **Comparação só com histórico**: `cx_ticket` começa em 16/07; período de comparação com menos de 80% dos dias não gera chip.
- **Sem dado no período** (ex.: "hoje" antes da coleta) o bloco cai para a última janela existente e diz que caiu.
- **Kai sozinho × pessoa não é comparável diretamente**: quem o Kai fecha responde bem menos à pesquisa (9–22% vs 31–53%)
  e para a pessoa chega o caso difícil. Cada um se compara consigo mesmo no tempo.
- Taxas comparam em **pontos percentuais** ("+22 pp · ant. 2,9%"), não em variação relativa.

## Afiliados TikTok Shop — aba em `influs.html` (14/09/2026)

Lane **separada** dos cupons Shopify: a comissão de afiliado é apurada dentro do TikTok, não por cupom
nem por UTM. Somar as duas contaria a mesma venda duas vezes — por isso tabelas próprias (`crm_tts_*`) e
uma API própria, nunca `crm_influ_pedido`.

**Camadas (mesma ordem do resto do painel):**

1. **Coletor** — workflow n8n `TikTok Shop - Coletor diário de afiliados (03:30 + POST backfill)`
   (id `c2W4sRygi7dhoc6d`). Chama a Open API do TikTok Shop com o access_token do `TikTok Shop - Token
   Manager` e grava por upsert: pedidos de afiliado (janela rolante de 45 dias — settlement e reembolso
   mudam depois do pedido), todos os pedidos de amostra (a API não tem filtro de data; ~15 páginas),
   open collab por produto, target collabs (5 status) + detalhe com produtos e criadores convidados.
   Backfill: `POST /webhook/tts-coleta-…` com `{k, dias}` (pedidos em fatias de 90 dias, limite da API).
   Assinatura HMAC-SHA256 é feita em JS puro dentro do Code node — o sandbox do n8n não libera
   `require('crypto')`, `URLSearchParams` nem `TextEncoder`. O corpo é assinado como string e enviado
   como a mesma string (`json:false`); corpo vazio não é enviado e assina `''` — senão dá 401.
2. **API de leitura** — `TikTok Shop - API do painel (POST, chave influs, JSON+CORS)` (id `ZRPkPSaMRw35uZQj`),
   URL em `config.js` (`TTS_API_URL`). Aceita a chave de leitura do painel de Influs (`crm_dash_chave`,
   painel `influs`/`todos`). Uma consulta `jsonb_build_object` devolve `kpis`, `amostras`, `fila`, `envio`,
   `criadores`, `open`, `target`, `regra`, `serie`, `frescor`. Janela `ini/fim` vale só para pedidos.
3. **Tela** — `influs-tts.js` (objeto puro `TTS` + render), seção `#sec-afil` em `influs.html`.
   Sub-abas: Fila de amostras · Criadores · Colaborações · Regras. Testes: `tests/influs-tts.test.cjs`.

**Regras fixadas:**

- Amostras **não têm data** na API: `approve_expiration_time`/`shipment_expiration_time` só são reais
  enquanto a etapa está aberta (PENDING / AWAITING_SHIPMENT); nos demais status vêm "agora" e são
  descartados. Por isso os blocos de amostra são "agora/histórico" e não obedecem à janela de datas.
  `primeiro_visto_em` passa a ser a data de referência daqui pra frente.
- `crm_tts_amostra.snap_*` é o retrato do criador **no momento do pedido** (preservado com `COALESCE` no
  upsert); `crm_tts_criador` tem o valor atual. É o que permite auditar depois por que a esteira decidiu X.
- GMV usa `COALESCE(base_real, base_estimada)` e exclui `settlement_status = 'INELIGIBLE'` (reembolso/cancelado).
- Percentuais só com base ≥ 30 (pedidos ou amostras); taxa de target collab só com 10+ convidados.
- `fulfillment_pct = 0` significa "sem amostra nos últimos 90 dias", não "não posta" — a regra não penaliza 0%.
- Frescor: etiqueta no cabeçalho da seção = coleta OK mais recente; vermelha se > 26 h ou se a última execução
  de qualquer fonte falhou (`crm_tts_coleta_log`). Se a leitura falhar com dado em tela, mantém o dado e avisa.
- Coluna "Sugestão" da fila é o que a esteira **faria** com `crm_tts_regra` (modo `dry_run`). A decisão
  continua no Seller Center. Aprovar/rejeitar pelo painel e editar a regra são a próxima etapa.

**Esteira de amostras (dry-run desde 14/09/2026)** — workflow `TikTok Shop - Esteira de amostras`
(id `U7MNDRQYwvM4ovPG`, a cada 2 h + `POST /webhook/tts-esteira-…`). Lê a VIEW `crm_tts_fila_v` (fonte
única do tier: mesma usada pela API do painel), decide só o que está PENDING e sem `decidido_em`, e grava
`decisao`/`decisao_motivo`/`dry_run` em `crm_tts_amostra`. Regras: `comprovado` → `auto_aprovada` até o
`teto_mensal` da marca (depois vai pra fila manual); `descoberta` → `fila_manual`; `fora_*` → `auto_rejeitada`;
`is_approvable = false` → fila manual. Só chama `/sample_applications/review` no TikTok quando
`crm_tts_regra.modo = 'ativo'` para a marca — hoje as duas estão em `dry_run` (grava e não executa);
`pausado` não toca. Regra de SKU: `crm_tts_regra.sku_regex` (Postgres ARE sobre `"título | variante"`) e/ou
`skus_permitidos[]`. Vigente: Fish = multifilamento só 150 m, monofilamento só 300 m; Aristo = unitário ou
kit de até 3 sabonetes, misto incluso (fora: Kit/N Unidades com N ≥ 4). Régua: Fish 10k/3k, Aristo 5k/2k (GMV 30d), postagem mínima 86%
(0% não penaliza), teto 30/15 por mês. Na fila do painel, decisão gravada aparece como "Aprovar/Rejeitar/Avaliar
(simulado)" com o motivo no `title`.

**Ação pelo painel (14/09/2026, noite)** — workflow `TikTok Shop - API de ação do painel` (id `LCODPC1y6kRPQ6hI`),
URL em `config.js` (`TTS_ACAO_URL`), chave de ESCRITA própria (não mora no repo; a Marcela digita uma vez, fica em
`localStorage.shrigma_tts_wkey`). Ações: `revisar` (aprova/rejeita 1 pedido no TikTok via
`/sample_applications/review`, grava `manual_aprovada|manual_rejeitada`, `decidido_por = autor (painel)`, e adianta
o `status` para AWAITING_SHIPMENT/REJECT_CANCELLED — a varredura das 03:30 confirma) e `regra` (edita `gmv_auto`,
`gmv_manual`, `fulfillment_min`, `teto_mensal`, `modo` de `crm_tts_regra`, com faixa validada; `sku_regex` só no banco).
Na fila, botões Aprovar/Rejeitar de dois cliques (o 2º confirma); na aba Regras, campos editáveis + Salvar (modo
`ativo` pede confirmação explícita). Falha do TikTok volta como 400 com a mensagem da API e vai pro `crm_tts_coleta_log`
(`fonte = 'acao_painel'`). **A chamada real de review ainda não foi exercitada** — o primeiro uso da Marcela é o teste.

**Esteira × PENDING fresco** — antes de decidir, a esteira chama o coletor em modo `abertas` (`{modo:'abertas'}`:
só PENDING e AWAITING_SHIPMENT, 1–2 páginas). Pedido que estava aberto no banco e não voltou nessa busca vira
`status = 'ENCERRADA_AGUARDANDO_SYNC'` (saiu da fila; o status real vem às 03:30).

**Tokens e escopos (14/09/2026, noite)** — o pacote de ESCOPOS fica preso à autorização da loja: ligar um
escopo novo no Partner Center **exige re-autorizar cada loja**, e um token antigo continua respondendo
`105005 Access denied` nos endpoints do escopo novo. Medido hoje nas duas lojas: Affiliate OK; **Order,
Product e Analytics em 105005**. Para que a re-autorização passe a valer sozinha, o workflow `TikTok Shop -
Captura de Autorização` agora descobre as lojas da autorização (Get Authorized Shops) e grava o refresh
token em `crm_tts_token`; o `Token Manager` lê dessa tabela primeiro e **descarta o cache quando a
`autorizado_em` muda** — sem isso o cache continuaria servindo um token com os escopos antigos. Os `SEEDS`
no código ficam só como rede de segurança da primeira autorização.

**Decisão de amostra é manual (15/09/2026).** O painel só oferece `simulação` e `pausado`; ligar
`crm_tts_regra.modo = 'ativo'` é decisão do Felipe, direto no banco. Aprovar e rejeitar acontece pelos
botões da fila, um a um, com autor registrado.

**Primeira medição de concordância (15/09):** 1 decisão comparável, e foi desacordo — @maykosantos_ia
(R$ 24.514 de GMV 30d) pediu multifilamento 300 m; a esteira teria rejeitado por SKU e a decisão humana
foi aprovar e enviar. Daí o tier **`sku_fora_comprovado`**: variante fora da regra + criador acima do
`gmv_auto` vai para a fila manual, nunca para rejeição automática.

**Limite de QPS (15/09):** a coleta das 03:30 tomou `429` em `target` nas duas marcas, e a esteira
chamava o coletor **duas vezes em paralelo** (o nó HTTP rodava uma vez por item do Token Manager, que
devolve duas lojas). Corrigido com `executeOnce` no nó, backoff de 1,5 s → 12 s com reassinatura em 429/5xx
e pausa curta entre páginas. Coleta completa depois da correção: 12 fontes sem erro em ~2 min.

**Próximos passos (na ordem):** medir concordância do dry-run (decisão da esteira × o que a Marcela fez no
Seller Center, via `status` final) → webhook "Sample Application Status Change" no Partner Center → aprovar/rejeitar
pelo painel → edição de `crm_tts_regra` pelo painel → ligar `modo='ativo'` por marca → follow-up de
`CONTENT_PENDING` via API de mensagens.

## Growth — operação por canal (08/09/2026)

`growth.html` mantém a navegação existente e permite recortar marca, período e canal.
A visão inicial mostra disparos, pedidos e receita atribuída, com cards de WhatsApp e e-mail;
a aba **Automações** separa cada marca/canal/fluxo/peça e permite filtrar a tabela por fluxo.

- `growth-data.js`: datas, campanhas, réguas, atribuição e A/B; funções puras compartilhadas pelo front e testes.
- `growth-delivery.js`: reconciliação dos aceites/status WhatsApp e volumes de e-mail.
- `growth-ui.js` / `growth.css`: cards, indicadores de cobertura e tabela por canal.
- A API já existente recebe `painel=growth` para restringir a resposta quando a chave é mestra; isso não amplia o acesso de outra chave. Nenhuma chave fica no código.

### Significado dos números

WhatsApp usa `crm_wa_envios` e `crm_wa_cobertura`: agregados de 90 dias BRT do motor próprio,
associados aos status pelo ID da mensagem. Aceite não é entrega. `delivered` ou `read` comprovam
entrega; falhas com entrega posterior não duplicam o funil. Registros sem aceite não entram
em disparos. O fluxo explícito `teste-motor` é contabilizado à parte; outros testes internos
podem permanecer porque o histórico não grava o modo. Não inclui volume da Reportana.

E-mail separa campanhas Listmonk e automações: o log transacional comprova aceite da API,
não entrega individual SES. Abertura, CTR e CTOR usam apenas as campanhas com a medição correspondente.
Métricas ausentes ficam como `—`. Receita e pedidos do resumo vêm da data da compra/último clique;
não são uma taxa de conversão da coorte de envios. Receita na tabela de campanhas é acumulada
dos disparos selecionados. Atribuição ambígua entre dois fluxos com a mesma peça não é duplicada.

Comparações percentuais só aparecem para períodos fechados e bases conhecidas. Datas seguem Brasília
independentemente do fuso do dispositivo. O gráfico exclui receita orgânica e não usa cliques de e-mail
como se fossem WhatsApp. A atualização automática mantém o último dado quando há falha e permite repetir.

### Verificação sem navegador

As fixtures dos testes são sintéticas. Não incluir payloads reais, credenciais ou backups da API neste repositório.

```sh
npm install --no-audit --no-fund --prefix ../growth-test-tools linkedom@0.18.12
node --test tests/*.test.cjs
```

O teste de integração usa um DOM local, sem navegador ou chamadas externas. Opcionalmente,
`GROWTH_LIVE_PAYLOAD` pode apontar para um payload agregado privado, fora do repositório,
para reconciliar os indicadores com uma consulta real. A extensão da API foi aplicada separadamente,
com backup, guarda de versão e confirmação da versão publicada.


### Acompanhamento e saúde por conta (08/09/2026)

O aviso de saúde avalia o horário de **cada conta**: uma verificação recente de uma WABA
não encobre outra com dado antigo. Dados ausentes, inválidos, muito futuros ou com mais de
duas horas não recebem sinal verde. Alertas antigos continuam identificados como históricos;
um alerta do monitor não equivale à interrupção de todos os envios próprios. A visão é geral
das contas recebidas pela API e pode incluir atividade de outros provedores.

Os avisos de e-mail respeitam o canal selecionado e mantêm os limiares internos de atenção.
Os percentuais das campanhas selecionadas não são a reputação oficial da conta SES. A AWS
usa volume representativo e critérios próprios; o painel não infere suspensão da conta a
partir desse recorte. Referência conferida em 08/09/2026:
[Processo de revisão de envio SES](https://docs.aws.amazon.com/ses/latest/dg/faqs-enforcement.html).
`gerado_em` indica a geração da consulta, não o horário de coleta de todas as suas fontes.

A seção **Acompanhamento das automações** destaca falhas de entrega, erros anteriores ao
aceite e aceites sem confirmação, agrupados por marca/fluxo/peça. Atalhos abrem Automações
com o filtro correspondente e preservam o período. A ausência de uma contagem em qualquer
parte da base deixa o total desconhecido, em vez de mostrar soma parcial ou zero.
O quadro representa o histórico do recorte, não estado ligado/parado; o último registro é
da peça inteira e não necessariamente da falha. Sombra sem erro não entra como ocorrência.
A cobertura de e-mail permanece informativa até existir reconciliação individual SES.


### Operação atual e templates (08/09/2026 · revisado em 09/09/2026)

A aba **Automações** separa **Envios no período**, **Operação atual** e **Templates WhatsApp**.
O objeto `crm_operacao` é um snapshot sanitizado fornecido exclusivamente pela API autenticada
no escopo Growth/todos. Credenciais, parâmetros de workflows e dados de clientes não entram
no contrato do front. A coleta automática roda a cada 5 minutos; a UI distingue conferência
pontual de coleta automática e sinaliza dados com 15 minutos ou mais.

**O inventário é dinâmico.** O coletor mantém a lista de workflows e templates acompanhados;
o painel exibe o que a coleta mais recente devolveu e não fixa quantidades no código. Referências
datadas: 14 workflows/23 templates na conferência de 08/09 às 13h37; 15/24 a partir das 19h15 do
mesmo dia. Esses números são observações, não limites do schema — novos vínculos entram na lista
do coletor (lado Codex) e aparecem no painel na coleta seguinte, sem mudança de front.

Ativação e publicação não comprovam entrega. Modos vêm da versão publicada; serviços
compartilhados aparecem nos filtros de marca. A última execução disponível respeita a política
de retenção: um erro antigo pode continuar aparecendo quando sucessos não são salvos.
Templates mostram status/categoria esperada e observada; cartões aprovados cuja integração ainda
está pendente continuam separados dos templates mapeados nos fluxos. O catálogo traz metadados,
não corpo, componentes ou mídia. O filtro de datas afeta apenas o histórico; marca e canal afetam
também o inventário atual. Falha de consulta de um workflow (`collection_status=error`) aparece
como consulta indisponível, nunca como automação desligada, entrega falha ou operação saudável.
A ausência ou falha de coleta não aparece como estado saudável, e a interface não oferece
controles de edição sem backend.

O incidente `new` com horários nulos no inventário foi corrigido em 09/09 às 17h43 (Brasília):
a coleta de 17h45, conferida às 17h46, preservou configuração de `fish_pix`/`receiver`, com
15 workflows, 24 templates e zero erro de coleta. É evidência datada, não diagnóstico da fila
atual. A separação por `config_collection`/`execution_collection` ainda é proposta em R1.

### Navegação, exportação e estado da tela (09/09/2026)

- **Faixa de fontes** sob os filtros: hora da última resposta da API, último status WhatsApp
  recebido da Meta, última coleta de venda (Shopify), de e-mail (Listmonk) e do inventário.
  Cada fonte tem o próprio horário; a etiqueta só muda de cor quando existe regra conhecida
  (inventário com mais de 15 minutos, consulta que falhou, fonte ausente).
- **KPIs adaptativos**: no canal WhatsApp a primeira linha mostra aceitos, entregues, falhas,
  receita e pedidos; na visão consolidada, entrega WhatsApp e CTR de e-mail; no e-mail, CTR com a
  base medida declarada. Cada KPI tem um atalho para a tabela que o explica, preservando marca e período.
- **Tabelas** (Campanhas, Conversão, Automações, Operação atual, Templates): busca sem acento,
  ordenação por cabeçalho (valor ausente sempre no fim, em qualquer direção), filtros de estado/modo
  nos workflows e status/categoria/uso nos templates, estados vazios que dizem qual filtro esvaziou
  a lista e botão para limpar.
- **Exportar CSV** exporta exatamente as linhas visíveis (busca, filtro e ordenação aplicados),
  com colunas de recorte repetidas em toda linha (marca, canal, período, hora da consulta; nos
  inventários, hora da coleta). Formato: `;` como separador, vírgula decimal, UTF-8 com BOM — abre
  direto no Excel em português. Valor ausente vira célula vazia, nunca zero; receita indivisível
  sai em branco com a coluna "Receita indivisível" = sim; texto que começa com `=`, `+`, `-` ou `@`
  recebe apóstrofo. Não exporta a chave, `version_id`, `id` de template nem nada que a tela não mostre.
- **Estado preservado**: ordenação, busca e filtros vivem em memória, não no DOM; linhas abertas,
  `details` e o cursor da busca sobrevivem à atualização a cada 60 s e à falha de consulta.
  A URL carrega marca, canal, período, seção e aba (`#marca=fish&canal=whatsapp&p=7&sec=regua&aba=templates`):
  copiar o link entrega a mesma tela. A chave nunca entra na URL nem no hash.
- Implementação em `growth-table.js` (funções puras, testadas em `tests/growth-table.test.cjs`)
  e nos testes de DOM em `tests/growth-render.test.cjs`.

### Rascunhos locais de template (Entrega 2 · 09/09/2026)

A aba **Automações › Rascunhos locais** é um editor para escrever e revisar templates de WhatsApp
e e-mail **antes** de existir cadastro pelo painel: nome, marca, canal, idioma, categoria esperada,
peça, cabeçalho, corpo com variáveis `{{n}}`, rodapé, exemplos das variáveis, botões (resposta rápida,
link, telefone), prévia do texto digitado com os exemplos aplicados, checagens locais (perfil conservador
de 1024/60/60/25 caracteres para corpo/cabeçalho/rodapé/botão, até 10 botões, variáveis em sequência,
exemplos, `https://`, aviso de link para atendimento e linguagem de oferta em Utility) e importar/exportar em JSON.

O rascunho fica **só no navegador** (`localStorage`, chave `shrigma_growth_rascunhos`) e a tela diz isso
em todo lugar: não é cadastro na Meta, no Listmonk nem no n8n; não existe botão de publicar, submeter
ou ativar; a prévia é do que foi digitado, nunca de um template publicado (o contrato atual não traz
corpo de template). Se o nome coincidir com um template do catálogo, o card avisa que existe um
template com esse nome e status, sem tratar o rascunho como esse template. Exportação não leva o id local
nem qualquer credencial; importação aceita só campos conhecidos. Integração real: `BACKEND_REQUESTS.md` (R5).
As checagens não certificam aprovação nem categoria na Meta. Na revisão de 10/09, a documentação
oficial de componentes respondeu HTTP 429; não houve recertificação das regras atuais.
Antes de implementar submissão (R5), validar novamente combinações de botões, variáveis por
componente, idiomas e limites do tipo de template suportado.
Código em `growth-drafts.js` (regras e armazenamento, puro) e `growth-drafts-ui.js` (tela).

### Contrato proposto de gestão de templates/workflows (Entrega 3 · 09/09/2026)

`BACKEND_REQUESTS.md` (R5) especifica, para o Codex implementar, o contrato que o painel consumirá
para gerir templates e workflows: capacidades por chave (`capabilities`), leitura de conteúdo e
histórico, rascunho no servidor e validação (sem efeito externo), submissão e acompanhamento
(Meta/Listmonk), controles de workflow (modo/ativação) com chave de escrita própria, versão esperada,
idempotência, auditoria e a distinção rascunho → validado → submetido → publicado ≠ ativo.
`tests/fixtures/growth-templates-contract.synthetic.json` é a fixture sintética desse contrato.
**Nenhum desses endpoints existe**; o painel só exibirá os controles quando a API declarar a
capacidade correspondente — hoje não exibe nenhum.

### Fontes por coleta e saúde dos fluxos (10/09/2026)

A API Growth passou a devolver `crm_fontes` (hora, cadência e status de coleta por fonte — `coleta` ≠ `evento`:
o último status recebido da Meta é push e não indica saúde) e `wa_fluxo_saude` (tabela `shrigma_wa_fluxo_saude`,
gravada de hora em hora pelo workflow "WA · Saúde dos fluxos": gatilho de e-mail sem linha WhatsApp em 2h, aceites sem
status da Meta em 1h, falhas > 20%; task no ClickUp ao virar alerta e a cada 6h). A faixa de fontes usa `crm_fontes`
quando presente (fallback antigo continua) e os chips de saúde dos fluxos aparecem sob ela — só com dado da API;
ausência não vira "saudável".

### Template → workflow e métricas por template (R3 · 10/09/2026)

O coletor de inventário passou a declarar `mapped_in` por template a partir do **manifesto** (workflow, peça e campo
de modo que governa a peça — nunca inferido do nome; `native_pending` fica vazio) e deixou de fixar 15/24 no código.
A API Growth devolve `crm_wa_template` (mesmas métricas de `crm_wa_envios` com a dimensão `template_ref`; a soma por
dia/marca/fluxo/peça reconcilia com a peça). A aba Templates mostra "workflow · peça · modo atual" e
"registros · aceitos · entregues · falhas" do período selecionado, e exporta as três colunas; sem os dados na resposta,
nada é inventado.

### Templates ponta a ponta atrás de `capabilities` (Fase A · 11/09/2026)

A aba **Automações › Rascunhos locais** ganhou o ciclo completo do contrato R5, mas **cada botão só existe se a API
declarar a capacidade** em `capabilities` (R5.1) e informar `capabilities.endpoints.templates` (ou `TEMPLATE_API_URL`
em `config.js`). Sem isso a tela é a mesma da Entrega 2. Hoje a API de produção não declara `capabilities`, então nada
disto aparece em produção — foi desenvolvido e testado contra `tests/fixtures/growth-templates-contract.synthetic.json`
e um fetch falso.

- **Arquivos:** `growth-templates-api.js` (regras: capacidades, cliente, tradução de erros, máquina de estados,
  publicado ≠ ativo, prévia de `components`), `growth-drafts-ui.js` (tela), `growth-control.js` (aba Templates).
- **Etapas visíveis no cartão:** Local → No servidor → Validado → Submetido → Publicado (ou Rejeitado). O estado só
  muda com resposta da API; o painel nunca escreve "aprovado" por conta própria.
- **Salvar no servidor** (`draft`) grava também neste dispositivo, com `draft_id`, `version` e um hash do conteúdo.
  Editar depois disso marca "Alterado após salvar no servidor (vN)" e **esconde Validar/Submeter** até salvar de novo.
- **Validar** (`validate`) nunca fala com a Meta; `422` aparece como "API: …" junto das checagens locais.
- **Submeter** (`submit`) abre um resumo (nome, marca, canal, categoria, o que acontece depois) e exige digitar
  `submeter`; o botão só liga com a palavra certa. Manda `expected_version` e `confirm`. Depois: "Submetido · aguardando
  Meta desde HH:MM", consulta automática a cada 60 s (`acao=submissao`) e botão "Verificar agora".
- **Publicado ≠ ativo:** cartão e aba Templates mostram "Publicado · ativo em modo real (wf)" só quando um workflow do
  inventário está ativo e com o modo daquele template em `real` (via `mapped_in`); senão "Publicado · não ativo (…)".
- **Erros (R5.7):** `401` esquece a chave de escrita guardada (`shrigma_tpl_key`, mesmo padrão da chave do A/B);
  `403` diz qual capacidade falta; `409` mostra "Alterado por <who> às <hora> (versão N). Recarregue e refaça; nada foi
  sobrescrito" e oferece "Refazer sobre a vN" (só ajusta a versão esperada, nada é enviado); `502` com
  `nothing_changed:true` → "nada foi alterado, tente em X s"; sem essa garantia → "estado incerto, consulte o histórico".
- **Idempotência:** uma chave por tentativa; depois de `502`/rede a **mesma** chave é reaproveitada na repetição.
- **Histórico:** cada cartão tem "Histórico (n)" com `who`/`when`/ação/resultado — eventos locais mais os da API
  (`acao=historico`) quando `list_history` for true.
- **Aba Templates:** com `read_content`, botão "Carregar conteúdo publicado" busca `components` e mostra a prévia
  fiel (texto escapado; `body_html` de e-mail nunca é injetado) e, com `list_history`, o histórico por template.
  Coluna "Publicado / ativo" no CSV.
- **Chave de escrita:** pedida uma vez (prompt) e guardada só neste navegador; nunca vai em URL, arquivo exportado,
  log ou histórico. A chave de leitura do painel só é usada nos GETs.
- O que o contrato precisou ganhar para isso funcionar está em `BACKEND_REQUESTS.md` › R5.9.

Testes: `tests/growth-templates-api.test.cjs` (regras) e o bloco "Fase A" em `tests/growth-render.test.cjs`
(ciclo completo, 409/502/401, aba Templates). 115 no total.

### Correções da revisão independente de 11/09/2026 (F01–F07)

Parecer do chat GPT sobre o patch R2/R3, todas as sete linhas tratadas nesta base:

- **F01** — contagem desconhecida nunca vira zero: `templateMetrics` usa a regra de `GD.count`/`GD.sumKnown` (Envios); se
  qualquer linha tiver `aceitos:null`, a soma de aceitos é "—" na tela e célula vazia no CSV ("parte não medida"). Array
  vazio só é "0" com `crm_wa_template_cobertura` declarada e cobrindo o período; senão "Sem linha no período · cobertura
  não declarada" e CSV vazio. Coluna "Cobertura das métricas" no CSV.
- **F02** — faixa de fontes com tabela fechada de estados: `ok`, `atrasado`→velho, `error|erro`→ruim ("falhou · último
  sucesso HH:MM", a hora é do último sucesso), `tipo:evento`→evento (neutro, "silêncio não é falha"), qualquer outro
  status → "status não informado" (nunca herda ok). O limiar "2× a cadência" saiu: só o que a API declarar.
- **F03** — vínculo template→workflow só diz "modo configurado: real" (tom verificado) quando a consulta do workflow é
  atual e os campos válidos; senão "último modo observado: real · consulta com falha/desatualizada (HH:MM)", tom aviso.
  A mesma regra vale para "Publicado · ativo em modo real" na aba Templates e nos cartões de rascunho.
- **F04** — a soma por template exclui `flow:teste-motor`, igual a Envios, e diz quantas linhas de teste ficaram fora.
- **F05** — o CSV exporta a mesma projeção da tela (rótulo · peça · modo qualificado), não a chave interna do workflow.
- **F06** — `mapped_in`, `crm_fontes`, `wa_fluxo_saude` e `crm_wa_template` toleram linha inválida (null, primitivo,
  objeto sem chave): a linha é contada e ignorada, o resto renderiza, e a contagem aparece na tela.
- **F07** — chips de saúde dos fluxos são botões (`aria-expanded`/`aria-controls`) que abrem um detalhe visível com motivo,
  hora da verificação e "em alerta desde"; a explicação das métricas por template é um `<details>`; ambos sobrevivem ao
  redesenho de 60 s. Estado desconhecido mostra "Estado não informado", não "Sem ocorrência".

Também da revisão, aplicado ao que é do front: `provider_status` fora de PENDING/APPROVED/REJECTED (PAUSED, DISABLED…)
não vira aprovação nem rejeição (C03); texto de submissão de e-mail não afirma mais "cria campanha" (B01, decisão do
contrato); a prévia de `components` nunca é reenviada como payload (B04 — o POST leva só os 12 campos do rascunho).
Contrato: `BACKEND_REQUESTS.md` › R5.9 e/f. O script `reproduzir-achados-r2-r3.cjs` da revisão não veio com o parecer;
os casos dele foram reescritos como testes de comportamento esperado em `tests/growth-render.test.cjs`.

### Fluxos · leitura (Fase C · 11/09/2026)

Nova aba **Automações › Fluxos** (`growth-flows.js` regras, `growth-flows-ui.js` tela, hash `#sec=regua&aba=fluxos`).
Duas origens, sempre rotuladas no cartão:

- **Observado no motor** (o que existe hoje): grão `(marca, flow)` a partir de `crm_fluxo` + `crm_wa_envios`, com peças
  e canais; template e workflow/modo vêm de `crm_operacao.templates[].mapped_in` → `workflows` (com a mesma qualificação
  "modo configurado" / "último modo observado" do F03); saúde de `wa_fluxo_saude`; volume do período com a semântica de
  Envios (desconhecido = "—", `teste-motor` fora). **Gatilho, ordem e esperas aparecem como "não declarado"** — a lista
  de peças é alfabética e diz isso. O badge de modo do fluxo só é "real" verificado se todas as etapas têm workflow
  declarado, em real, ativo e com consulta atual; cobertura parcial vira "(n de m etapas com workflow declarado)".
- **Definição declarada** (`crm_fluxo_def`, contrato R6 — não existe ainda): gatilho (evento, chave, reentrada, saídas),
  versão (número, ativa, rascunho pendente), modo e etapas em ordem (espera / mensagem / condição / fim), com prévia do
  template quando o conteúdo publicado estiver carregado na aba Templates. Definição inválida é contada e listada.
  Quando existe definição para um `(marca, flow)`, ela substitui o cartão observado.

Busca, filtro por origem, recorte por marca, CSV por etapa (mesma projeção da tela), estado vazio e 360px conferidos em
Chromium headless. **Nenhum botão de edição**: depende da API de fluxos (Fase B). Testes: `tests/growth-flows.test.cjs`
e o bloco "Fase C" em `tests/growth-render.test.cjs`. 120 no total.
