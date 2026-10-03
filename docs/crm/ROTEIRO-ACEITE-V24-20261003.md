# Roteiro de aceite do CRM no canário V24 — 03/10/2026

Quem executa: Felipe (conta mestre) + analista (conta individual de teste). Navegador próprio, à mão — **sem automação nem navegador de terceiros**.

Endereços: https://dashboard-v24-gerencial.tazdb8.easypanel.host (gestão/contas) e https://dashboard-v24-crm.tazdb8.easypanel.host (CRM).

## Fonte e imagem do V24

Fonte: `docs/deployment/CRM-FINAL-INTEGRATION-20261003.md` da PR #214 (head `5e80f983`).

| Item | Valor registrado |
|---|---|
| Serviço | `dashboard-image-20260930/web-access-v24-f58dfa73` |
| Imagem | `ghcr.io/bandssz/shrigma-dash-operational-canary@sha256:9d25e5d9d78ba5734f9b7a008f6d512becc95d91402d92eaddc62c5ebc669705` |
| Revisão | `f58dfa7333c9e2b66d0e39023eb3ea39bc5802ea` (CI 37116055111, 875 aprovados) |
| SHA do pacote | `9338ef1e…` segundo o doc (é o último pacote medido antes do V24). **Que é exatamente o pacote do V24: a confirmar pelo Codex** |
| Upstreams ligados | só `crm-read` (`identity`, `cache_growth`) |
| Desligados | provisionamento gerenciado, `DASHBOARD_CRM_MANAGED_READ_UI`, todas as flags de escrita, emissor READ V3 (não executado), rotas `campaigns`, `campaigns_media`, `segments`, `campaign_audience`, `templates` |
| Bundle do CRM | inclui a entrega da PR #216 (head `e91e44ab`). **Se os commits desta branch (`d9d85a1` duas abas, `a19555c` mídia) estão no V24: a confirmar pelo Codex** |

`/healthz` devolve só `ok/mode/identity/runtimeUid`, sem revisão: a versão vem do digest mostrado no Easypanel, não da página.

## Regras de execução

- **Proibido** agendar, cancelar ou enviar campanha real, e mexer nos rascunhos reais 167/168.
- Escrita (campanha, público, mídia) só quando liberada **e** só com marca/lista/destinatário sintéticos. No V24 hoje, nenhuma escrita comercial está liberada.
- Resultado incerto (timeout, aba fechada, 5xx): **não repetir o POST**. Recarregar e usar "Consultar tentativa" (GET do mesmo recibo). Não apagar o diário (`shrigma_campaign_operation_v1:*`, `shrigma_growth_editor_v1:*`).
- Evidência: print da tela + horário (Brasília) + ID sintético/ID da operação quando aparecer. **Nunca** registrar e-mail de cliente, contagem nominal, chave, cookie, link de convite ou bootstrap.
- Falhou um passo de leitura → anota e segue. Falhou isolamento (marca vazando, outra área acessível, escrita aceita) → para e avisa o Codex.

## Status

- **testado**: comportamento provado em teste sintético (arquivo › teste). Não prova dado real nem login humano.
- **preparado**: código na imagem, mas desligado/não instalado no V24.
- **bloqueado por ativação**: depende de algo ainda não ativado (indicado no passo).

Prefixos: `ref214/` = testes da PR #214 (rodam na CI875); sem prefixo = `tests/` desta branch.

---

## P0. Conferir o canário antes de tudo

- **Pré-condição:** acesso de leitura ao Easypanel.
- **Ação:** abrir o serviço `web-access-v24-f58dfa73`, conferir digest e estado; abrir `/healthz` nos dois hosts.
- **Esperado:** digest `sha256:9d25e5d9…c669705`, 1 réplica, saudável; `/healthz` com `"ok":true`, `"runtimeUid":1000`, sem `synthetic`.
- **Evidência:** print do digest + horário.
- **Status:** **testado** (imagem/CI) — CI 37116055111 no `f58dfa7`; `ref214/tests/dashboard-operational-canary.test.cjs` › "operational canary binds every request to its user, area, slot and pinned upstream". Correspondência pacote↔V24: a confirmar pelo Codex.

## P1. Login individual — conta mestre

- **Pré-condição:** conta mestre já ativa (copiada do V23). **Não redefinir senha.**
- **Ação:** entrar em `dashboard-v24-gerencial` com e-mail+senha; depois abrir `dashboard-v24-crm`. Abrir o host CRM numa janela anônima sem login.
- **Esperado:** login sem código de verificação; o CRM abre só com sessão; anônimo cai na tela de entrada; CX inexistente/negado.
- **Evidência:** print de cada tela + horário. Nada de cookie.
- **Status:** **testado** — `ref214/tests/dashboard-operational-auth.test.cjs` › "an existing active admin with legacy TOTP data signs in with password after upgrade", "login rate limits, host binding, and absolute session expiry"; `ref214/tests/dashboard-operational-server.test.cjs` › "host routing, CX removal and isolated synthetic API enforcement". Login humano real no V24: **não provado ainda** (as 45 verificações foram anônimas).

## P2. Login individual — gestor (analista)

- **Pré-condição:** convite individual criado pela conta mestre para e-mail interno do analista, só área CRM, só leitura.
- **Ação:** analista abre o convite (canal privado), define senha, entra no host CRM; tenta abrir o host gerencial/orgânico/influs.
- **Esperado:** entra só no CRM; outras áreas negadas; convite não reutilizável.
- **Evidência:** print da lista de usuários (sem e-mail completo, pode cortar) + horário de ativação.
- **Status (login e escopo de área):** **testado** — `ref214/tests/dashboard-operational-auth.test.cjs` › "invite, area grants, CSRF, encrypted per-slot bearers and revocation", "credential slots are fixed and scoped to their own area"; `ref214/tests/dashboard-operational-flow.test.cjs` › "complete isolated flow: password admin, invite, team scope, CSRF and revoke".
- **Status (gestor ver dados do CRM):** **bloqueado por ativação** — emissor READ V3 não executado, provisionamento gerenciado e `DASHBOARD_CRM_MANAGED_READ_UI` OFF. Código **preparado**: `ref214/tests/dashboard-operational-managed-crm-http.test.cjs` › "HTTP admin creates two managed CRM accounts, verifies their private origin identities and revokes only one". Hoje o gestor deve ver a área vazia/indisponível, **nunca** dados com a credencial do mestre (`ref214/tests/dashboard-operational-auth.test.cjs` › "admin uses only a self-owned Growth reader for CRM while backend identity stays area-scoped").

## P3. Catálogo: frescor e idade dos dados (mestre)

- **Pré-condição:** P1 ok; credencial `crm-panel-read` própria do mestre presente (se faltar, o painel recusa — anotar como bloqueio, não contornar).
- **Ação:** CRM › Início e Resultados em Fishermans; ler o cabeçalho de horário e a idade das contagens de Público.
- **Esperado:** horário em Brasília; retrato acima de 20 min aparece como "último retrato" com aviso (sem tela branca); contagem desconhecida ≠ 0; idade da contagem é a da coleta, não a da página.
- **Evidência:** print do cabeçalho/etiqueta de frescor + horário.
- **Status:** **testado** — `claude-crm-freshness.test.cjs` › "D3: falha de atualização mantém a leitura anterior…", "D4: primeira leitura com cache acima de 20 min mostra o último retrato…", "D4 (futuro)…", "D5: legenda do gráfico mostra a coleta de venda da marca selecionada…"; `growth-cache-read.test.cjs` › "a stale cache (older than 20 min) is refused"; `growth-audience.test.cjs` › "date-only snapshots retain their day in Brazil and show the age of the count, not the page refresh"; `ref214/tests/dashboard-operational-crm-cache-limit.test.cjs` › "a synthetic Growth cache just below eight MiB completes through the HTTP gateway". Dado real no V24: a validar neste passo.

## P4. Troca de marca A→B→A (Fishermans → O Aristocrata → Fishermans)

- **Pré-condição:** P3 carregado em Fishermans.
- **Ação:** trocar para O Aristocrata em Início, Resultados e Público; voltar para Fishermans. Repetir com uma leitura ainda carregando.
- **Esperado:** nenhum número, lista, alerta ou contador de uma marca aparece na outra; troca durante leitura pede para aguardar; voltar a Fishermans mostra os dados dela de novo.
- **Evidência:** 3 prints (A, B, A) com o seletor de marca visível + horário.
- **Status:** **testado** — `claude-crm-two-brands.test.cjs` › "D3: contador de Público calculado em Fishermans não aparece em O Aristocrata…", "aceite: leitura de públicos de Fishermans em andamento segura a troca…", "aceite: tentativa incerta de campanha em Fishermans fica preservada ao alternar Fishermans → O Aristocrata → Fishermans, sem POST"; `claude-crm-freshness.test.cjs` › "D1: alerta de dados de Fishermans (Início) não permanece…", "aceite: atualizações concorrentes viram uma leitura; resposta que chega depois de trocar a marca é desenhada na marca atual"; `ref214/tests/dashboard-operational-campaign-create-ui.test.cjs` › "lost request/404 survives brand A-B-A close/reload…". Ressalva: os testes `claude-*` rodam no `growth.html` desta branch; presença das mesmas correções no bundle V24 a confirmar pelo Codex.

## P5. Listas

- **Pré-condição:** P3/P4 ok.
- **Ação (a):** Público › tabela de listas/audiências em cada marca: ordenar por tamanho, buscar.
- **Esperado (a):** só listas da marca; desconhecidos no fim, nunca 0; sem somar audiências sobrepostas.
- **Status (a):** **testado** — `growth-audience.test.cjs` › "latest snapshot wins…; brands never join by ID alone", "size sorting uses confirmed counts, keeps unknowns last…", "read-only UI preserves the search/sort controls across refresh and brand change… never sums overlapping audiences".
- **Ação (b):** Campanhas › editor › seletor de listas (catálogo `campanha_catalogo`).
- **Esperado (b) no V24:** catálogo indisponível com explicação; nenhum pedido de escrita.
- **Status (b):** **bloqueado por ativação** — rota `campaigns` não configurada no V24 e ponte READ gerenciada OFF. Código **preparado**: `growth-campaign-catalog-ui.test.cjs` › "confirmed catalogs update Public without extra requests, stay brand-bound and never invent list counts", "brand switching clears catalog and its Public rows…"; `ref214/tests/dashboard-operational-crm-managed-read-bridge.test.cjs` › "real SQLite managed principal reads campaign catalog, list, detail and media on both brands…".
- **Evidência:** print de cada marca + horário.

## P6. Públicos salvos

- **Pré-condição:** P1.
- **Ação:** abrir Público › públicos salvos / "Criar público" nas duas marcas.
- **Esperado no V24:** recurso aparece desligado/indisponível; **nenhum** pedido sai (ver Rede do navegador só para contar requisições, sem copiar cabeçalhos).
- **Evidência:** print + horário.
- **Status:** **bloqueado por ativação** — ponte de públicos ainda não admitida ("o GET atual pode atualizar o catálogo"), rota `segments` não configurada, escrita de público só no perfil `crm-sandbox`. Comportamento OFF **testado**: `growth-segment-ui.test.cjs` › "without capability segments stay OFF and issue no requests". Fluxo completo **preparado** (sintético): `growth-segment-v2-path.test.cjs` › "real v2 DOM → API → SQL: both brands save, reopen and count the persisted revision with current opt-out"; `ref214/tests/dashboard-operational-sandbox.test.cjs` › "capabilities permit only audience CRUD in the explicit synthetic contract".

## P7. Campanha só com listas (sem criar público salvo)

- **Pré-condição:** só quando o Codex liberar escrita **e** houver marca/lista/destinatário sintéticos (`synthetic.invalid` / `example.test`). Hoje: não executar a escrita.
- **Ação hoje (V24):** abrir Campanhas › Novo rascunho e verificar que salvar/conferir/agendar estão indisponíveis.
- **Ação quando liberado:** novo rascunho → escolher só listas sintéticas → salvar → conferir público. **Parar antes de agendar** (agendar/cancelar fora deste roteiro).
- **Esperado:** rascunho com ID vindo do recibo 201; conferência mostra listas, opt-out e contagem (desconhecido ≠ 0); zero confirmado bloqueia; nenhum público salvo criado.
- **Evidência:** print + ID sintético do rascunho + horário. Se incerto: print do aviso e do "Consultar tentativa"; não repetir.
- **Status:** **bloqueado por ativação** — flags de escrita OFF, falta identidade/perfil WRITER individual, imagem `crm-campaign` com filtro por marca (23e472ab) não instalada. **Preparado/testado em sintético**: `growth-campaign-ui.test.cjs` › "operators select named catalogs, save, validate and explicitly schedule the reviewed date", "zero and disabled audiences remain visible but cannot open scheduling"; `claude-campaign-schedule-ui.test.cjs` › "zero confirmado aparece como zero e bloqueia; contagem desconhecida nunca aparece como zero nem libera agenda"; `ref214/tests/dashboard-operational-campaign-create-http.test.cjs` › "OFF/default exposes no CREATE factory/table and rejects HTTP", "HTTP lost ACK after effect: public202, restart STATUS binds ID without a second POST"; `ref214/tests/dashboard-operational-campaign-submit.test.cjs` › "gate remains unavailable when OFF and rejects production, managed read and other write profiles".

## P8. Histórico

- **Ação (a):** Resultados/atividade de campanhas em cada marca, período e busca.
- **Esperado (a):** só campanhas da marca; datas em Brasília; progresso enviado/total; fonte indisponível não vira 0.
- **Status (a):** **testado** — `growth-campaign-monitor.test.cjs` › "ongoing, scheduled and paused campaigns are not hidden by the purchase period; history follows the send date in Brasilia", "summary never presents zero when the source is unavailable…", "search and pagination operate only on the selected brand…"; `claude-crm-freshness.test.cjs` › "aceite: exportação de campanhas sai igual à tela da marca selecionada…".
- **Ação (b):** histórico do editor (reabrir campanha antiga).
- **Status (b):** **bloqueado por ativação** — `campanha_listar/obter` passam pela rota `campaigns`/ponte READ, OFF no V24. Preparado: `claude-campaign-schedule-e2e.test.cjs` › "histórico do editor: campanha antiga fora do contrato não derruba a lista; marcas não se misturam"; `claude-campaign-schedule-ui.test.cjs` › "uma campanha antiga fora do contrato não impede carregar catálogo e histórico da marca…".
- **Evidência:** print por marca + horário.

## P9. Mídia

- **Ação:** Templates › biblioteca de imagens em cada marca.
- **Esperado no V24:** biblioteca oculta/indisponível; **sem upload** pelo portal (módulo só leitura).
- **Esperado quando liberado:** só arquivos da marca (nome canônico `crm-<marca>-…`) e arquivos antigos sem marca, estes marcados como legado e nunca contados como da marca; nenhuma imagem de outro host; página seguinte coerente.
- **Evidência:** print + horário.
- **Status:** **bloqueado por ativação** — rota `campaigns_media` (opt-in) não configurada; filtro por marca de `services/crm-campaign/media.cjs` depende da imagem de campanhas 23e472ab, não instalada; delta do validador estrito na ponte da #214 **preparado, não aplicado** (PARIDADE-LEITURA-PORTAL §9.3). Preparado: `ref214/services/dashboard-operational/media-read.test.cjs` › "media listing is hidden until explicitly advertised and loads metadata only on click", "pagination and brand changes never mix a stale response with the selected brand"; `ref214/tests/dashboard-operational-proxy.test.cjs` › "media library opt-in forwards only bounded JSON GET with the individual read key"; `claude-templates-media.test.cjs` › "biblioteca de uma marca não lista arquivos gerados para a outra marca"; `claude-media-read-validator.test.cjs` › "GET de mídia não tem efeito: uma autenticação STABLE, só GET /api/media, sem upload, sem mutex e sem estado", "resposta real do executor nas duas marcas: aceita, legado marcado e nunca contado como da marca", "resposta fora do contrato é recusada inteira: marca, URL, credencial, paginação e item". Sem upload: `ref214/services/dashboard-operational/build.test.cjs` › "operational CRM replaces the reviewed legacy media module with the read-only library".

## P9b. Biblioteca de templates (conteúdo publicado, histórico, submissão)

- **Ação:** Automações/Templates › "Carregar conteúdo" e "Carregar histórico" em cada marca; abrir a prévia de um template de e-mail.
- **Esperado no V24:** botões ausentes (sem `capabilities.templates` no perfil gerenciado); **nenhum** pedido ao n8n.
- **Esperado quando liberado:** só templates de e-mail registrados da marca selecionada; com "todas as marcas" a leitura é recusada; histórico/submissão de rascunho de outra marca = "não encontrado"; WhatsApp publicado e histórico por template publicado indisponíveis (sem marca derivável).
- **Evidência:** print por marca + horário.
- **Status:** **bloqueado por ativação** — handler n8n não versionado (`listar` sem marca obrigatória; `historico`/`submissao` sem marca) **não** é admitido; destino de leitura próprio **preparado** (contrato `crm-template-read-v1`, ponte e SQL somente leitura **não executado**), listener, host e deltas do BFF/front pendentes (PARIDADE-LEITURA-PORTAL §9.4–9.9). WhatsApp e histórico por `key`: **bloqueados** até existir metadado de marca. Preparado: `claude-template-read-store.test.cjs` › "listar: só e-mail registrado da marca pedida, nas duas marcas, paginado e aceito pela ponte; zero efeito", "histórico e submissão: marca do rascunho, outra marca vira "não encontrado", nada consulta o provedor", "principal individual com a capacidade da ação; chaves legadas, revogadas ou sem capacidade não leem"; `claude-template-read-bridge.test.cjs` › "sem marca, todas as marcas, WhatsApp, por key, escrita ou recuperação: recusado sem I/O", "item de outra marca ou sem marca, contrato errado, corpo grande, eco de segredo ou alegação de prova: 502"; `claude-template-read-pg16-postgres.cjs` (PG 16.15, duas sessões).

---

## O que este roteiro NÃO prova

- Dados de gestor por credencial individual (emissor READ V3, provisionamento gerenciado) — fica para depois da ativação.
- Qualquer escrita comercial real: criar/agendar/cancelar campanha, salvar público, upload de mídia, templates no n8n/Listmonk, entrega SES.
- Que o pacote/bundle do V24 contém exatamente os testes citados desta branch.
- Limite de tentativas por IP real na borda (Traefik) e recuperação administrativa de conta.
- Backup/restauração da identidade do V24 e custódia externa das chaves.
- Corte dos domínios finais (`crm.shrigma.com.br` etc.) e rollback.
- Concorrência em PostgreSQL real (provas sintéticas usam PGlite/SQLite).
- Testes "testado" provam comportamento em fixture sintética, não login humano nem dado real; o passo manual é o que dá essa prova.

## Resumo

| Passo | O que | Status |
|---|---|---|
| P0 | Conferir canário (digest/saúde) | testado (CI875); pacote↔V24 a confirmar pelo Codex |
| P1 | Login individual mestre | testado |
| P2 | Login gestor + escopo de área | testado |
| P2 | Gestor vendo dados do CRM | bloqueado por ativação (emissor READ V3, managed UI OFF) |
| P3 | Catálogo: frescor/idade | testado |
| P4 | Marca A→B→A | testado (bundle V24 a confirmar) |
| P5a | Listas (Público, via cache) | testado |
| P5b | Catálogo de listas no editor | bloqueado por ativação (rota `campaigns`/ponte READ) |
| P6 | Públicos salvos | bloqueado por ativação (ponte de públicos não admitida) |
| P7 | Campanha só com listas | bloqueado por ativação (escrita OFF, perfil WRITER, imagem crm-campaign) |
| P8a | Histórico em Resultados | testado |
| P8b | Histórico do editor | bloqueado por ativação (ponte READ) |
| P9 | Mídia | bloqueado por ativação (`campaigns_media`, imagem 23e472ab); validador estrito preparado |
| P9b | Biblioteca de templates | bloqueado por ativação (handler n8n não admitido; leitura própria preparada, não instalada); WhatsApp/histórico por key bloqueados (sem metadado de marca) |
| P10 | Revogação | testado (legado); gerenciado preparado |
| P11 | Expiração | testado (sessão/convite); gerenciado preparado |

Registro: data, executor, horário de início/fim, digest conferido em P0 e lista de prints. Nenhum dado de cliente ou credencial no registro.
