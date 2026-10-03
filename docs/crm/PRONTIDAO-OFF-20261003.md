# Prontidão da trilha OFF do CRM — 03/10/2026

Escopo: item 4 do ACEITE — A/B operacional, RFM (sete perfis), conversão por comprador único e execução dos fluxos novos. Base: `main` 725dbe3 (sem a PR #211). Fonte: **código e testes** desta cópia. Nada foi ligado; nenhum gate, flag, default, emissor, coletor, worker, instalador ou workflow de imagem foi alterado.

Legenda de tamanho: **P** até ~1 dia · **M** 2–4 dias · **G** 1 semana ou mais. "Prod" = depende de Codex/Felipe (instalação, credencial, imagem, banco real, decisão).

## Estado na build atual (provado em `tests/claude-crm-off-track.test.cjs`)

| Recurso | Gate no código | Como aparece no painel hoje |
|---|---|---|
| A/B operacional | `GABExperimentPanel.ACTIVATION={enabled:false}`; `CRM_AUDIENCE_AB_ENABLED` default `false`; `ab-audience-*.cjs ENABLED=false` | Aba "Testes A/B" mostra "Teste com campanhas salvas · desligado nesta versão"; painel operacional oculto; cadastro legado "Somente configuração" |
| RFM (7 perfis) | `segment-audience-contract.js ENABLED=false`; `createWorker()` sem `rfmRevision` → `CRM_SHOPIFY_RFM_DISABLED`; produtor não ligado em `services/crm-shopify-sync/main.cjs` | Só retrato de análise; botão "Disponível apenas para análise" desabilitado nas duas marcas |
| Conversão por comprador único | `capture_control_v1.enabled DEFAULT false` e `buyer_read_control_v1.enabled DEFAULT false` (SQL candidatos, não instalados); sem API/UI | Nenhuma métrica de compradores; "Pedidos por 100 envios" e "ped./1000 envios" dizem que não medem pessoas compradoras |
| Fluxos novos | `journey-graph-*.cjs ENABLED=false`; `CRM_FLOWS_ENABLED` default `false`; aba "Construir fluxo" só com capacidade `journey_graph_draft_api_v1` | Aba oculta; introdução diz "Construir fluxo está desligado nesta versão"; Jornadas "Somente leitura" |

## 1. A/B operacional

**Existe:** cliente/UI/contrato no painel (`growth-ab-experiment-{contract,client,ui,panel}.js`), SQL `ab-experiment-{core,selection,coordinator,api}.sql`, preparação/revisão/admissão com público salvo (`ab-audience-{prepare,review,admission-*,material*,regular-admission}.*`), patch Listmonk (`ab-listmonk-cohort-patch.cjs`), cadastro legado (`growth-ab-{form,server,journal,protocol}.js`, `ab-registry.*`).

| Critério | Prova sintética (arquivo › teste) |
|---|---|
| Duas variantes sem sobreposição | `ab-experiment-core` › "database freezes deduplicated disjoint cohort, exact half split…"; `ab-audience-prepare-schema` › "deferred whole-cohort proof…" |
| Mesmo público salvo nos dois braços | `ab-audience-prepare` › "both arms must bind the same audience…"; "minimum uses the filtered audience…" |
| Sem envio duplicado | `ab-audience-regular-admission` › "lost commit acknowledgement… without a second schedule"; `ab-experiment-client` › "one POST, no stored keys" |
| Prazo | `ab-audience-admission-inspect` › "less than fifteen minutes are not a common schedule", "expiry during read…"; `ab-experiment-coordinator` › "expired review…" |
| Concorrência | `growth-ab-journal` › "Web Locks serialize competing tabs"; `ab-experiment-concurrency-postgres.cjs` (**não executado aqui**: exige PostgreSQL real) |
| Opt-out | `ab-experiment-coordinator` › "optout changed after review blocks schedule…"; `ab-audience-review` › "revoked and missing subscribers remain exclusions…" |
| Resultado incerto | `ab-experiment-client` › "lost response remains durable…"; `ab-audience-panel-path` › "lost schedule receipt survives reload…"; `ab-experiment-workflow` › "…generic uncertainty" |
| Resultado sem vencedor falso | `ab-experiment-contract` › "immature, tied, underpowered… stay inconclusive", "finished but unaccounted transport is inconclusive" |
| Transporte falso fim a fim | **sem prova**: nenhum teste leva um braço agendado até um transporte sintético e mede o resultado |

**Falta (ordem):**
1. Prova fim a fim com transporte sintético: preparar → revisar → agendar → enviar os dois braços por transporte falso → medir, nas duas marcas — **M**.
2. Executar as provas nativas `ab-audience-*-postgres.cjs`, `ab-experiment-concurrency-postgres.cjs`, `ab-listmonk-count-proof.cjs`, `ab-listmonk-upstream-proof.cjs` com PostgreSQL real e `AB_UPSTREAM_SOURCE` fixado — **P** (Prod/CI).
3. Capacidade `ab_experiment` publicada pelo servidor + endpoint https — **P** (Prod).
4. Imagem Listmonk com o patch de coorte e instalação SQL — **G** (Prod).

`tests/ab-audience-v2-scope.test.cjs` continua como prova negativa do core antigo (aloca a base antes do público v2); o caminho `ab-audience-prepare` é o que usa o público filtrado. O core antigo não pode ser ligado sozinho.

## 2. RFM (sete perfis)

**Existe:** algoritmo e evidência (`segment-shopify-rfm.cjs`, `segment-shopify-rfm-evidence.cjs`, consulta `segment-shopify-rfm-paid-orders-bulk.graphql`), SQL (`segment-shopify-rfm.sql`: `rfm_ingest_snapshot`, `rfm_catalog`, `rfm_match`, `rfm_selection_match`, `rfm_count_for_rule`, `rfm_native_*`), consumidor de arquivos no worker (`services/crm-shopify-sync/worker.cjs › parseRfm`, OFF), painel (`growth-audience.js` cartões; `growth-segment-ui.js › startPreset`).

| Critério | Prova sintética |
|---|---|
| Produtor pareado Customer→Paid Orders | `segment-shopify-rfm` › "provenance requires two different completed Bulks…"; `segment-shopify-rfm-evidence` › "R/F/M use the same GID-linked paid export…". **Orquestração no runtime: sem prova** (não ligada em `main.cjs`; candidata na PR #211) |
| Histórico completo | `segment-shopify-rfm-evidence` › "history and exact query pins refuse a sixty-day export…" |
| Fonte vigente nas duas marcas | `segment-shopify-rfm-selection` › "RFM count and native regular selection agree for both brands and preserve opt-out"; `segment-shopify-rfm-postgres` (PGlite) |
| Mutex/journal do produtor | **sem prova nesta cópia** (ingestão tem `FOR UPDATE` na fonte; journal de execução do produtor está na PR #211) |
| Catálogo → editor → contar → seleção | `growth-rfm-panel-path` › "versioned RFM card opens…"; `growth-rfm-preset-context` › "rechecks brand, key and endpoint…"; `segment-shopify-rfm` › "catalog readiness binds field and snapshot…" |
| Desconhecido nunca vira zero | `segment-shopify-rfm` › "missing, duplicate and future customer evidence is rejected…"; `segment-shopify-rfm-selection` › "missing identity and expired batch stay unknown…" |

**Falta (ordem):**
1. Revisar/mesclar a PR #211 (produtor selado, instalação OFF) — não reimplementado aqui — **M** (Codex).
2. Prova nativa `segment-shopify-rfm-native-postgres.cjs` e `segment-shopify-rfm-producer-native-postgres.cjs` com PostgreSQL real — **P** (CI).
3. Instalar SQL RFM e ligar `rfmRevision` no serviço para as duas lojas; primeira sincronização com evidência — **M** (Prod).
4. Publicar `rfm_snapshot` no catálogo do serviço de públicos — **P** (Prod).

## 3. Conversão por comprador único

**Existe:** captura de identidade do envio aceito (`recipient-conversion-evidence.sql`), compilador de instalação (`recipient-conversion-install.cjs`) e, desde 03/10, a **função de leitura candidata** `recipient-buyer-conversion.sql` (OFF, não instalada em lugar nenhum, só provada em PGlite). Não há API nem tela.

### Contrato `crm_email_conversion_candidate.buyer_conversion_v1(b text, cid integer, window_days integer DEFAULT 7) → jsonb`

- **Instalação:** depois de `recipient-conversion-evidence.sql`, como `postgres`, com marcador `shrigma.buyer_conversion.install_guard` (64 hex) na sessão. Sem marcador, sem a captura v1, com captura alterada (md5 de `claim_hash_v1` e `accepted_coverage_v1`), sem `crm_attribution_order_v2`/`crm_attribution_coverage_v2` ou já instalada → `BUYER_CONVERSION_INSTALL_GUARD`/`BUYER_CONVERSION_DEPENDENCY_DRIFT` e rollback.
- **Gate:** `buyer_read_control_v1(brand, enabled DEFAULT false)`, linhas `fish` e `aristo` desligadas. Desligado → `available:false`, `reason:'buyer_read_disabled'`, todos os números `null`. A instalação revoga privilégios default e falha (`BUYER_CONVERSION_AFTER_DRIFT`) se o gate vier ligado ou se um papel comum (ex.: `crm_audience_api`, `crm_panel_reader`) puder executar a função ou ler o gate.
- **Papel:** só o dono (`SECURITY DEFINER`, `STABLE`, `search_path=pg_catalog`). Nenhum papel de API recebe acesso.
- **Entrada:** `b` ∈ {`fish`,`aristo`}; `cid` = campanha regular de público salvo da mesma marca; `window_days` inteiro 1–14 (fora disso → `BUYER_CONVERSION_WINDOW_INVALID`).
- **Escopo:** campanha inexistente, de outra marca ou com braço A/B (`crm_ab_arm_v2`) → `available:false`, `reason:'campaign_scope_unavailable'`, números `null` (mesma regra de `accepted_coverage_v1`).
- **Unidade:** pessoas (`recipient_key` do envio aceito), nunca pedidos. Uma pessoa conta uma vez por campanha, com N pedidos.
- **Janela:** por pessoa, `[accepted_at, accepted_at + window_days)` — início inclusivo, fim exclusivo, padrão 7 dias, máximo 14. Pedido antes do envio aceito não conta.
- **Pedido que conta:** linha de `crm_attribution_order_v2` da **mesma marca**, `payload.eligible = true` (pago/parcialmente reembolsado, BRL, não teste, não cancelado — regra do coletor `attribution.js`), `customer_identity_state = confirmed` e `customer_gid` igual ao GID **capturado e imutável** no envio. Leitura do estado atual dos pedidos coletados (cancelamento posterior tira o comprador).
- **Opt-out:** regra do claim nativo — quem já saiu antes do envio não é reivindicado e não entra no denominador; sair depois do envio aceito não tira a pessoa.
- **Estado de cada pessoa (nesta ordem):** `identity_unknown` (sem captura confirmada: captura OFF, antes de `coverage_started_at`, não resolvida, divergente ou hash alterado) → `window_open` (agora < fim da janela) → `orders_unavailable` (algum dia de São Paulo da janela sem coleta completa em `crm_attribution_coverage_v2` até o fim da janela, ou pedido elegível na janela coletado sem o campo de identidade) → `measured`.

| Campo | Significado | Unidade |
|---|---|---|
| `contract`, `brand`, `campaign_id`, `unit:'people'`, `window{anchor,days,max_days,start,end}`, `as_of`, `authorizes_send:false` | identificação | — |
| `available`, `reason` | leitura liberada ou motivo | — |
| `accepted_people` | pessoas com envio aceito (igual a `accepted_coverage_v1.accepted_people`) | pessoas |
| `identity_mapped_people` / `identity_unknown_people` | com/sem identidade capturada | pessoas |
| `window_open_people` | mapeadas com janela aberta | pessoas |
| `orders_unavailable_people` | mapeadas, janela fechada, pedidos sem cobertura | pessoas |
| `measured_people` | mapeadas, janela fechada, pedidos cobertos | pessoas |
| `buyers` / `non_buyers` | entre as medidas; `null` se `measured_people = 0` | pessoas |
| `buyer_rate` | `buyers ÷ measured_people` (0–1, 6 casas); `null` se nada medido | fração |
| `identity_coverage` | `identity_mapped_people ÷ accepted_people` | fração |
| `measured_share` | `measured_people ÷ accepted_people` | fração |
| `orders_without_customer` | pedidos elegíveis sem cliente (checkout sem conta/ID inválido) dentro de janelas medidas | pedidos |
| `buyers_lower_bound` | `true` se `orders_without_customer > 0`: `buyers` é piso | — |

Zero medido = `measured_people > 0` e `buyers = 0`. Desconhecido = `buyers = null`. `buyer_rate` nunca é pedidos/100 envios: o denominador são pessoas medidas, não envios.

| Critério | Prova sintética (arquivo › teste) |
|---|---|
| Envio aceito → identidade imutável | `recipient-conversion-evidence` › "enabled ready source captures confirmed identity and keeps it immutable…" |
| Default OFF, sem retroativo | `recipient-conversion-evidence` › "capture defaults OFF…"; `recipient-conversion-install` (3 testes); `claude-buyer-conversion-postgres` › "install is guarded and OFF…" (marcador, versão, privilégio default, gate desligado nas duas marcas) |
| Captura real → leitura nas duas marcas; janela aberta fica desconhecida | `claude-buyer-conversion-postgres` › "install is guarded and OFF; real capture in both brands…" |
| Opt-out antes do envio fora; depois do envio não reduz denominador | idem (claim `ineligible` + resultado igual após descadastro) |
| Janela dentro/fora/limite, início inclusivo, fim exclusivo, janela de 3 dias | `claude-buyer-conversion-postgres` › "both brands: window limits, dedupe…" |
| Deduplicação (2 pedidos = 1 comprador; pedidos ≠ compradores) | idem |
| Pedido de outra marca não conta; pedido antes do envio não conta; pedido não pago não conta | idem |
| Desconhecido ≠ zero (sem coleta, coleta parcial, pedido sem campo de identidade, janela aberta) | idem + teste de captura real |
| Cobertura parcial (`identity_coverage`, `measured_share`) | idem |
| A/B excluído; gate desligado volta a `null` | idem; `recipient-conversion-evidence` › "an A/B assignment excludes…" |
| API/UI | **sem implementação** (fora desta etapa) |
| Não confundir pedidos/100 envios com taxa de compradores | `claude-crm-off-track` › "OFF-3…" e "aceite…"; contrato acima |

**O que a captura/coleta existente não garante (não inventado; fica `null` ou ressalvado):**
- Pedidos coletados antes da publicação do coletor com `customer{id}` não têm `customer_identity_state` → janelas que os contêm ficam `orders_unavailable`. Medição só começa depois da publicação nas duas marcas **e** de `coverage_started_at` da captura.
- Checkout sem cliente (`absent`/`invalid`) não liga a pessoa → `buyers_lower_bound`.
- `crm_attribution_coverage_v2` marca dias pelo intervalo informado ao ingest (também no modo `updated`); a função herda a mesma leitura por dia de criação usada em `crm_attribution_order_model_v2`. Confirmar em Prod que a coleta diária cobre dias de criação completos.
- Supõe pedidos e envios no mesmo banco (`listmonk`), como as views de atribuição atuais que juntam `public.campaigns`. Se Prod separar os bancos, falta a ponte versionada citada em `recipient-conversion-evidence.md`; a guarda recusa a instalação sem as tabelas.
- Fora de escopo da captura: campanhas de lista simples (legado), transacionais, Olivas, A/B.
- Desempenho: varre os pedidos da marca no intervalo das janelas (sem índice por `created_at` no payload); prova de plano com volume real não feita.

**Falta (ordem):**
1. Prova nativa em PostgreSQL 17 real de `recipient-buyer-conversion.sql` (instalação guardada, ACL, plano com volume) — **P** (CI/Prod).
2. Leitura no `crm-panel-read`: hoje só aceita `action=identity|cache_growth` com dois parâmetros e o papel `crm_panel_reader` não executa a função. Criar ação nova (ex.: `buyers` + `campaign_id`) no despachante `shrigma_crm_read_fast_v1`, de preferência lendo um cache por campanha atualizado pelo dono (padrão `crm_attribution_dispatch_cache_v3`), sem expor `recipient_key`/GID — **M**.
3. Tela: coluna "Compradores ÷ pessoas medidas" com `identity_coverage`/`measured_share` visíveis como etiqueta no cabeçalho, `null` como "sem dado" (nunca 0), "piso" quando `buyers_lower_bound`; separada de "Pedidos por 100 envios" (`growth-attribution.js`, recompilar bundle) — **M**.
4. Prod: instalar captura (`recipient-conversion-install.cjs`) e depois esta função; ligar `capture_control_v1` por marca (sem retroativo); publicar coletor com `customer{id}`; ligar `buyer_read_control_v1` por marca só após a primeira janela fechada e coberta (≥ 7 dias depois de `coverage_started_at`) — **P** (Prod).

## 4. Execução dos fluxos novos

**Existe:** contrato/editor/rascunho (`journey-graph-contract.js`, `growth-journey-graph-*.js`, `journey-graph-draft-api.cjs`), ciclo de vida (`journey-graph-lifecycle-*.cjs`), runtime e executor (`journey-graph-runtime.cjs`, `journey-graph-worker.cjs`, `-delivery`, `-message`, `-cart`, `-source`, `-purchase`), serviço `services/crm-flows` (OFF). Escopo único: `cart_first_email_v1` (carrinho, primeiro e-mail).

| Critério | Prova sintética |
|---|---|
| Executor | `journey-graph-worker` › "Node worker closes existing Fish and Aristo intents through original claim, synthetic transport and durable receipt" |
| Entrada natural | `journey-graph-source` › "captures exact cart event once…"; `journey-cart-scanner` › "capture reconciles sequentially…"; `journey-graph-cart-admission` |
| Prazo | `journey-graph-runtime` › "deterministic waits and purchased exit survive…", "expiry remains absolute after restart" |
| Saída | `journey-graph-runtime` › "…purchased exit…"; `journey-graph-purchase` (10 testes) |
| Opt-out | `journey-graph-source` › "blocklist, brand opt-out…"; `journey-graph-message` › "optout during native resolution…"; `journey-graph-runtime` › "fresh withdrawal or suppression stops before intent…" |
| Deduplicação/concorrência | `journey-graph-worker` › "same-brand tick is single-flight…"; `journey-graph-cart` › "…one durable dispatch"; `journey-graph-concurrency-postgres.cjs` (**não executado**: PostgreSQL real) |
| Recibos | `journey-graph-worker` › "receipt identity is deterministic across restart and lost COMMIT…"; `journey-graph-dispatch-receipt` |
| Fim a fim com transporte de teste | `journey-graph-delivery-integration` › "source, pinned clone, original reservation, transport result and graph receipt integrate in both brands" |

**Falta (ordem):**
1. Provas nativas `journey-graph-*-postgres.cjs` (20 arquivos) com PostgreSQL real — **P** (CI).
2. Instalação dos SQL candidatos, papel `crm_graph_worker`, imagem `crm-flows` e capacidade `journey_graph_draft_api_v1`/`graph_lifecycle` — **G** (Prod).
3. Publicação pausada → ativação com clone nativo confirmado (`journey-graph-activation-readiness`) — **M** (Prod).
4. Outros gatilhos/canais além de carrinho/primeiro e-mail — **G** (fora do escopo atual).

## Defeitos corrigidos nesta entrega (sem ligar nada)

| Id | Onde | Problema | Correção |
|---|---|---|---|
| OFF-1 | `growth.html` aba Testes A/B | Com A/B desligado, a aba mostrava "Executar teste com campanhas salvas" e as instruções de execução | Instrução só aparece com o painel montado; senão "desligado nesta versão… Nada é dividido, agendado ou enviado por aqui" |
| OFF-2 | `growth.html` Automações e Início | Introdução e cartão citavam "Construir fluxo"/"construção" com a aba oculta | Texto segue a mesma disponibilidade da aba; Início diz "Jornadas e histórico de envios" |
| OFF-3 | `growth.html` Campanhas × Automações | "ped./1000 envios" sem ressalva, legível como taxa de compradores | Etiqueta no cabeçalho "não é taxa de compradores", detalhe no `title` |
| OFF-4 | `growth-audience.js` cartões RFM | Em "Todas as marcas" com fonte pronta, "Usar este perfil" ficava habilitado e o clique não fazia nada | Botão só habilita na marca do perfil; senão "Selecione a marca para usar este perfil" |

Observações para o integrador: `growth-audience.js` está no `tools/panel-build/manifest.json` (o bundle `assets/panels/growth.js` precisa ser recompilado); o hash CSP do script inline do `growth.html` foi recalculado pelo mesmo método do `build.cjs`.

## Não executado aqui

- Provas com PostgreSQL real (`TEST_DATABASE_URL`): `ab-*-postgres.cjs` nativos, `segment-shopify-rfm-*native-postgres.cjs`, `crm-shopify-sync-postgres.cjs`, `journey-graph-*-postgres.cjs`.
- Worker regular e provas Listmonk que exigem `AB_UPSTREAM_SOURCE` (fixture externa indisponível).
