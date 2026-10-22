# Paridade de leitura do CRM no portal: listas, públicos, mídia e templates (fish, aristo)

Agente K, 03/10/2026. Branch `claude/crm-read-parity-20261003`, base `a19555c` (PR #218 sobre a #217). A referência é a PR #214 (portal/BFF, head `5e80f98`), consultada somente para leitura. **Nada aqui foi instalado, publicado ou ligado.** O SQL é uma proposta não executada em produção. Os testes rodaram apenas em PGlite e num PostgreSQL 16 descartável, em loopback.

## 1. Por que a leitura atual não serve ao portal

A ponte READ individual (`crm-manager-read-bridge.cjs`, #214) só admite `campaigns` (`campanha_catalogo`, `campanha_listar` e `campanha_obter`) e `campaigns_media`. Públicos e vínculos ficaram fora, com razão: o GET legado de `services/crm-audience` **escreve** (provas na seção 6).

| GET legado | Efeito de escrita |
|---|---|
| `segmentos_listar` / `segmento_obter` | `refresh_native_catalog` (UPDATE em `crm_audience_v2.config`), mais `config_snapshot` e `catalog_lists` com `FOR SHARE` (bloqueio de linha: grava xmax/multixact) |
| `campanha_publico_obter` | o mesmo refresh, mais `campaign_snapshot(id,true)` com `FOR UPDATE OF campaigns`, `lock_campaign_dependencies` (`FOR SHARE` em listas, template e mídia) e `campaign_binding ... FOR UPDATE` |

Envolver esse caminho numa transação `READ ONLY` não resolve. O PostgreSQL recusa `SELECT FOR SHARE` (SQLSTATE 25006), como prova o teste 3. Por isso existe um caminho de leitura próprio.

## 2. Contrato que o painel precisa (mapa)

### growth-segment-client.js (GSC)
- Capacidade: `api.capabilities.segments = {contract_version:'crm-audience-v2', brands:[...], read, save, count, operation}` e `api.capabilities.endpoints.segments` (https, sem query/hash). No portal só-leitura: `read:true` e `save`, `count` e `operation` `false`.
- `GET acao=segmentos_listar&brand&offset&limit` responde `{segments[], limit, offset, catalog, capabilities:{draft,count,send:false}}`. Regras:
  - `catalog` traz `brand`, `current`, `lists[{id,brand,name,available}]`, `catalog_hash`, `fields`, `products`, `origins` e, quando houver, `recorded_origins` e `shopify_snapshot`.
  - Com `catalog.current=false`, `draft` e `count` precisam ser `false`.
  - Campos extras no topo são aceitos (a validação não é exata no topo).
- `GET acao=segmento_obter&brand&id` responde `{segment}` com chaves exatas: `id, brand, name, definition, version, archived, created_at, updated_at, updated_by, semantic_context{currency,timezone,current}`.
- `segmento_operacao` é recuperação de escrita e fica **fora** da leitura.

### growth-campaign-audience-client.js (GCAC)
- Capacidade: `api.capabilities.campaign_audience = {contract_version:'crm-audience-campaign-binding-v1', brands, read, inspect, operation, validate, bind, release}` e `endpoints.campaign_audience`. No portal só-leitura: `read:true` e o resto `false`.
- `GET acao=campanha_publico_obter&brand&campaign_id` exige corpo **exato** `{binding|null, campaign_id, campaign_version(32 hex), selector_ready:false, execution_blocked:true, authorizes_selection:false, authorizes_send:false}`. O limite é de 64 000 bytes.
- Quando existe, `binding` tem chaves exatas (`view`), com `campaign_current === (binding.campaign_version === campaign_version)`.
- `campanha_publico_operacao`, `_conferir`, `_validar`, `_vincular` e `_desvincular` ficam fora.

### growth-campaign-editor.js
- Listas e templates vêm de `campanha_catalogo`, que já é admitido pela ponte da #214: `catalog.lists` filtrado por marca e `available`, `catalog.templates` (`type='campaign'`). O campo da campanha é `definition.list_ids` (`campanha_obter`).
- O cartão de público (`growth-campaign-audience-ui.js`) chama só `GCAC.read`. Com `binding:null`, mostra "Nenhum público salvo vinculado… Confira o conteúdo e as listas antes de agendar". Esse é o **caminho só-lista**. Ele não exige criar nem vincular público salvo.

## 3. Serviço de leitura isolado (lado públicos)

Arquivos novos (nenhum arquivo existente foi alterado):

| Arquivo | Papel |
|---|---|
| `services/crm-audience/read-store.cjs` | Handler e transação de leitura |
| `services/crm-audience/read-server.cjs` | Listener HTTP próprio: `GET /audience-read` e `/healthz` |
| `services/crm-audience/read-config.cjs` | Configuração; `CRM_AUDIENCE_READ_ENABLED`, padrão `false` |
| `services/crm-audience/read-main.cjs` | Entrada `node read-main.cjs` (mesma imagem, app separado) |
| `n8n/growth/crm-audience-read-access.sql` | Papel e funções propostos, **não executado** |

**Por que um listener separado, e não uma rota em `server.cjs`:** `REVIEWED_DYNAMIC` da #214 fixa o sha256 de `services/crm-audience/server.cjs` (`2c86d881…`). Mexer nele invalida esse pin. `server.cjs`, `main.cjs`, `transaction.cjs` e `config.cjs` ficaram byte a byte iguais, e as rotas atuais continuam idênticas. Como o Dockerfile copia `services/crm-audience/*.cjs`, a imagem passa a conter os quatro arquivos novos. O `CMD` continua `main.cjs`.

### Transação
- Abre com `BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY` e `SET LOCAL statement_timeout`.
- Confere `current_user = crm_audience_reader` e `transaction_read_only = on`.
- Só executa instruções de uma **allowlist fixa** (`read-store.cjs` `SQL`). As duas consultas de catálogo com `FOR SHARE` são reescritas para `crm_audience_read.*`. Qualquer outra instrução falha com `CRM_AUDIENCE_READ_STATEMENT_DENIED`.
- No fim, exige `txid_current_if_assigned() IS NULL`. Uma transação que escreveu ou bloqueou linha recebe xid, e nesse caso a resposta é 503 (`CRM_AUDIENCE_READ_WRITE_DETECTED`).
- Termina sempre em `ROLLBACK`, nunca em COMMIT.
- Não chama `refresh_native_catalog` e não grava recibos, contadores ou revisões.
- READ COMMITTED é deliberado: a reautenticação no fim da transação enxerga revogação confirmada por outra sessão (prova PG16 com duas sessões).

### Rota e ações (`GET /audience-read`)
- Exige exatamente um `Authorization: Bearer <chave>`. É a credencial do principal `crm-panel-read`, capacidade `read_content`.
- Sem `Origin` e sem CORS (uso servidor a servidor). Query duplicada é recusada; query limitada a 1024 bytes.
- `POST` e outros métodos: 405. Flag desligada: 503 `CRM_AUDIENCE_READ_DISABLED`, sem pool e sem conexão.

| acao | Campos | Resposta |
|---|---|---|
| `publicos_listas` | brand | `{brand, base_list_id, lists[{id,brand,name,available}], freshness}` |
| `segmentos_listar` | brand, offset=0, limit=50 (1–100) | formato do GSC, mais `freshness`; `capabilities` sempre `{draft:false,count:false,send:false}` |
| `segmento_obter` | brand, id | `{segment, freshness}`; id de outra marca dá 404 `SEGMENT_NOT_FOUND` |
| `campanha_publico_obter` | brand, campaign_id | corpo **exato** do GCAC (sem campo extra) |
| `campanha_publico_contexto` | brand, campaign_id | `{contract:'crm-audience-campaign-read-context-v1', brand, campaign_id, campaign_version, status, list_ids, lists[{id,name,available,in_brand}], list_only, binding_state:'none'\|'released'\|'bound', binding, freshness, schedule_proof:false, …flags}` |

Detalhes da tabela:
- `campanha_publico_obter` e `campanha_publico_contexto` respondem 404 `SEGMENT_BINDING_CAMPAIGN_NOT_FOUND` para campanha de outra marca, Olivas ou inexistente.
- No contexto da campanha, `list_only` é `true` quando `binding_state` ≠ `'bound'`.

Os erros são sempre `{error}`, sem detalhe. Os códigos: 400 `SEGMENT_REQUEST_INVALID`, `SEGMENT_FIELDS`, `SEGMENT_PAGE_INVALID` ou `SEGMENT_ID_INVALID`; 401 `SEGMENT_UNAUTHORIZED`; 403 `SEGMENT_ACCESS_DENIED`; 404; 503 `SEGMENT_READ_UNAVAILABLE`.

### Idade do catálogo e "não é prova"
`freshness = {contract:'crm-audience-read-freshness-v1', catalog_refreshed_at, catalog_expires_at, catalog_age_seconds, read_at, current, stale, coverage:'unconfirmed', schedule_proof:false}`.

- `schedule_proof` é **sempre** `false`, mesmo com catálogo atual. Leitura não serve de prova para agendamento.
- Com catálogo vencido, `catalog.current`, `semantic_context.current` (público e vínculo) e `freshness.current` vêm `false`. Nada é renovado.
- O GET só-leitura não renova o catálogo, que expira em cerca de 4 minutos. Na prática, o portal verá `stale:true` na maior parte do tempo. Isso é esperado e não bloqueia a leitura.

## 4. Ponte do portal (lado BFF)

O módulo novo é `services/dashboard-operational/crm-audience-read-bridge.cjs`. É autocontido: não requer `proxy.cjs` nem `auth.cjs`, e auth, fetch e relógio são injetados. Interface: `createAudienceReadBridge({auth, upstreams, enabled}, {fetchImpl, now}).read({context, route, method, query, origin}, onSettled)`, a mesma da `crm-manager-read-bridge`.

- **Destino fixo:** `upstreams` deve conter só `{'audience-read': URL}`, igual a `https://comunicacao-crm-audience-read.tazdb8.easypanel.host/audience-read` (host proposto; precisa de aprovação). Destino diferente ou rota legada `segments` fazem a construção falhar.
- **Rotas e ações:**
  - `segments`: `segmentos_listar`, `segmento_obter`, `publicos_listas`;
  - `campaign_audience`: `campanha_publico_obter`, `campanha_publico_contexto`.
  - Só GET. Os campos são exatos, a marca é `fish|aristo`, a query vai até 512 bytes, chaves duplicadas e `k` são recusadas.
  - A query sai reescrita em ordem canônica.
- **Auth:**
  - Antes do fetch, `managedCrmReadAuthorization(ctx)`, depois `getUpstreamCredential({...ctx, slot:'crm-panel-read'})` (64 hex) e de novo `managedCrmReadAuthorization`. Depois do corpo, mais uma vez `managedCrmReadAuthorization`.
  - O vínculo precisa ter as dez chaves, `caps` exatamente `[read_content, list_history, submission]` e `slot` `crm-panel-read`.
  - **Expiração re-checada** em cada passo, com margem de 5 s.
  - Revogação ou troca de vínculo (lifecycle, generation, expiração) em qualquer passo resulta em 503 `AUDIENCE_READ_NOT_READY`, sem devolver dado.
- **Upstream:**
  - 404 vira 404 `AUDIENCE_READ_NOT_FOUND`; 401 ou 403 viram 403. Nesses casos o corpo não é lido e a consulta não se repete.
  - Outros status ou redirect viram 502.
  - O content-type precisa ser JSON e o encoding identity. Content-length e stream são limitados a 2 MiB, o UTF-8 é estrito, e eco da credencial é recusado.
  - **Eco da credencial é conferido DEPOIS do `JSON.parse`** (correção K2): varredura iterativa de toda string e toda chave decodificada, em qualquer profundidade, ignorando caixa. A varredura do texto bruto continua, mas sozinha não basta: um único escape `\uXXXX` no JSON (ex.: `\u0062` no lugar de `b`) some no parse e devolveria a credencial inteira em `name`. Eco dá 502 `AUDIENCE_READ_RESPONSE_DENIED`; o valor não aparece no retorno, no erro nem em log. Prova: `tests/claude-read-bridge-secret-echo.test.cjs`.
- **Validação da resposta:**
  - Chaves exatas e marca conferida em cada lista, público, catálogo e vínculo.
  - `capabilities` precisam ser todas `false`.
  - `schedule_proof:false`; `freshness.current === !stale`; `catalog.current === freshness.current`.
  - Catálogo vencido com `semantic_context.current=true` é recusado, assim como contexto só-lista incoerente (`list_only`, `binding_state` ou `binding`).
- **Flag desligada:** 503 `AUDIENCE_READ_DISABLED` antes de qualquer auth, credencial ou fetch.
- Não altera `auth.cjs`, `proxy.cjs`, `server.cjs`, empacotamento, emissor READ, módulos WRITER nem pipelines.

## 5. SQL proposto (não executado)

O arquivo é `n8n/growth/crm-audience-read-access.sql`. É fresh-only: recusa colisão e dependência ausente, e exige owner `postgres` e database `listmonk`. Ele cria:

- schema `crm_audience_read` com três funções `STABLE SECURITY DEFINER`, sem bloqueio:
  - `config_snapshot(text)`;
  - `catalog_lists(text)`;
  - `campaign_current(integer)`, que envolve `shrigma_campaign_current`;
- papel `crm_audience_reader` `NOLOGIN NOINHERIT CONNECTION LIMIT 4`, com `default_transaction_read_only=on`, `statement_timeout 8s`, `lock_timeout 500ms`, `idle_in_transaction_session_timeout 15s` e `search_path=pg_catalog`.

Concessões ao papel:
- `CONNECT`;
- `USAGE` em `crm_audience_read` e `crm_audience_v2`;
- `SELECT` só em `crm_audience_v2.audience`, `campaign_binding` e `campaign_binding_release`;
- `EXECUTE` em `crm_audience_v2.authenticate(text)` e nas três funções novas;
- e, se existirem, em `recorded_origin_source_current`, `shopify_snapshot` e `rfm_snapshot` (todas STABLE).

O papel **não** recebe `refresh_native_catalog`, `config_snapshot`/`catalog_lists` legadas, `campaign_snapshot`, `touch_campaign`, `lock_campaign_dependencies`, `shrigma_campaign_provider` nem tabelas nativas.

O arquivo inclui consultas de conferência pós-instalação: privilégios diferentes de SELECT, funções de escrita executáveis e associações de papel. Todas devem voltar vazias.

## 6. Provas (sintéticas)

| Critério | Prova |
|---|---|
| Zero efeitos de escrita | **PGlite**, `tests/claude-audience-read-store.test.cjs` testes 1 e 2: hash de linhas, xmin e xmax de todas as tabelas, igual antes e depois; nenhuma instrução de escrita no log; ROLLBACK sem COMMIT. Contraprova: o GET legado altera xmax. **PG16**, `tests/claude-audience-read-pg16-postgres.cjs`: `zero_effect` |
| Papel sem privilégio + READ ONLY | Teste 3: 10 instruções de escrita ou legadas dão 42501 com o papel; o owner em READ ONLY recusa o catálogo legado (25006 FOR SHARE); allowlist, papel errado, `read_only=off` e xid atribuído falham fechado. PG16: SQL **sem modificação** instalado; reinstalação recusada; `role_table_grants` só SELECT; nenhuma função de escrita executável; o papel com `BEGIN READ WRITE` recebe 42501 |
| Leitura não disputa lock com escritor | PG16: com config, listas e campanha em `FOR UPDATE` noutra sessão, a leitura respondeu em 16 ms; o catálogo legado esperou 503 ms e falhou com 55P03 |
| Negação cruzada de marca | Teste 1: 12 combinações de campanha (outra marca, Olivas, inexistente) dão 404. Teste 2: público da outra marca dá 404. Ponte: corpo de outra marca dá 502 (`claude-audience-read-bridge.test.cjs` teste 5) |
| Principal revogado ou expirado | Teste 4: revogado, expirado, sem `read_content` (403), chave desconhecida. PG16: revogação confirmada por **outra sessão** durante a leitura dá 401 (`revocation_two_sessions`); expiração real após 2 s dá 401. Ponte teste 4: revogado, expirado, margem, `caps` ou `slot` errados, credencial inválida dão 503 sem fetch |
| Vínculo trocado no meio | Ponte teste 4: geração ou lifecycle trocados entre as checagens, ou revogação e expiração observadas depois do corpo, dão 503. Serviço teste 4: ator diferente na reautenticação final dá 401 |
| Resposta malformada ou grande demais | Ponte teste 5: JSON inválido, UTF-8 inválido, array, chave extra, content-type, gzip, content-length acima de 2 MiB, stream acima de 2 MiB, eco de segredo, `capabilities` verdadeiras, limit ou marca divergentes |
| Catálogo velho marcado como não-prova | Teste 2 e PG16: `stale:true`, `current:false`, `schedule_proof:false`, `semantic_context.current:false`, config não renovado. A ponte recusa corpo que alegue o contrário |
| Campanha só-lista sem público salvo, duas marcas | Teste 1 (zero públicos no banco): contexto fish 100 e 300 e aristo 200 com `binding:null`, `list_only:true` e listas nomeadas; `GCAC.validation.readBody` aceita. Teste 2: aristo segue só-lista mesmo com público salvo; vínculo liberado vira `released`/só-lista. Ponte teste 1 |
| Flag OFF, 503 sem I/O | Teste 5: `read-main` com `Pool` que falha se for construído; handler que falha se for chamado; `healthz` mostra `enabled:false`. Ponte teste 2: zero auth, credencial e fetch |

Resultados dos comandos:
- `claude-audience-read-store.test.cjs`: 5 de 5.
- `claude-audience-read-bridge.test.cjs`: 5 de 5.
- PG16 16.15 (cluster descartável `/tmp`, porta 55433, já derrubado): resumo JSON OK.
- Focais: 51 arquivos `segment-*`, `crm-audience-*`, `growth-segment-*` e `growth-campaign-audience-*` (sem o path). Todos passam, exceto seis arquivos `segment-regular-*`, que falham já no estado-base `a19555c` por `ENOENT /home/claude/runtime/crm-audit-20260924/...` (fonte upstream local ausente) e não tocam os arquivos novos.
- Seis testes escolhidos de `growth-campaign-audience-path`, um por processo: 6 de 6.

## 7. Integração proposta para o Codex (#214), em ordem

1. Revisar e mesclar estes arquivos novos. Não exigem mudança em `server.cjs` do crm-audience, e o pin `2c86d881…` continua válido.
2. Instalar `crm-audience-read-access.sql` no banco com aprovação explícita. Rodar as três conferências do arquivo. Gerar a senha do papel em canal privado, `ALTER ROLE … LOGIN` e conferir de novo os privilégios efetivos.
3. Criar o app Easypanel `comunicacao/crm-audience-read`: mesma imagem do crm-audience, `CMD node read-main.cjs`, `CRM_PG_USER=crm_audience_reader`, `CRM_AUDIENCE_READ_ENABLED=false` no primeiro deploy, rede interna, porta 8080. Conferir `healthz` (`enabled:false`) e 503 na rota.
4. Ligar `CRM_AUDIENCE_READ_ENABLED=true` e testar com a credencial `crm-panel-read` de um gestor de teste: duas marcas, campanha só-lista, catálogo `stale`, 401 com a chave revogada.
5. Deltas no portal (#214), **não feitos aqui**:
   - `server.cjs`: hoje `managedReadRoute` usa `Object.hasOwn(ManagedRead.ACTIONS, route)`. Acrescentar `AudienceRead.ACTIONS[route][acao]` para `segments` e `campaign_audience` em GET, encaminhando a `audienceReadBridge.read(...)` com o mesmo controle de vagas e `onSettled`.
   - Construir a ponte com `upstreams={'audience-read': new URL(DESTINATIONS['audience-read'])}` atrás de uma flag própria (ex.: `DASHBOARD_CRM_MANAGED_AUDIENCE_READ`), OFF, que exige o perfil gerenciado e todas as flags de escrita OFF, como `DASHBOARD_CRM_MANAGED_READ_UI`.
   - `rewriteCapabilities`: no perfil gerenciado, publicar `endpoints.segments=origin+'/api/segments'` e `endpoints.campaign_audience=origin+'/api/campaign_audience'`; forçar `segments.{save,count,operation}=false` e `campaign_audience.{inspect,operation,validate,bind,release}=false`, com `read:true` só se a ponte estiver ligada.
   - `READ` do `proxy.cjs` não muda: a rota gerenciada não passa por `forward`.
   - Allowlist do Docker e pack: incluir o módulo novo e medir de novo o pack. A margem atual de 949 014/950 000 bytes é pequena; o módulo tem cerca de 15 KB e **provavelmente estoura o teto**. Medir antes; não subir o teto sem decisão.
   - O navegador continua mandando `Authorization` com a chave local, mas a ponte ignora isso: só vale a credencial do principal.
6. Liberar a UI (`DASHBOARD_CRM_MANAGED_READ_UI` e a flag nova) só depois do passo 4 com dado real.

## 8. Próximo delta: templates e mídia

> Diagnóstico de origem do §9 (agente N), que entrega o validador de mídia, a ponte e o SQL de templates.


- **Templates da campanha** (seletor `template_id`): já cobertos. Vêm de `campanha_catalogo.templates` (Listmonk `type='campaign'`, `id/name/type/available/version`), que a ponte da #214 admite. Lacuna: o `responseShape` da #214 só confere `Array.isArray(templates)`. Falta validar item a item (chaves exatas, `type==='campaign'`, `version` md5) e limitar a quantidade.
- **Biblioteca de templates Growth** (`growth-templates-api.js`, rota `templates`: `listar`, `email_capacidades`, `historico`, `submissao`, `fluxos_listar`):
  - O destino é o webhook n8n, cujo handler **não está versionado no repo**. Não há prova de ausência de efeitos: fila e registro de execução do n8n, auth pelo caminho legado.
  - `shrigma_template_auth_v2` é STABLE e aceita o principal `crm_dash_chave` growth com exatamente `[read_content, list_history, submission]`. A capacidade do principal combina.
  - `listar` aceita `marca` opcional (todas as marcas). `historico` e `submissao` não têm marca, o que traz risco cruzado.
  - Contrato que falta: destino fixo de leitura (idealmente um serviço como `crm-panel-read`, fora da fila do n8n), `marca` obrigatória `fish|aristo` com filtro no servidor, validação por item (marca, chaves), e `historico`/`submissao` exigindo `marca` e conferindo o dono do rascunho.
  - `operacao`, `email_teste_*` e `fluxo_operacao` ficam fora (são escrita ou recuperação).
- **Mídia** (`campaigns_media`, `services/crm-campaign/media.cjs`, igual na #214 e aqui):
  - O GET exige `read_content`, lê da API Listmonk com Basic auth e filtra por marca pelo nome canônico `crm-<marca>-…`.
  - Arquivos **legados sem marca aparecem nas duas marcas**: mostrar isso como "não atribuído", ou excluir.
  - A ponte da #214 valida só `contract`, `brand` e `items.length ≤ 50`. Falta: chaves exatas por item, marca do `filename` igual à pedida (ou marcada como legado), URLs só do host de uploads do Listmonk (sem proxy de URL arbitrária), `page`/`per_page` limitados e ecoados.
  - O filtro por marca depende da liberação separada da imagem de campanhas (pendência 1 do documento de integração da #214).
- Em nenhum dos dois casos há alargamento genérico do proxy. Cada fonte entra com ação, destino, ator, capacidade e efeito declarados, como nesta ponte.

## 9. Templates e mídia (agente N, branch `claude/crm-read-templates-media-20261003`, base `a7c05c5`)

Tudo OFF e nada instalado. Arquivos novos, nenhum arquivo existente de serviço, da #214, de empacotamento, do emissor READ, do WRITER ou de workflows foi alterado. Nenhuma fonte do bundle growth foi tocada.

| Arquivo | Papel |
|---|---|
| `services/dashboard-operational/crm-media-read-validator.cjs` | Validador estrito da biblioteca de mídia (`crm-media-v1`) para a ponte da #214 |
| `services/dashboard-operational/crm-template-read-bridge.cjs` | Ponte READ de templates, padrão da #219, destino fixo **proposto** |
| `n8n/growth/crm-template-read-access.sql` | Papel e funções de leitura propostos, **não executado** |
| `tests/claude-media-read-validator.test.cjs`, `tests/claude-template-read-{bridge,store}.test.cjs`, `tests/claude-template-read-fixture.cjs`, `tests/claude-template-read-pg16-postgres.cjs` | Provas |

### 9.1 Mídia: o GET de listagem não tem efeito

Lido em `services/crm-campaign/{server,media,transport,main}.cjs` e no SQL de autenticação:

- `mediaGet` só aceita `brand`, `page`, `per_page` (ou o trio de recuperação de upload). Não lê corpo.
- O executor faz **uma** chamada `SELECT public.shrigma_crm_campaign_auth_v1($1)`. A cadeia (`shrigma_crm_operator_auth_v1` → `shrigma_panel_operator_v1` / `shrigma_template_auth_v2`) é STABLE e não tem INSERT/UPDATE/DELETE nem bloqueio de linha. `shrigma_panel_auth_v1`, que grava `ultimo_uso`/`usos`, **não** está nessa cadeia. A `_v1` do gateway é plpgsql VOLATILE, mas só chama as STABLE.
- Depois faz de 1 a 4 `GET /api/media?page&per_page&query=` no Listmonk (Basic auth do serviço, `redirect:'manual'`, sem corpo). Não há upload, mutex de marca, cache, diário nem estado entre leituras. O único estado é o contador de vagas em memória do `server.cjs`.
- O GET do Listmonk (`/api/media`, v6.1.0) é externo ao repo. Pela fonte pública ele é uma consulta, mas isso **não foi verificado aqui**.
- O destino `campaigns_media` da #214 é o host n8n (`…/webhook/crm-campanhas-api-…/media`). O documento de corte da #214 registra que esse caminho chega ao `crm-campaign`: o GET anônimo devolveu 401 com o cabeçalho de revisão do backend.
- Conclusão: não é preciso um caminho de leitura novo para mídia. Basta validar a resposta.

Prova: `claude-media-read-validator.test.cjs` › "GET de mídia não tem efeito…". O pool só vê `AUTH_SQL`; o Listmonk só vê `list` com `query=''`; o scan para em 4 páginas; duas leituras seguidas dão o mesmo resultado; um GET pendente não bloqueia o upload da marca; o transporte usa GET sem corpo. Os corpos SQL da cadeia de autenticação foram conferidos, com contraprova de que `shrigma_panel_auth_v1` grava.

### 9.2 Mídia: contrato validado (`validateMediaLibraryResponse`)

- **Pedido** (`mediaRequest`): só `brand` (`fish|aristo`), `page` (1–10 000, padrão 1) e `per_page` (1–50, padrão 24), sem chave repetida. A query sai canônica. A recuperação de upload (`operation_id`/`filename`/`sha256`) fica **fora**, porque é caminho de escrita.
- **Topo** com chaves exatas: `contract:'crm-media-v1'`, `brand` igual à pedida, `items`, `total` (0–1 000 000), `page`, `per_page`, `next_page`.
- **Paginação coerente**:
  - `per_page` ecoa o pedido e `items.length ≤ per_page`.
  - `page` fica entre o pedido e o pedido+3. O serviço pula até 3 páginas nativas só da outra marca.
  - `next_page === (page*per_page<total ? page+1 : null)`.
  - Página vazia com continuação só vale quando o scan esgotou as 4 páginas.
  - Itens além de `total` e `total:0` fora da página pedida são recusados.
- **Item** com chaves exatas `id, filename, url, thumb_url, content_type, width, height, created_at`:
  - `id` positivo e único na página.
  - `content_type` só `image/png|jpeg|gif`.
  - Dimensões dentro de 4 MP.
  - `created_at` é null ou data.
  - `filename` tem até 180 caracteres, sem `/`, `\` e controle.
- **URL** (`url` e `thumb_url`):
  - `https`, host exato `email.shrigma.com.br`, sem userinfo, porta, query (nem `?` vazio) ou hash.
  - O texto precisa já estar canônico.
  - Um único segmento sob `/uploads/`, sem `%2f`, `%5c` ou `%00`.
  - Violar qualquer regra recusa a resposta **inteira** (502).
- **Credencial:** eco da credencial do principal em qualquer campo recusa tudo (`MEDIA_READ_SECRET_ECHO`). A conferência é sobre o corpo já decodificado (`JSON.stringify` do objeto recebido).
- **Marca pelo nome canônico** `crm-<marca>-<uuid4>-<sha256>.<png|jpg|gif>`. A regex é a mesma de `media.cjs`, e o teste confere a equivalência.
  - Nome canônico de **outra marca** recusa a resposta inteira (`MEDIA_READ_FOREIGN_BRAND`). Isso significa que o filtro por marca do serviço não está ativo (imagem 23e472ab).
  - No nome canônico, a extensão precisa casar com o tipo e a URL apontar para o próprio arquivo.
- **Marca de toda URL de arquivo do item** (correção K2): a marca é lida em qualquer ponto do nome decodificado de `filename`, `url` e `thumb_url` (`crm-(fish|aristo|olivas)-`, sem diferenciar caixa; ex.: `thumb_crm-aristo-<uuid>-<sha>.png`).
  - Item canônico com `url` ou `thumb_url` de **outra marca** (inclusive olivas, ou nome com duas marcas): recusa a página inteira (`MEDIA_READ_FOREIGN_BRAND`), igual ao filename de outra marca.
  - Item canônico com **miniatura legada** (sem marca no nome): recusa a página inteira (`MEDIA_READ_THUMB_DENIED`). Escolha: recusar, não remover. O Listmonk gera `thumb_<filename>`, então miniatura sem marca em item canônico é anomalia; e removê-la em silêncio esconderia o defeito. Legado nunca é atribuído a uma marca por estar na miniatura.
  - Item **legado** com `url`/`thumb_url` de outra marca: sai da lista (`excluded_foreign_prefix`), como o prefixo de outra marca, porque o serviço mostra o legado nas duas marcas. Miniatura sem marca ou da própria marca mantém o item como `legacy:true`, fora de `brand_items`.
  - `thumb_url: null` segue aceito.
- **Decisão sobre legado (sem nome canônico):** o serviço mostra o arquivo nas duas marcas. O validador o devolve com `legacy:true`, e os itens da marca saem com `legacy:false`. Ele **nunca** entra em `summary.brand_items`. Com `legacy:'exclude'`, sai da lista.
  - Nome com prefixo de outra marca (inclusive `crm-olivas-` ou em maiúsculas) sem ser canônico: excluído, nunca mostrado como neutro.
  - Legado cuja URL não aponta para o próprio arquivo ou cuja extensão não é do tipo: excluído (`excluded_irregular`), sem derrubar a página.
- **Saída:** `{body, summary}`. O `body` mantém o contrato `crm-media-v1`, e cada item ganha `legacy`. O `growth-media.js` atual ignora o campo extra. Mostrar a etiqueta "sem marca (legado)" exige um delta de front, **não feito aqui** (fonte do bundle).

### 9.3 Delta exato proposto para `crm-manager-read-bridge.cjs` (#214, não editado)

```diff
 const P=require('./proxy.cjs');
+const MediaRead=require('./crm-media-read-validator.cjs');
@@ function decision(route,method,query){
  if(d.edit||d.area!=='growth'||!ACTIONS[route].includes(d.action)||!['fish','aristo'].includes(query.get('brand')))fail();
+ if(route==='campaigns_media')try{MediaRead.mediaRequest(query);}catch{fail();}
  return Object.freeze({...d,sourceCredentialSlot:'crm-panel-read'});
@@
-function responseShape(d,value,query){
+function responseShape(d,value,query,credential){
  if(!plain(value))fail(502,'MANAGED_READ_RESPONSE_DENIED');
  const brand=query.get('brand');
  if(d.route==='campaigns_media'){
-  if(value.contract!=='crm-media-v1'||value.brand!==brand||!Array.isArray(value.items)||value.items.length>50)fail(502,'MANAGED_READ_RESPONSE_DENIED');
+  const r=MediaRead.mediaRequest(query);
+  try{return MediaRead.validateMediaLibraryResponse(value,{brand:r.brand,page:r.page,per_page:r.per_page,secrets:[credential]}).body;}
+  catch{fail(502,'MANAGED_READ_RESPONSE_DENIED');}
  }else if(d.action==='campanha_catalogo'){
@@ (fim de responseShape)
+ return value;
 }
@@ async function read(value,onSettled){
-  const url=new URL(target.href);url.search=query.toString();
+  const url=new URL(target.href);url.search=(d.route==='campaigns_media'?MediaRead.mediaRequest(query).query:query).toString();
@@
-   responseShape(d,value,query);
+   value=responseShape(d,value,query,credential);
```

Mais o allowlist do Docker e do pack para o módulo novo (cerca de 9 KB). A margem do pack é pequena (§7.5): medir antes. Os testes da #214 que montam respostas de mídia precisam de itens completos e de `total/page/per_page/next_page`.

### 9.4 Templates: de onde vem a marca e o que falta

| Ação legada (n8n, handler **não versionado**) | Marca derivável de dado versionado? | Destino de leitura proposto |
|---|---|---|
| `listar`, canal e-mail | **Sim**, para template Listmonk registrado em `shrigma_template_email_registry(template_id,brand)`: registro da marca e nenhum de outra. É o critério de `journey-graph-catalog.sql` e `engagement-editor-validation.sql`; a coluna e o CHECK existem em produção (`olivas-nps.sql`) | `listar`, só `registered_email_only` |
| `listar`, canal WhatsApp | **Não.** Nenhuma tabela versionada liga um template aprovado na Meta a uma marca | não servido (403 na ponte) |
| `historico` por `draft_id` | **Sim**, por `shrigma_template_draft.brand` (critério de `email-test-recipient.sql`) | `historico` |
| `historico` por `key` | **Não.** A `key` de template publicado é conceito do handler, sem tabela versionada | não servido |
| `submissao` | **Sim**: `submissao.draft_id` → `draft.brand` | `submissao` (estado gravado; não consulta a Meta) |
| `email_capacidades`, `email_previa` (POST), `operacao`, `rascunho`, `validar`, `submeter`, `fluxos_listar`, `email_teste_*` | — | fora (escrita, recuperação ou render) |

**O que falta para o restante, sem inventar:**
1. Metadado de marca dos templates WhatsApp publicados. Por exemplo, um registro versionado `(waba_id, template_name, language) → brand`, ou o WABA de cada marca em configuração versionada.
2. Mapa `key` → `draft_id`/marca para o histórico de templates publicados.
3. Templates Listmonk legados sem registro: hoje não têm marca e **não aparecem** (`coverage:'registered_email_only'`). Registrar cada um com aprovação, ou aceitar a perda.
4. DDL de produção de `shrigma_template_evento`/`_submissao`. As colunas `at`, `who`, `from_version`, `detail`, `rejected_reason` e `checked_at` só aparecem em fixtures. O SQL as lê por `to_jsonb(linha)` e devolve `null` quando faltam.
5. Prova de que o `submissao` legado não grava ao consultar a Meta. O handler não está no repo, e o caminho novo **não consulta** o provedor (`provider_polled:false`).

### 9.5 Templates: contrato do destino de leitura (`crm-template-read-v1`)

Destino fixo **proposto** (host a confirmar pelo Codex): `https://comunicacao-crm-template-read.tazdb8.easypanel.host/template-read`.
- Só GET, `Authorization: Bearer <credencial crm-panel-read>`, sem Origin e sem CORS.
- Sem efeito, então idempotente por construção: repetir dá o mesmo resultado. Não há chave de idempotência, recibo nem contador.
- O serviço HTTP (listener) está em `services/crm-template-read/` (PR própria, base #219): flag `CRM_TEMPLATE_READ_ENABLED` OFF sem pool nem segredo, `BEGIN READ ONLY`, papel `crm_template_reader`, `txid_current_if_assigned() IS NULL` e `ROLLBACK`; só chama as três funções abaixo e valida a saída com a mesma `responseShape` da ponte. **Preparado e testado em isolamento** (PGlite e PostgreSQL 17.10 descartável); não instalado nem validado no portal real. Vaga presa até a conexão terminar (inclusive após 503 por prazo), eco da credencial também codificado e admissão do catálogo por md5 a cada pedido (revisão 5974202110). Ver `services/crm-template-read/README.md` e o roteiro `docs/crm/ROTEIRO-ACEITE-TEMPLATES-20261004.md`.

| acao | Campos | Resposta |
|---|---|---|
| `listar` | `brand` (`fish|aristo`, obrigatória), `channel=email`, `offset` (0–100 000), `limit` (1–20 na ponte; até 50 no SQL) | `{contract:'crm-template-read-v1', brand, channel:'email', templates[], offset, limit, total, next_offset, coverage:'registered_email_only', consultado_em, schedule_proof:false}` |
| `historico` | `brand`, `draft_id` (`[A-Za-z0-9_-]{1,64}`) | `{contract:'crm-template-history-read-v1', brand, draft_id, events[≤200], truncated, read_at}` |
| `submissao` | `brand`, `submission_id` | `{contract:'crm-template-submission-read-v1', brand, submission_id, draft_id, draft_version, provider, estado, provider_status, rejected_reason, checked_at, read_at, provider_polled:false}` |

Detalhes do contrato:
- Item de `listar`, com chaves exatas:
  - `key`, `brand`, `channel`, `id` (string de dígitos), `name` (até 160, sem controle) e `type` (`campaign|tx`);
  - `draft_id`: null quando há zero ou mais de um rascunho registrado;
  - `components {subject, body_html, altbody:null}`, ou null quando o corpo passa de 400 000 caracteres. Nesse caso `content_available:false`, e nada é truncado;
  - `content_hash` (sha256 do conteúdo) e `updated_at`.
- Evento: `{at, who, action, from_version, to_version, result, detail}`.
- Erros: rascunho ou submissão de outra marca, Olivas ou inexistentes viram "não encontrado", sem distinção.

**Ponte (`crm-template-read-bridge.cjs`):**
- Mesma interface e mesmo controle da #219:
  - flag OFF dá 503 antes de qualquer auth, credencial ou fetch;
  - principal `crm-panel-read`, com 10 chaves, `caps` exatos e expiração com margem de 5 s, conferido antes, ao obter a credencial e depois do corpo;
  - credencial de 64 hex;
  - 401/403/404 sem ler o corpo nem repetir;
  - JSON identity até 8 MiB e UTF-8 estrito;
  - eco da credencial é recusado, conferido no texto bruto **e** em toda string e chave decodificada após o `JSON.parse` (escape `\uXXXX` não contorna; correção K2). 502 `TEMPLATE_READ_RESPONSE_DENIED`, sem eco do valor.
- **Pedido** no vocabulário do cliente `GTA`: `acao=listar&marca[&canal=email][&offset][&limit]`, `historico&marca&draft_id`, `submissao&marca&submission_id`.
  - `marca` ausente, `todas`, `olivas` ou vazia é recusada sem I/O. O mesmo vale para `canal=whatsapp`, `historico` por `key`, chave `k`, ações de escrita e query acima de 512 bytes.
  - A ponte reescreve para `brand` em ordem canônica.
- **Resposta:**
  - Chaves exatas e paginação coerente: `templates.length === min(limit, total-offset)` e `next_offset` consistente.
  - Ids em ordem crescente e sem repetição.
  - **Qualquer item de outra marca, sem marca ou de outro canal recusa a resposta inteira** (502).
  - `schedule_proof:false` e `provider_polled:false` são obrigatórios.

### 9.6 Templates: SQL somente leitura (`n8n/growth/crm-template-read-access.sql`, não executado)

- Exige owner `postgres` e database `listmonk`, é fresh-only (recusa colisão) e confere dependências.
- Schema `crm_template_read` com quatro funções `STABLE SECURITY DEFINER SET search_path=pg_catalog`, sem bloqueio nem escrita:
  - `principal(k,cap)`, interna e **não concedida**. Aceita só a chave de 64 hex de um principal `panel:dcrm-<32 hex>` via `shrigma_panel_operator_v1(k,'growth')` (STABLE), com a capacidade da ação.
  - Chaves legadas compartilhadas (`crm_dash_chave` sem hash, `shrigma_template_key_v2`) **não** leem por aqui, embora o handler legado as aceite.
  - `listar(k,b,offset,limit)` exige `read_content`, `historico(k,b,draft_id)` exige `list_history` e `submissao(k,b,submission_id)` exige `submission`.
- Papel `crm_template_reader`: `NOLOGIN NOINHERIT`, `CONNECTION LIMIT 4`, `default_transaction_read_only=on`, timeouts e `search_path=pg_catalog`.
  - Recebe só `CONNECT`, `USAGE` no schema e `EXECUTE` nas três funções.
  - **Nenhuma** tabela.
- O arquivo traz as conferências pós-instalação e a reversão.

### 9.7 Provas

| Critério | Prova |
|---|---|
| Mídia: GET sem efeito | `claude-media-read-validator.test.cjs` teste 2 (executor real com pool e Listmonk sintéticos, SQL da cadeia de auth) |
| Mídia: marca, legado e contagem | testes 1 e 4: resposta real do executor nas duas marcas; legado `legacy:true` fora de `brand_items`; política `exclude`; prefixo de outra marca e legado irregular excluídos |
| Mídia: recusa estrita | teste 5: outra marca canônica, 13 variantes de URL (http, host, userinfo, porta, query, `?` vazio, hash, fora de `/uploads/`, subpasta, `%2f`, host em maiúsculas, `javascript:`, espaço), thumb, eco de segredo, 11 itens malformados, id duplicado e 9 casos de paginação |
| Mídia: marca da miniatura e da URL (K2) | `claude-media-read-thumb-brand.test.cjs`: miniatura da própria marca aceita; canônico com miniatura de outra marca recusa a página nas duas direções (fish→aristo, aristo→fish), em caixa alta, olivas e marca mista; canônico com miniatura legada recusa (`MEDIA_READ_THUMB_DENIED`); legado com miniatura de outra marca sai, sem marca ou da própria marca continua legado. Falha em `ed138b9` |
| Pontes: eco de credencial escapado (K2) | `claude-read-bridge-secret-echo.test.cjs`: credencial sintética com `\uXXXX` no primeiro, último, meio, todos (hex minúsculo e maiúsculo), alternado e em maiúsculas; em valor, chave de objeto e array aninhado, nas pontes de públicos e templates. Sempre 502, sem o valor no retorno, erro ou log, zero sockets. Falha em `ed138b9` (devolvia 200 com a credencial em `name`) |
| Mídia: equivalência com `media.cjs` | teste 3: `filenameParts` igual em 10 nomes; `mediaRequest` canônico e recuperação recusada |
| Templates: isolamento de marca no servidor | `claude-template-read-store.test.cjs` testes 1 e 2 (PGlite): fish = 1, 6 e 8, e aristo = 2 e 9. Ficam fora: legado sem registro, ambíguo, Olivas e clone interno. Histórico e submissão cruzados, Olivas e órfãos dão `NOT_FOUND`. A ponte aceita a saída real do SQL e recusa a de outra marca |
| Templates: zero efeito | testes 1 e 2: hash de linhas, xmin e xmax iguais e `txid_current_if_assigned()` nulo. Teste 4: o owner lê em `READ ONLY`; as funções são STABLE e sem escrita no `prosrc`. **PG16 16.15** (`claude-template-read-pg16-postgres.cjs`, cluster descartável em `/tmp`, porta 55435, já derrubado): arquivo **sem alteração** instalado, reinstalação recusada, papel com LOGIN e `transaction_read_only=on`, `zero_effect` |
| Templates: papel sem privilégio | teste 4 e PG16: SELECT direto, `principal`, `shrigma_panel_operator_v1` e `shrigma_panel_auth_v1` dão 42501; INSERT/UPDATE/DELETE em transação READ WRITE dão 42501; zero `role_table_grants` |
| Templates: principal | teste 3: sem capacidade dá `ACCESS_DENIED`; revogado, legado, `template_key_v2`, maiúsculas e vazio dão `UNAUTHORIZED`, com contraprova de que o caminho legado aceita. Expiração real. PG16: revogação confirmada por outra sessão é vista na leitura seguinte (READ COMMITTED) |
| Templates: sem disputa de lock | PG16: com `FOR UPDATE` do escritor em templates, rascunhos e chaves, a leitura respondeu em 9 ms |
| Ponte de templates | `claude-template-read-bridge.test.cjs`: duas marcas e query canônica; flag OFF sem I/O; 21 pedidos fora do contrato sem I/O; principal revogado ou trocado antes e depois do corpo; 23 corpos de lista, 7 de histórico e 7 de submissão inválidos; 404/401/403/503/302 |

**Observação** (não alterada): `shrigma_template_auth_v2` continua executável por PUBLIC (`panel-short-keys.sql` não revoga). Qualquer papel com CONNECT, inclusive o novo, pode chamá-la. Ela é STABLE e não grava, mas valida chaves. A PG16 registra `preexisting_public_execute_template_auth_v2:true`.

### 9.8 Deltas do BFF (#214) para templates, não feitos

1. `server.cjs`, em `managedReadRoute`: admitir `TemplateRead.ACTIONS.templates[acao]` em GET e encaminhar a `templateReadBridge.read(...)` com o mesmo controle de vagas e `onSettled`. Construir com `upstreams={'template-read':new URL(DESTINATIONS['template-read'])}` atrás de uma flag própria (ex.: `DASHBOARD_CRM_MANAGED_TEMPLATE_READ`), OFF, que exige o perfil gerenciado e todas as flags de escrita OFF.
2. `rewriteCapabilities` no perfil gerenciado:
   - publicar `endpoints.templates=origin+'/api/templates'`;
   - `capabilities.templates={read_content:true, list_history:true}` só com a ponte ligada;
   - `draft`, `validate`, `submit` e `submit_email` `false`; `workflows.{set_mode,activate}=false`; `write_key_required:true`.
   - `email_capacidades` e `email_previa` não ficam disponíveis: a prévia com variáveis mostra "não está disponível neste acesso".
3. Allowlist do Docker e do pack para o módulo (cerca de 14 KB). Somado ao de mídia e ao de públicos, **provavelmente estoura** a margem atual de 949 014/950 000 bytes. Medir; não subir o teto sem decisão.
4. Front, **não feito** (fontes do bundle):
   - `GTA.cliente.historico/submissao` precisam mandar `marca`;
   - `carregarConteudo` precisa mandar a marca selecionada (com `todas`, a ponte recusa) e paginar `offset/limit≤20`;
   - a `key` nova (`email.template.<id>`) não casa com as keys legadas. `previaPublicada` cai no casamento por `name`+`brand`, que continua funcionando;
   - prévia WhatsApp: 403, a tela mostra "Não foi possível consultar".

### 9.9 Sequência proposta

1. Mídia: aplicar o delta 9.3 na #214 e rodar de novo os testes da ponte e do pack. Só ligar `campaigns_media` depois que a imagem de campanhas com filtro por marca (23e472ab) estiver instalada. Sem ela, o validador recusa toda página que tenha arquivo canônico da outra marca, ou seja, falha fechado.
2. Templates:
   - revisar e mesclar a ponte e o SQL;
   - instalar o SQL com aprovação e rodar as três conferências;
   - construir o listener (padrão `read-main.cjs`) e criar o app `comunicacao/crm-template-read` com a flag OFF;
   - conferir `healthz` e o 503;
   - ligar e testar com o gestor de teste nas duas marcas (registro, histórico, submissão, 401 com a chave revogada);
   - só então os deltas 9.8 e a UI.
3. WhatsApp, histórico por `key` e legado sem registro ficam **bloqueados** até existir o metadado de marca do item 9.4.

### 9.10 Limitações

- Nada foi testado contra o V24 real, o Listmonk real ou produção.
- O listener de templates não existe.
- A ponte de templates fica fora do pack até a decisão sobre o tamanho.
- Listagem de templates: só e-mail registrado; páginas de até 20 itens na ponte. O teto de 8 MiB pode recusar uma página com corpos grandes; nesse caso, usar `limit` menor.
- `submissao` devolve o estado gravado, não o do provedor. O acompanhamento automático do painel (a cada 60 s) deixa de "verificar" na Meta por esse caminho.
- Mídia: o legado aparece nas duas marcas, marcado e nunca contado como da marca. A etiqueta visual depende de um delta de front.

## 10. Limitações (públicos)
- O GET só-leitura nunca renova o catálogo. `stale:true` é o estado normal fora da janela de cerca de 4 min do caminho de escrita. A UI deve mostrar idade, não erro.
- O `semantic_context.current` de públicos e vínculos depende do catálogo atual. Com `stale`, vem `false` mesmo que nada tenha mudado.
- `campaign_current` (`shrigma_campaign_current`) inclui o corpo da campanha na versão md5. A função de leitura devolve o JSON completo ao serviço, mas a resposta HTTP expõe só `version`, `status` e `list_ids`.
- PGlite tem uma sessão só. A prova com duas sessões, o lock concorrente e a expiração real estão no script PG16, que exige banco descartável (`CRM_AUDIENCE_TEST_ISOLATED=1`, `TEST_DATABASE_URL` loopback ≠ 5432, `PG_MODULE`).
- Nada foi testado contra o portal V24 real nem contra produção.
