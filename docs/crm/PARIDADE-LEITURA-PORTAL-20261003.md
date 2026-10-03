# Paridade de leitura do CRM no portal: listas e públicos (fish, aristo)

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

## 9. Limitações
- O GET só-leitura nunca renova o catálogo. `stale:true` é o estado normal fora da janela de cerca de 4 min do caminho de escrita. A UI deve mostrar idade, não erro.
- O `semantic_context.current` de públicos e vínculos depende do catálogo atual. Com `stale`, vem `false` mesmo que nada tenha mudado.
- `campaign_current` (`shrigma_campaign_current`) inclui o corpo da campanha na versão md5. A função de leitura devolve o JSON completo ao serviço, mas a resposta HTTP expõe só `version`, `status` e `list_ids`.
- PGlite tem uma sessão só. A prova com duas sessões, o lock concorrente e a expiração real estão no script PG16, que exige banco descartável (`CRM_AUDIENCE_TEST_ISOLATED=1`, `TEST_DATABASE_URL` loopback ≠ 5432, `PG_MODULE`).
- Nada foi testado contra o portal V24 real nem contra produção.
