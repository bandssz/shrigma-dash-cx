# Roteiro de aceite do CRM no canário V24 — 03/10/2026

Atualizado em 03/10 (tarde): os status agora separam **preparado**, **testado em isolamento** e **validado no portal real** — ver § Status. Nenhum passo foi validado no portal real ainda.

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

## Status (três níveis, sem mistura)

Cada passo traz os três níveis separados. Um nível nunca implica o seguinte.

| Nível | Significa | Não significa |
|---|---|---|
| **Preparado** | O código existe e foi revisado. O passo diz **onde** (imagem V24 ou só numa PR draft) e **se está ligado ou desligado/não instalado** no V24. | Que funciona, que está no V24 (se o passo não disser), que foi testado. |
| **Testado em isolamento** | Um teste automatizado passou com dado **sintético**: fixture, PGlite/SQLite, ou PostgreSQL 16.15/17.10 **descartável** em loopback (arquivo › teste citado). | Login humano, dado real, nem que o bundle/imagem do V24 contém esse código. CI verde e deploy aceito também não contam aqui como validação. |
| **Validado no portal real** | Felipe ou o analista executou o passo **à mão no V24**, com evidência registrada (print + horário + digest de P0). | — |

**Hoje (03/10): nenhum passo está validado no portal real.** Onde a validação depende de ativação, o passo diz o que falta (`bloqueado: …`). Ativação, instalação SQL e entrada em produção exigem aprovação explícita de Felipe.

Prefixos: `ref214/` = testes da PR #214 (rodam na CI875); sem prefixo = `tests/` desta branch (#219); `ref220/` = testes da PR #220; `ref221/` = testes da PR #221. "PG17.10" = prova nativa descartável registrada em `docs/crm/PROVAS-NATIVAS-PG17-20261003.md` (da #219 ou da #220).

---

## P0. Conferir o canário antes de tudo

- **Pré-condição:** acesso de leitura ao Easypanel.
- **Ação:** abrir o serviço `web-access-v24-f58dfa73`, conferir digest e estado; abrir `/healthz` nos dois hosts.
- **Esperado:** digest `sha256:9d25e5d9…c669705`, 1 réplica, saudável; `/healthz` com `"ok":true`, `"runtimeUid":1000`, sem `synthetic`.
- **Evidência:** print do digest + horário.
- **Preparado:** sim — imagem V24 publicada no canário (sem domínio final).
- **Testado em isolamento:** sim (CI) — CI 37116055111 no `f58dfa7`; `ref214/tests/dashboard-operational-canary.test.cjs` › "operational canary binds every request to its user, area, slot and pinned upstream". Correspondência pacote↔V24: a confirmar pelo Codex.
- **Validado no portal real:** não — é este passo, à mão, que valida.

## P1. Login individual — conta mestre

- **Pré-condição:** conta mestre já ativa (copiada do V23). **Não redefinir senha.**
- **Ação:** entrar em `dashboard-v24-gerencial` com e-mail+senha; depois abrir `dashboard-v24-crm`. Abrir o host CRM numa janela anônima sem login.
- **Esperado:** login sem código de verificação; o CRM abre só com sessão; anônimo cai na tela de entrada; CX inexistente/negado.
- **Evidência:** print de cada tela + horário. Nada de cookie.
- **Preparado:** sim, ligado no V24.
- **Testado em isolamento:** sim — `ref214/tests/dashboard-operational-auth.test.cjs` › "an existing active admin with legacy TOTP data signs in with password after upgrade", "login rate limits, host binding, and absolute session expiry"; `ref214/tests/dashboard-operational-server.test.cjs` › "host routing, CX removal and isolated synthetic API enforcement".
- **Validado no portal real:** não — login humano real nunca foi feito no V24 (as 45 verificações foram anônimas).

## P2. Login individual — gestor (analista)

- **Pré-condição:** convite individual criado pela conta mestre para e-mail interno do analista, só área CRM, só leitura.
- **Ação:** analista abre o convite (canal privado), define senha, entra no host CRM; tenta abrir o host gerencial/orgânico/influs.
- **Esperado:** entra só no CRM; outras áreas negadas; convite não reutilizável.
- **Evidência:** print da lista de usuários (sem e-mail completo, pode cortar) + horário de ativação.
- **Preparado (login e escopo):** sim, ligado no V24.
- **Testado em isolamento (login e escopo):** sim — `ref214/tests/dashboard-operational-auth.test.cjs` › "invite, area grants, CSRF, encrypted per-slot bearers and revocation", "credential slots are fixed and scoped to their own area"; `ref214/tests/dashboard-operational-flow.test.cjs` › "complete isolated flow: password admin, invite, team scope, CSRF and revoke".
- **Validado no portal real:** não (login e escopo) — executar este passo.
- **Preparado (gestor ver dados do CRM):** sim, na imagem, **desligado** (emissor READ V3 não executado; provisionamento gerenciado e `DASHBOARD_CRM_MANAGED_READ_UI` OFF).
- **Testado em isolamento (gestor ver dados):** sim — `ref214/tests/dashboard-operational-managed-crm-http.test.cjs` › "HTTP admin creates two managed CRM accounts, verifies their private origin identities and revokes only one". Hoje o gestor deve ver a área vazia/indisponível, **nunca** dados com a credencial do mestre (`ref214/tests/dashboard-operational-auth.test.cjs` › "admin uses only a self-owned Growth reader for CRM while backend identity stays area-scoped").
- **Validado no portal real:** não (gestor ver dados) — bloqueado: emissor READ V3 + provisionamento gerenciado.

## P3. Catálogo: frescor e idade dos dados (mestre)

- **Pré-condição:** P1 ok; credencial `crm-panel-read` própria do mestre presente (se faltar, o painel recusa — anotar como bloqueio, não contornar).
- **Ação:** CRM › Início e Resultados em Fishermans; ler o cabeçalho de horário e a idade das contagens de Público.
- **Esperado:** horário em Brasília; retrato acima de 20 min aparece como "último retrato" com aviso (sem tela branca); contagem desconhecida ≠ 0; idade da contagem é a da coleta, não a da página.
- **Evidência:** print do cabeçalho/etiqueta de frescor + horário.
- **Preparado:** sim; o painel do V24 traz a entrega #216; as correções de frescor da #218 só entram no próximo bundle (a confirmar pelo Codex).
- **Testado em isolamento:** sim — `claude-crm-freshness.test.cjs` › "D3: falha de atualização mantém a leitura anterior…", "D4: primeira leitura com cache acima de 20 min mostra o último retrato…", "D4 (futuro)…", "D5: legenda do gráfico mostra a coleta de venda da marca selecionada…"; `growth-cache-read.test.cjs` › "a stale cache (older than 20 min) is refused"; `growth-audience.test.cjs` › "date-only snapshots retain their day in Brazil and show the age of the count, not the page refresh"; `ref214/tests/dashboard-operational-crm-cache-limit.test.cjs` › "a synthetic Growth cache just below eight MiB completes through the HTTP gateway". - **Validado no portal real:** não — dado real a validar neste passo.

## P4. Troca de marca A→B→A (Fishermans → O Aristocrata → Fishermans)

- **Pré-condição:** P3 carregado em Fishermans.
- **Ação:** trocar para O Aristocrata em Início, Resultados e Público; voltar para Fishermans. Repetir com uma leitura ainda carregando.
- **Esperado:** nenhum número, lista, alerta ou contador de uma marca aparece na outra; troca durante leitura pede para aguardar; voltar a Fishermans mostra os dados dela de novo.
- **Evidência:** 3 prints (A, B, A) com o seletor de marca visível + horário.
- **Preparado:** sim (entrega #216 no V24; duas abas `d9d85a1` e mídia `a19555c`: presença a confirmar pelo Codex).
- **Testado em isolamento:** sim — `claude-crm-two-brands.test.cjs` › "D3: contador de Público calculado em Fishermans não aparece em O Aristocrata…", "aceite: leitura de públicos de Fishermans em andamento segura a troca…", "aceite: tentativa incerta de campanha em Fishermans fica preservada ao alternar Fishermans → O Aristocrata → Fishermans, sem POST"; `claude-crm-freshness.test.cjs` › "D1: alerta de dados de Fishermans (Início) não permanece…", "aceite: atualizações concorrentes viram uma leitura; resposta que chega depois de trocar a marca é desenhada na marca atual"; `ref214/tests/dashboard-operational-campaign-create-ui.test.cjs` › "lost request/404 survives brand A-B-A close/reload…". Ressalva: os testes `claude-*` rodam no `growth.html` desta branch; presença das mesmas correções no bundle V24 a confirmar pelo Codex.
- **Validado no portal real:** não — executar este passo.

## P5. Listas

- **Pré-condição:** P3/P4 ok.
- **Ação (a):** Público › tabela de listas/audiências em cada marca: ordenar por tamanho, buscar.
- **Esperado (a):** só listas da marca; desconhecidos no fim, nunca 0; sem somar audiências sobrepostas.
- **Preparado (a):** sim, ligado no V24 (leitura por cache).
- **Testado em isolamento (a):** sim — `growth-audience.test.cjs` › "latest snapshot wins…; brands never join by ID alone", "size sorting uses confirmed counts, keeps unknowns last…", "read-only UI preserves the search/sort controls across refresh and brand change… never sums overlapping audiences".
- **Validado no portal real:** não (a) — executar este passo.
- **Ação (b):** Campanhas › editor › seletor de listas (catálogo `campanha_catalogo`).
- **Esperado (b) no V24:** catálogo indisponível com explicação; nenhum pedido de escrita.
- **Preparado (b):** sim, desligado — rota `campaigns` não configurada no V24 e ponte READ gerenciada OFF. Leitura própria de listas/públicos (`campanha_publico_obter`, `campanha_publico_contexto`, campanha só com listas sem público salvo) **só na #219**, flag `CRM_AUDIENCE_READ_ENABLED` OFF, SQL não executado.
- **Testado em isolamento (b):** sim — `claude-audience-read-store.test.cjs` › "campanha só-lista nas duas marcas, sem público salvo: vínculo nulo confirmado, listas nomeadas e zero efeitos"; `claude-audience-read-bridge.test.cjs` › "campanha só-lista nas duas marcas: GET fixo, credencial do principal, query canônica e corpo validado"; PG17.10 `claude-audience-read-pg16-postgres.cjs` (duas sessões, zero efeito, leitura sem esperar escritor); `growth-campaign-catalog-ui.test.cjs` › "confirmed catalogs update Public without extra requests, stay brand-bound and never invent list counts", "brand switching clears catalog and its Public rows…"; `ref214/tests/dashboard-operational-crm-managed-read-bridge.test.cjs` › "real SQLite managed principal reads campaign catalog, list, detail and media on both brands…".
- **Validado no portal real:** não (b) — bloqueado: rota `campaigns`/ponte READ e instalação da leitura da #219.
- **Evidência:** print de cada marca + horário.

## P6. Públicos salvos

- **Pré-condição:** P1.
- **Ação:** abrir Público › públicos salvos / "Criar público" nas duas marcas.
- **Esperado no V24:** recurso aparece desligado/indisponível; **nenhum** pedido sai (ver Rede do navegador só para contar requisições, sem copiar cabeçalhos).
- **Evidência:** print + horário.
- **Preparado:** sim, desligado — rota `segments` não configurada; o GET legado (que pode atualizar o catálogo) **não** é admitido; substituto somente leitura (`segmentos_listar`, `segmento_obter`, `publicos_listas`) **só na #219**, papel `crm_audience_reader`, SQL `n8n/growth/crm-audience-read-access.sql` não executado.
- **Testado em isolamento:** sim — OFF: `growth-segment-ui.test.cjs` › "without capability segments stay OFF and issue no requests"; leitura: `claude-audience-read-store.test.cjs` › "públicos salvos e vínculo nas duas marcas; catálogo velho é informado e nunca vira prova; legado bloqueia linhas", "papel de leitura sem escrita; READ ONLY recusa o catálogo legado; allowlist, papel e xid conferidos"; segredo codificado na resposta: `claude-read-bridge-secret-echo.test.cjs` (credencial escapada com `\uXXXX` em qualquer posição → 502, sem eco/log); PG17.10 `claude-audience-read-pg16-postgres.cjs` (`zero_effect`, revogação vista por outra sessão); fluxo de escrita sintético: `growth-segment-v2-path.test.cjs` › "real v2 DOM → API → SQL: both brands save, reopen and count the persisted revision with current opt-out"; `ref214/tests/dashboard-operational-sandbox.test.cjs` › "capabilities permit only audience CRUD in the explicit synthetic contract".
- **Validado no portal real:** não — bloqueado: admissão da leitura da #219 (instalação SQL + listener + host) com aprovação de Felipe.

## P7. Campanha só com listas (sem criar público salvo)

- **Pré-condição:** só quando o Codex liberar escrita **e** houver marca/lista/destinatário sintéticos (`synthetic.invalid` / `example.test`). Hoje: não executar a escrita.
- **Ação hoje (V24):** abrir Campanhas › Novo rascunho e verificar que salvar/conferir/agendar estão indisponíveis.
- **Ação quando liberado:** novo rascunho → escolher só listas sintéticas → salvar → conferir público. **Parar antes de agendar** (agendar/cancelar fora deste roteiro).
- **Esperado:** rascunho com ID vindo do recibo 201; conferência mostra listas, opt-out e contagem (desconhecido ≠ 0); zero confirmado bloqueia; nenhum público salvo criado.
- **Evidência:** print + ID sintético do rascunho + horário. Se incerto: print do aviso e do "Consultar tentativa"; não repetir.
- **Preparado:** sim, desligado — flags de escrita OFF, falta identidade/perfil WRITER individual, imagem `crm-campaign` com filtro por marca (23e472ab) não instalada.
- **Testado em isolamento:** sim — `growth-campaign-ui.test.cjs` › "operators select named catalogs, save, validate and explicitly schedule the reviewed date", "zero and disabled audiences remain visible but cannot open scheduling"; `claude-campaign-schedule-ui.test.cjs` › "zero confirmado aparece como zero e bloqueia; contagem desconhecida nunca aparece como zero nem libera agenda"; `ref214/tests/dashboard-operational-campaign-create-http.test.cjs` › "OFF/default exposes no CREATE factory/table and rejects HTTP", "HTTP lost ACK after effect: public202, restart STATUS binds ID without a second POST"; `ref214/tests/dashboard-operational-campaign-submit.test.cjs` › "gate remains unavailable when OFF and rejects production, managed read and other write profiles".
- **Validado no portal real:** não — bloqueado: escrita sintética liberada pelo Codex com aprovação de Felipe. Hoje só a parte "indisponível" pode ser validada.

## P8. Histórico

- **Ação (a):** Resultados/atividade de campanhas em cada marca, período e busca.
- **Esperado (a):** só campanhas da marca; datas em Brasília; progresso enviado/total; fonte indisponível não vira 0.
- **Preparado (a):** sim, ligado no V24 (cache).
- **Testado em isolamento (a):** sim — `growth-campaign-monitor.test.cjs` › "ongoing, scheduled and paused campaigns are not hidden by the purchase period; history follows the send date in Brasilia", "summary never presents zero when the source is unavailable…", "search and pagination operate only on the selected brand…"; `claude-crm-freshness.test.cjs` › "aceite: exportação de campanhas sai igual à tela da marca selecionada…".
- **Validado no portal real:** não (a) — executar este passo.
- **Ação (b):** histórico do editor (reabrir campanha antiga).
- **Preparado (b):** sim, desligado — `campanha_listar/obter` passam pela rota `campaigns`/ponte READ, OFF no V24.
- **Testado em isolamento (b):** sim — `claude-campaign-schedule-e2e.test.cjs` › "histórico do editor: campanha antiga fora do contrato não derruba a lista; marcas não se misturam"; `claude-campaign-schedule-ui.test.cjs` › "uma campanha antiga fora do contrato não impede carregar catálogo e histórico da marca…".
- **Validado no portal real:** não (b) — bloqueado: rota `campaigns`/ponte READ.
- **Evidência:** print por marca + horário.

## P9. Mídia

- **Ação:** Templates › biblioteca de imagens em cada marca.
- **Esperado no V24:** biblioteca oculta/indisponível; **sem upload** pelo portal (módulo só leitura).
- **Esperado quando liberado:** só arquivos da marca (nome canônico `crm-<marca>-…`) e arquivos antigos sem marca, estes marcados como legado e nunca contados como da marca; nenhuma imagem de outro host; página seguinte coerente.
- **Evidência:** print + horário.
- **Preparado:** sim, desligado — rota `campaigns_media` (opt-in) não configurada; filtro por marca de `services/crm-campaign/media.cjs` depende da imagem de campanhas 23e472ab, não instalada; validador estrito (`crm-media-read-validator.cjs`, **só na #219**) não aplicado na ponte da #214 (PARIDADE-LEITURA-PORTAL §9.3).
- **Testado em isolamento:** sim — miniatura de outra marca: `claude-media-read-thumb-brand.test.cjs` › "item canônico com miniatura de outra marca recusa a página: fish→aristo e aristo→fish (e olivas)", "item canônico com miniatura legada (sem marca) recusa a página; o legado não vira da marca", "item legado com miniatura de outra marca sai da lista nas duas direções…"; `ref214/services/dashboard-operational/media-read.test.cjs` › "media listing is hidden until explicitly advertised and loads metadata only on click", "pagination and brand changes never mix a stale response with the selected brand"; `ref214/tests/dashboard-operational-proxy.test.cjs` › "media library opt-in forwards only bounded JSON GET with the individual read key"; `claude-templates-media.test.cjs` › "biblioteca de uma marca não lista arquivos gerados para a outra marca"; `claude-media-read-validator.test.cjs` › "GET de mídia não tem efeito: uma autenticação STABLE, só GET /api/media, sem upload, sem mutex e sem estado", "resposta real do executor nas duas marcas: aceita, legado marcado e nunca contado como da marca", "resposta fora do contrato é recusada inteira: marca, URL, credencial, paginação e item". Sem upload: `ref214/services/dashboard-operational/build.test.cjs` › "operational CRM replaces the reviewed legacy media module with the read-only library".
- **Validado no portal real:** não — bloqueado: `campaigns_media` + imagem 23e472ab + validador estrito na ponte.

## P9b. Biblioteca de templates (conteúdo publicado, histórico, submissão)

- **Ação:** Automações/Templates › "Carregar conteúdo" e "Carregar histórico" em cada marca; abrir a prévia de um template de e-mail.
- **Esperado no V24:** botões ausentes (sem `capabilities.templates` no perfil gerenciado); **nenhum** pedido ao n8n.
- **Esperado quando liberado:** só templates de e-mail registrados da marca selecionada; com "todas as marcas" a leitura é recusada; histórico/submissão de rascunho de outra marca = "não encontrado"; WhatsApp publicado e histórico por template publicado indisponíveis (sem marca derivável).
- **Evidência:** print por marca + horário.
- **Preparado:** sim, desligado — handler n8n não versionado (`listar` sem marca obrigatória; `historico`/`submissao` sem marca) **não** é admitido; leitura própria (contrato `crm-template-read-v1`, ponte, SQL somente leitura **não executado**) **só na #219**; front por marca atrás de `capabilities.templates.read_contract` **só na #221**; listener, host e delta do BFF pendentes (PARIDADE-LEITURA-PORTAL §9.4–9.9). WhatsApp e histórico por `key`: sem metadado de marca, ficam fora.
- **Testado em isolamento:** sim — `claude-template-read-store.test.cjs` › "listar: só e-mail registrado da marca pedida, nas duas marcas, paginado e aceito pela ponte; zero efeito", "histórico e submissão: marca do rascunho, outra marca vira "não encontrado", nada consulta o provedor", "principal individual com a capacidade da ação; chaves legadas, revogadas ou sem capacidade não leem"; `claude-template-read-bridge.test.cjs` › "sem marca, todas as marcas, WhatsApp, por key, escrita ou recuperação: recusado sem I/O", "item de outra marca ou sem marca, contrato errado, corpo grande, eco de segredo ou alegação de prova: 502"; `claude-read-bridge-secret-echo.test.cjs` (credencial escapada → 502); `ref221/tests/claude-front-read-brand.test.cjs`; `claude-template-read-pg16-postgres.cjs` em PG 16.15 e PG17.10 (duas sessões, `zero_effect`, revogação vista por outra sessão).
- **Validado no portal real:** não — bloqueado: admissão da leitura da #219 + #221 + delta do BFF, com aprovação de Felipe.

---

## P10. Revogação

- **Pré-condição:** P2 concluído com a conta do analista.
- **Ação:** conta mestre revoga o acesso CRM do analista; analista recarrega o CRM na sessão já aberta.
- **Esperado:** a sessão revogada perde o acesso na próxima requisição; a conta mestre continua; nenhum dado aparece depois da revogação.
- **Evidência:** print antes/depois + horário.
- **Preparado:** sim, ligado no V24 (contas legadas); revogação de conta gerenciada na imagem, **desligada**.
- **Testado em isolamento:** sim — `ref214/tests/dashboard-operational-auth.test.cjs` › "invite, area grants, CSRF, encrypted per-slot bearers and revocation"; `ref214/tests/dashboard-operational-flow.test.cjs` › "complete isolated flow: password admin, invite, team scope, CSRF and revoke"; gerenciada: `ref214/tests/dashboard-operational-managed-crm-http.test.cjs` › "HTTP admin creates two managed CRM accounts, verifies their private origin identities and revokes only one"; leitura própria da #219: `claude-audience-read-store.test.cjs` › "principal revogado, expirado, sem capacidade ou trocado no meio: recusa sem dado…" e PG17.10 (revogação vista por outra sessão).
- **Validado no portal real:** não — executar este passo (legado); gerenciada bloqueada pelo provisionamento gerenciado.

## P11. Expiração

- **Ação:** deixar a sessão do analista ociosa além do limite configurado (ou usar convite já usado/vencido).
- **Esperado:** sessão expirada volta para a tela de entrada; convite usado ou vencido não abre conta.
- **Evidência:** print + horário.
- **Preparado:** sim, ligado no V24 (sessão e convite); expiração de principal gerenciado na imagem, desligada.
- **Testado em isolamento:** sim — `ref214/tests/dashboard-operational-auth.test.cjs` › "login rate limits, host binding, and absolute session expiry"; principal expirado na leitura própria: `claude-audience-read-store.test.cjs` (mesmo teste de P10).
- **Validado no portal real:** não — executar este passo.

## P12. Tentativa incerta de agendar/cancelar (recuperação pendente, PR #220)

- **Ação hoje (V24):** nenhuma. Não existe botão "Encerrar tentativa sem efeito" no V24, e **não se cria tentativa incerta de propósito** para testar.
- **Esperado quando liberado (só com campanha sintética):** tentativa `pending` com lease vencido ou chave sem registro pode ser encerrada com lápide; um POST atrasado depois da lápide é recusado; repetir o encerramento não duplica; tempo decorrido ou 404 **não** contam como prova de ausência.
- **Preparado:** sim, desligado e **fora do V24** — **só na #220**: `n8n/growth/campaign-pending-recovery.sql` e `crm-campaign-abandon-gateway.sql` (não executados; instalador confere md5/owner/SECURITY/search_path/ACL das dependências antes de qualquer DDL e recusa gatilho/função alheios), gate `CRM_CAMPAIGN_ABANDON_ENABLED` OFF, botão atrás de capability. Reversão e inventário: `docs/crm/RECUPERACAO-TENTATIVAS-PENDENTES-20261003.md`.
- **Testado em isolamento:** sim — `ref220/tests/claude-pending-recovery.test.cjs`, `ref220/tests/claude-pending-recovery-postgres.cjs` (PGlite); PG16.15 e PG17.10 com duas sessões: `ref220/tests/claude-pending-recovery-pg16-postgres.cjs` 5/5 (lápide × POST atrasado, lápide × efeito tardio, efeito em andamento segura o lock, duplo encerramento grava um só registro), `ref220/tests/claude-pending-recovery-install-pg16-postgres.cjs` 1/1 (6 blocos: provider sem recibo atômico, dependência divergente, gatilho alheio, reinstalação no-op, wrapper do gateway, reversão sem apagar leases/recibos); regressão em PG17.10: `crm-campaign-gateway-postgres.cjs`, `segment-campaign-binding-postgres.cjs`, `segment-campaign-binding-release-postgres.cjs` — `sends:0`.
- **Validado no portal real:** não — bloqueado: instalação SQL, gate e perfil WRITER, com aprovação explícita de Felipe.

## O que este roteiro NÃO prova

- Dados de gestor por credencial individual (emissor READ V3, provisionamento gerenciado) — fica para depois da ativação.
- Qualquer escrita comercial real: criar/agendar/cancelar campanha, salvar público, upload de mídia, templates no n8n/Listmonk, entrega SES.
- Que o pacote/bundle do V24 contém exatamente os testes citados desta branch.
- Limite de tentativas por IP real na borda (Traefik) e recuperação administrativa de conta.
- Backup/restauração da identidade do V24 e custódia externa das chaves.
- Corte dos domínios finais (`crm.shrigma.com.br` etc.) e rollback.
- Concorrência no banco real do V24/produção. Duas sessões foram provadas **só** em clusters PostgreSQL 16.15/17.10 descartáveis (leitura de públicos/templates da #219; recuperação pendente e regressões da #220); as demais provas sintéticas usam PGlite/SQLite.
- Nada das PRs #219, #220 e #221 está no V24: lá elas contam só como **preparado** + **testado em isolamento**.
- Testes "testado em isolamento" provam comportamento em fixture sintética, não login humano nem dado real; o passo manual é o que dá essa prova.

## Resumo

Nenhum passo validado no portal real até 03/10. "Executável" = pode ser validado no V24 hoje, à mão.

| Passo | O que | Preparado | Testado em isolamento | Validado no portal real | Para validar falta |
|---|---|---|---|---|---|
| P0 | Canário (digest/saúde) | sim, V24 | sim (CI875) | não | executável; pacote↔V24 a confirmar pelo Codex |
| P1 | Login individual mestre | sim, ligado | sim | não | executável |
| P2 | Login gestor + escopo de área | sim, ligado | sim | não | executável |
| P2 | Gestor vendo dados do CRM | sim, OFF | sim | não | emissor READ V3 + provisionamento gerenciado |
| P3 | Frescor/idade | sim (#216 no V24; #218 no próximo bundle) | sim | não | executável (correções da #218 só após novo bundle) |
| P4 | Marca A→B→A | sim (bundle V24 a confirmar) | sim | não | executável |
| P5a | Listas (Público, cache) | sim, ligado | sim | não | executável |
| P5b | Catálogo de listas / campanha só com listas (leitura) | sim, OFF (#219 fora do V24) | sim (PGlite + PG17.10) | não | rota `campaigns`/ponte READ + instalação da leitura #219 |
| P6 | Públicos salvos | sim, OFF (#219 fora do V24) | sim (PGlite + PG17.10, eco de segredo) | não | admissão da leitura #219 |
| P7 | Campanha só com listas (escrita) | sim, OFF | sim | não | escrita sintética + WRITER + imagem 23e472ab |
| P8a | Histórico em Resultados | sim, ligado | sim | não | executável |
| P8b | Histórico do editor | sim, OFF | sim | não | rota `campaigns`/ponte READ |
| P9 | Mídia | sim, OFF (validador #219 fora do V24) | sim (inclui miniatura de outra marca) | não | `campaigns_media` + 23e472ab + validador na ponte |
| P9b | Biblioteca de templates | sim, OFF (#219/#221 fora do V24) | sim (PGlite + PG16.15/17.10) | não | admissão #219 + #221 + delta do BFF; WhatsApp/histórico por key fora |
| P10 | Revogação | sim (legado ligado; gerenciado OFF) | sim | não | executável (legado) |
| P11 | Expiração | sim (legado ligado; gerenciado OFF) | sim | não | executável |
| P12 | Tentativa incerta / lápide | sim, OFF (#220 fora do V24) | sim (PGlite + PG16.15/17.10, duas sessões) | não | instalação SQL + gate + WRITER, com aprovação de Felipe |

Registro: data, executor, horário de início/fim, digest conferido em P0 e lista de prints. Nenhum dado de cliente ou credencial no registro.
