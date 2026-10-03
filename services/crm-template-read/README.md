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

Autorização a cada pedido, no SQL: principal `panel:dcrm-<32 hex>` ativo, não revogado e não expirado, com a capacidade da ação (`read_content`, `list_history`, `submission`). Chaves legadas não leem. Revogação ou expiração confirmadas por outra sessão valem no pedido seguinte.

Respostas: 401 credencial inválida/revogada/expirada; 403 sem a capacidade; 404 rascunho/submissão de outra marca, Olivas ou inexistente (sem distinção); 400 pedido fora do contrato; 502 `TEMPLATE_READ_RESPONSE_DENIED` quando a saída não passa na validação; 503 desligado, ocupado, prazo ou banco indisponível. Antes de sair, o corpo passa pela **mesma** `responseShape` da ponte (item de outra marca, sem marca, fora de ordem, paginação incoerente, `schedule_proof`/`provider_polled` ≠ false recusam a página inteira), não pode conter a credencial do pedido (qualquer caixa) e respeita o teto de 8 MiB da ponte.

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

`Dockerfile` (contexto = raiz do repositório): `node:22-bookworm-slim` fixado por digest, `npm ci --omit=dev` do `package-lock.json` (`pg@8.13.1`, mesma árvore do `crm-audience`), usuário `node`, `HEALTHCHECK` em `/healthz`. Copia também a ponte `crm-template-read-bridge.cjs`, para que a validação de saída seja a mesma do BFF. Nenhum segredo na imagem.

## Provas

- `tests/claude-template-read-listener.test.cjs` (PGlite + SQL proposto): OFF sem pool/segredo/driver; pedido canônico e recusas sem conexão; cadeia ponte → listener → SQL nas duas marcas com paginação, histórico e submissão; revogação, expiração e capacidade; validação de saída (outra marca, eco da chave em qualquer caixa, prova alegada, corpo grande); prazo, cancelamento, allowlist e papel.
- `tests/claude-template-read-listener-pg17-postgres.cjs` (PostgreSQL 17.10 descartável, `tools/claude-native-proofs/run-pg17.sh`): pool `pg` real, duas marcas pela ponte real, quatro leituras paralelas, zero efeito (linhas/xmin/xmax), leitura sob bloqueio de linha de outra sessão, bloqueio exclusivo de tabela → 503 em ~500 ms e volta a 200, revogação/expiração vistas por outra sessão, papel sem acesso a tabela, nenhuma conexão sobrando após a parada e nenhuma chamada HTTP fora de 127.0.0.1.

Não provado aqui: build da imagem OCI (o registro público recusou o pull do base nesta máquina; a construção fica na CI candidata), rede/host do Easypanel, instalação do SQL e dados reais.

## Ativação (fora deste PR, exige aprovação explícita de Felipe)

Ordem: revisão e CI → instalação revisada do SQL como owner (fresh-only; recusa colisão) → LOGIN/segredo do papel provisionados à parte → serviço publicado **OFF** e conferido por `/healthz` → ligar → BFF passa a anunciar `templates.read_contract` → aceite no portal real. Reversão: desligar a flag (o BFF deixa de anunciar e o painel volta aos pedidos de hoje); remoção do SQL conforme o rodapé de `crm-template-read-access.sql`.
