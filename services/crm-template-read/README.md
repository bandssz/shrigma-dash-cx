# Listener de leitura de templates do CRM (`crm-template-read-v1`)

Serviço HTTP **somente leitura** que entrega à ponte do portal (`services/dashboard-operational/crm-template-read-bridge.cjs`) os templates de e-mail registrados de uma marca, o histórico de um rascunho e o estado gravado de uma submissão. Contrato: §9.5 de `docs/crm/PARIDADE-LEITURA-PORTAL-20261003.md`. Capability anunciada pelo BFF quando ligado: `templates.read_contract='crm-template-read-v1'` (integração do BFF é do Codex).

Estado: **preparado e testado em isolamento**. Não está instalado, ligado nem validado no portal real. O SQL `n8n/growth/crm-template-read-access.sql` não foi executado em nenhum banco real.

## Fronteira

- `GET /template-read` e `GET /healthz`. Nada mais (404).
- Sem CORS: chamada servidor a servidor. `Origin` presente → 403. Corpo, `Content-Length` ou `Transfer-Encoding` → 400. Método ≠ GET → 405.
- Um único `Authorization: Bearer <64 hex>` (credencial `crm-panel-read` do principal individual). Outro formato → 401, sem abrir conexão.
- Query exatamente na forma canônica que a ponte reescreve, na mesma ordem:
  - `acao=listar&brand=<fish|aristo>&channel=email&offset=<0–100000>&limit=<1–20>`
  - `acao=historico&brand=<fish|aristo>&draft_id=<[A-Za-z0-9_-]{1,64}>`
  - `acao=submissao&brand=<fish|aristo>&submission_id=<[A-Za-z0-9_-]{1,64}>`
  Marca ausente/`todas`/`olivas`, canal ≠ email, histórico por `key`, campo extra, repetido ou fora de ordem, ação de escrita → 400 sem abrir conexão. Query acima de 512 bytes → 414.
- Cobertura: só e-mail registrado em `shrigma_template_email_registry` da marca pedida (`coverage:'registered_email_only'`). WhatsApp e templates sem registro ficam fora.

## Leitura sem efeito

Cada pedido usa uma conexão exclusiva do pool, `BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY`, `statement_timeout` 8 s e `lock_timeout` 500 ms. Confere que o papel é exatamente `crm_template_reader` e que a transação é READ ONLY; só executa uma das três funções STABLE `crm_template_read.listar|historico|submissao` (allowlist fixa); exige `txid_current_if_assigned() IS NULL` e termina sempre em `ROLLBACK`. Não chama Listmonk nem Meta (`provider_polled:false`), não grava recibo, contador ou último uso. Erro, prazo ou cancelamento descartam a conexão.

**Vaga e prazo.** No máximo quatro operações vivas. A admissão é conferida antes de `pool.connect` (excedente → 503 `TEMPLATE_READ_BUSY`, sem fila). Quando o prazo vence, o pedido recebe 503 na hora, mas a vaga HTTP e a da transação só voltam quando a conexão é devolvida ou descartada — a operação abandonada nunca abre espaço para uma quinta. Logo depois de obter a conexão, e entre cada passo, o cancelamento é conferido: operação já vencida não executa `BEGIN`, `SET` nem identidade e descarta a conexão. A parada espera essas operações terminarem.

**Admissão do catálogo (preparo para ON).** Em cada pedido, antes da leitura, o listener lê `pg_catalog` e exige exatamente as funções revisadas: `crm_template_read.listar|historico|submissao|principal` e `public.shrigma_panel_operator_v1` com o md5 do corpo dos arquivos versionados, dono `postgres`, SECURITY DEFINER (só as do schema), STABLE, `search_path` fixo e EXECUTE só nas três leituras para o papel. Qualquer diferença (corpo trocado, dono, volatilidade, search_path, função extra ou EXECUTE a mais) → 503 `TEMPLATE_READ_NOT_READY` sem chamar a leitura. Nada global (TLS, HBA, PUBLIC) é alterado. Antes de ligar, conferir em leitura que o md5 de `shrigma_panel_operator_v1` em produção é o do arquivo versionado `n8n/access/panel-short-keys.sql`; se for outro, o listener fica em NOT_READY até revisão.

Autorização a cada pedido, no SQL: principal `panel:dcrm-<32 hex>` ativo, não revogado e não expirado, com a capacidade da ação (`read_content`, `list_history`, `submission`). Chaves legadas não leem. Revogação ou expiração confirmadas por outra sessão valem no pedido seguinte.

Respostas: 401 credencial inválida/revogada/expirada; 403 sem a capacidade; 404 rascunho/submissão de outra marca, Olivas ou inexistente (sem distinção); 400 pedido fora do contrato; 502 `TEMPLATE_READ_RESPONSE_DENIED` quando a saída não passa na validação; 503 desligado, ocupado, prazo, catálogo não admitido ou banco indisponível. Antes de sair, o corpo passa pela **mesma** `responseShape` da ponte (item de outra marca, sem marca, fora de ordem, paginação incoerente, `schedule_proof`/`provider_polled` ≠ false recusam a página inteira) e respeita o teto de 8 MiB da ponte.

**Eco da credencial.** Toda string e toda chave do corpo, depois do parse, é conferida contra a credencial do pedido: em texto (qualquer caixa), após decodificar percent (`%XX`, inclusive duplo) e entidades HTML (`&#..;`), e em todo trecho base64/base64url de 16+ caracteres nos quatro alinhamentos, contra o texto da chave e contra os seus 32 bytes; decodificações encadeadas até 3 níveis. Qualquer acerto recusa a página inteira (502), sem devolver nada do corpo.

## Configuração e recursos

| Variável | Valor |
|---|---|
| `CRM_TEMPLATE_READ_ENABLED` | `false` (padrão) ou `true`; qualquer outro valor impede a subida |
| `CRM_TEMPLATE_READ_REVISION` | SHA Git completo (40 hex) |
| `CRM_PG_HOST`, `CRM_PG_PASSWORD` | só lidos quando ligado; segredo provisionado fora do Git |
| `CRM_PG_USER` / `CRM_PG_DATABASE` | exatamente `crm_template_reader` / `listmonk` |

Desligado, o serviço não lê variável de banco, não carrega o driver `pg`, não cria pool: `/healthz` responde 200 com `enabled:false` e `/template-read` responde 503 antes de olhar credencial ou query.

Limites revisáveis: porta 8080; pool máximo 4 (o papel tem `CONNECTION LIMIT 4`); no máximo 4 pedidos simultâneos, sem fila nem retry (excedente → 503); prazo de 9 s por leitura e 10 s por requisição; `requestTimeout` 15 s; cabeçalhos até 8 KiB; uma requisição por socket. Sugestão de réplica: 1, 0,25 vCPU, 128–192 MiB.

`GET /healthz` mostra só serviço, contrato, revisão, ligado/desligado e parada em curso. Não testa banco nem credencial. A parada (`SIGTERM`) recusa novos pedidos, espera os em curso e encerra o pool.

## Imagem

`Dockerfile` (contexto = raiz do repositório): `node:22-bookworm-slim` fixado por digest; `--build-arg CRM_TEMPLATE_READ_REVISION=<SHA de 40 hex>` **obrigatório** e validado antes de qualquer outro passo; a revisão vai para `LABEL org.opencontainers.image.revision` e para `ENV CRM_TEMPLATE_READ_REVISION`, com `ENV CRM_TEMPLATE_READ_ENABLED=false` — o contêiner sobe OFF sem nenhuma variável externa. `npm ci --omit=dev` do `package-lock.json` (`pg@8.13.1`, mesma árvore do `crm-audience`); `COPY` literal de cada módulo (sem glob) e da ponte `crm-template-read-bridge.cjs`, para que a validação de saída seja a mesma do BFF; usuário `node` (UID 1000); `HEALTHCHECK` em `/healthz`. Nenhum segredo na imagem.

```
docker build --build-arg CRM_TEMPLATE_READ_REVISION=$(git rev-parse HEAD) \
  -f services/crm-template-read/Dockerfile -t crm-template-read:<rev> .
```

## Provas

- `tests/claude-template-read-listener-lease.test.cjs`: consulta presa + cinco pedidos (quatro 503 seguram as quatro vagas, o quinto é BUSY sem `pool.connect`, liberada a consulta tudo é desfeito e volta a 200); abort logo após obter a conexão; parada espera a operação abandonada.
- `tests/claude-template-read-listener-echo.test.cjs`: credencial em base64/base64url (texto e bytes, embutida em qualquer alinhamento, data URI), percent (maiúsculo, minúsculo, parcial, duplo, cruzado com base64), entidades HTML, caixa e nome; controle com base64/percent de outros textos.
- `tests/claude-template-read-listener-attest.test.cjs`: pins = md5 dos corpos nos arquivos; corpo trocado, SECURITY INVOKER, search_path, VOLATILE, EXECUTE a mais, função extra e dono diferente → NOT_READY sem leitura.
- `tests/claude-template-read-listener-image.test.cjs`: Dockerfile (digest, ARG sem padrão validado, LABEL/ENV, COPY literal completo, sem segredo) e imagem emulada que sobe OFF só com o ENV declarado.
- `tests/claude-template-read-listener.test.cjs` (PGlite + SQL proposto): OFF sem pool/segredo/driver; pedido canônico e recusas sem conexão; cadeia ponte → listener → SQL nas duas marcas com paginação, histórico e submissão; revogação, expiração e capacidade; validação de saída (outra marca, eco da chave em qualquer caixa, prova alegada, corpo grande); prazo, cancelamento, allowlist e papel.
- `tests/claude-template-read-listener-pg17-postgres.cjs` (PostgreSQL 17.10 descartável, `tools/claude-native-proofs/run-pg17.sh`): pool `pg` real, duas marcas pela ponte real, quatro leituras paralelas, zero efeito (linhas/xmin/xmax), leitura sob bloqueio de linha de outra sessão, bloqueio exclusivo de tabela → 503 em ~500 ms e volta a 200, revogação/expiração vistas por outra sessão, corpo de `listar` trocado por outra sessão → NOT_READY e volta a 200, prazo de 150 ms com tabela bloqueada (quatro 503 seguram as quatro conexões até o `lock_timeout`, quinto BUSY sem conexão nova, depois 200), papel sem acesso a tabela, nenhuma conexão sobrando e nenhuma chamada HTTP fora de 127.0.0.1.
- Imagem construída localmente com Docker 29.8 a partir de uma cópia do Dockerfile em que só o `RUN npm ci` foi trocado por `COPY node_modules` (instalado do mesmo lock fora do contêiner, porque o build não alcança o registro npm por trás do proxy desta máquina): LABEL e ENV com a revisão exata, usuário `node` (uid 1000), `/healthz` OFF com a revisão, `/template-read` 503, HEALTHCHECK `healthy`; revisão ausente ou inválida derruba o build.

Não provado aqui: o `npm ci` dentro do build OCI (fica na CI candidata), rede/host do Easypanel, instalação do SQL e dados reais.

## Ativação (fora deste PR, exige aprovação explícita de Felipe)

Ordem: revisão e CI → instalação revisada do SQL como owner (fresh-only; recusa colisão) → LOGIN/segredo do papel provisionados à parte → serviço publicado **OFF** e conferido por `/healthz` → ligar → BFF passa a anunciar `templates.read_contract` → aceite no portal real. Reversão: desligar a flag (o BFF deixa de anunciar e o painel volta aos pedidos de hoje); remoção do SQL conforme o rodapé de `crm-template-read-access.sql`.
