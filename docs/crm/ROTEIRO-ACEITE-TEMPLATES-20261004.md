# Roteiro de aceite — leitura de templates por marca (`crm-template-read-v1`) — 04/10/2026

Escopo: só a **leitura** da biblioteca de templates de e-mail no portal (listar por marca, prévia, histórico de rascunho, estado de submissão). Nada de criar, publicar, enviar ou agendar. Peças:

| Peça | Onde | Estado hoje |
|---|---|---|
| SQL somente leitura `n8n/growth/crm-template-read-access.sql` | #219 | não executado em banco real |
| Listener `services/crm-template-read` | #222 | OFF, fora do portal |
| Ponte do portal `crm-template-read-bridge.cjs` | #219 → candidata #214 | OFF |
| Front por marca (`templates.read_contract`) | #221 → candidata #214 | OFF por capability |
| BFF anunciando a capability, host e LOGIN do papel | Codex | não feito |

Portal: V24 em `f58dfa7` / digest `9d25e5d9`. A candidata #214 (`9241ff9`) **não está instalada**. Por isso, hoje, nenhum passo abaixo pode ser validado no portal real.

## Status (três níveis, sem mistura)

| Nível | Significa | Não significa |
|---|---|---|
| **Preparado** | Código ou procedimento revisado existe, desligado/não instalado. O passo diz onde. | Que roda ou que está no portal. |
| **Testado em isolamento** | Teste automatizado com dado sintético passou (PGlite, PostgreSQL 17.10 descartável em loopback, HTTP local, imagem local). Arquivo › teste citado. | Dado real, login humano, rede do Easypanel. CI verde ou deploy aceito também não contam. |
| **Validado no portal real** | Felipe ou o analista executou o passo à mão no portal com evidência (print + horário em Brasília + revisão/digest conferidos). | — |

**Hoje: nenhum passo validado no portal real.**

## Regras

- Sem envio, agendamento, publicação ou edição de template real. Este roteiro só lê.
- SQL, LOGIN do papel, publicação do listener, ligar flag e anunciar capability: cada um só com aprovação explícita de Felipe **para aquele passo**, na ordem abaixo. Nenhum passo pula o anterior.
- Evidência sem conteúdo sensível: nada de credencial, cookie, chave, e-mail de cliente ou corpo de template inteiro no registro (print da lista basta).
- Resultado inesperado de leitura → anotar e seguir. Isolamento quebrado (template de outra marca visível, leitura sem marca, escrita aceita) → parar, desligar a flag (R1) e avisar o Codex.

---

## Fase A — antes de qualquer instalação (CI, imagem, conferência)

### A1. Revisão e CI da #222
- **Preparado:** sim (#222).
- **Testado em isolamento:** sim — `tests/claude-template-read-listener*.test.cjs` (17 casos: lease/prazo, eco codificado, admissão do catálogo, imagem, contrato) e `tools/claude-native-proofs/run-pg17.sh` (PostgreSQL 17.10, 3/3 PASS).
- **Validado no portal real:** não se aplica (passo de código).
- **Esperado:** CI verde no head da #222 e revisão do Codex sem bloqueador.

### A2. Imagem OCI com revisão exata
- **Ação (Codex, CI candidata):** `docker build --build-arg CRM_TEMPLATE_READ_REVISION=<SHA> -f services/crm-template-read/Dockerfile .`
- **Esperado:** `LABEL org.opencontainers.image.revision` = SHA; contêiner sem nenhuma variável sobe OFF; `/healthz` mostra a mesma revisão; revisão ausente/inválida derruba o build.
- **Preparado:** sim. **Testado em isolamento:** sim — `claude-template-read-listener-image.test.cjs` e build local com Docker 29.8 (só o `npm ci` trocado por `node_modules` do mesmo lock; ver README). **Validado no portal real:** não.

### A3. Conferência somente leitura do banco (antes do SQL)
- **Ação (Codex, leitura, sem escrita):** confirmar que não existem `crm_template_reader` nem o schema `crm_template_read`; que existem as tabelas e a função de dependência do instalador; e o md5 do corpo de `public.shrigma_panel_operator_v1` (`SELECT md5(prosrc) FROM pg_proc WHERE oid='public.shrigma_panel_operator_v1(text,text)'::regprocedure`).
- **Esperado:** md5 = `2092629644f901de260051084d2fb2c2` (corpo de `n8n/access/panel-short-keys.sql`). Se for outro, o listener ficará em `TEMPLATE_READ_NOT_READY`: parar e revisar antes de instalar.
- **Preparado:** sim (consultas no rodapé do SQL e neste passo). **Testado em isolamento:** sim — `claude-template-read-listener-attest.test.cjs` › "pins do listener = md5 dos corpos nos próprios arquivos SQL versionados". **Validado no portal real:** não.

## Fase B — instalação (cada passo com aprovação de Felipe)

### B1. Instalar o SQL
- **Ação:** executar `crm-template-read-access.sql` como `postgres` em `listmonk`, numa transação revisada. É aditivo e recusa instalar sobre nomes existentes.
- **Esperado:** as três conferências do rodapé do SQL devolvem zero linhas (nenhum privilégio de tabela; só as três funções executáveis; sem associação a papéis).
- **Preparado:** sim. **Testado em isolamento:** sim — `claude-template-read-pg16-postgres.cjs` em 16.15 e 17.10 (reinstalação recusada, papel só com três funções, zero efeito, revogação vista por outra sessão). **Validado no portal real:** não.

### B2. LOGIN e segredo do papel
- **Ação (Codex, canal privado):** `LOGIN` + senha de `crm_template_reader` provisionados fora do Git; host PostgreSQL fixo admitido.
- **Preparado:** procedimento descrito. **Testado em isolamento:** LOGIN só em cluster descartável (`claude-template-read-listener-pg17-postgres.cjs`). **Validado no portal real:** não.

### B3. Publicar o listener **desligado**
- **Ação (Codex, Easypanel):** serviço com a imagem de A2, `CRM_TEMPLATE_READ_ENABLED=false`, 1 réplica.
- **Esperado:** `/healthz` 200 `{"enabled":false,"revision":<SHA>}`; `/template-read` 503 `TEMPLATE_READ_DISABLED`; nenhuma conexão do papel no banco.
- **Preparado:** sim. **Testado em isolamento:** sim — `claude-template-read-listener.test.cjs` › "OFF: sobe sem variável de banco, sem pool e sem carregar o driver"; imagem local. **Validado no portal real:** não.

### B4. Ligar o listener, ainda sem o portal anunciar
- **Ação:** `CRM_TEMPLATE_READ_ENABLED=true` + variáveis de banco de B2.
- **Esperado:** `/healthz` `enabled:true`; no máximo 4 conexões do papel; sem pedido do portal, nenhuma leitura acontece. O painel continua igual ao de hoje (capability ainda não anunciada).
- **Preparado:** sim. **Testado em isolamento:** sim — PG17.10 (`connections_after_stop:0`, `parallel_reads:4`). **Validado no portal real:** não.

### B5. BFF anuncia `templates.read_contract='crm-template-read-v1'`
- **Ação (Codex):** ponte ligada com o destino fixo e o principal `crm-panel-read`; candidata instalada no portal.
- **Preparado:** ponte e front OFF na candidata. **Testado em isolamento:** sim — `claude-template-read-bridge.test.cjs`, `claude-front-read-brand.test.cjs` (OFF: pedidos byte a byte iguais aos de hoje). **Validado no portal real:** não.

## Fase C — aceite no portal (à mão, gestor individual de teste)

Pré-condição: B1–B5 concluídos; gestor individual com `read_content`, `list_history` e `submission`. Para C6, um segundo gestor só com `read_content`.

| Passo | Ação no portal | Esperado | Preparado | Testado em isolamento | Validado no portal real |
|---|---|---|---|---|---|
| C1 | Templates › Carregar conteúdo em **Fishermans** | Só templates de e-mail registrados da Fishermans; nenhum da O Aristocrata, Olivas ou sem registro | sim | sim — `claude-template-read-listener.test.cjs` › "cadeia ponte → listener → SQL nas duas marcas"; PG17.10 `brands:[fish,aristo]` | não |
| C2 | Mesmo em **O Aristocrata** | Só os da O Aristocrata | sim | sim — idem | não |
| C3 | Marca com mais de 20 templates: rolar/página seguinte | Páginas de 20 sem repetir nem pular; total coerente | sim | sim — paginação `offset/limit` (PGlite e PG17.10) | não |
| C4 | Abrir prévia de um template | Assunto e corpo do próprio template; corpo acima de 400 000 caracteres aparece como "conteúdo indisponível", sem cortar | sim | sim — `claude-template-read-store.test.cjs` (corpo grande `content_available:false`) | não |
| C5 | Histórico de um rascunho da marca; submissão de um rascunho da marca | Eventos e estado gravado; `provider_polled:false` (nada consulta Meta/Listmonk) | sim | sim — histórico/submissão nas duas marcas; `non_loopback_http_calls:0` | não |
| C6 | Gestor só com `read_content` abre histórico | Histórico indisponível; conteúdo continua | sim | sim — `claude-template-read-listener.test.cjs` › "revogação, expiração, chave sem capacidade e chaves legadas" (403) | não |
| C7 | Trocar marca A→B→A com leitura em curso | Nada de uma marca aparece na outra; volta a A com os dados de A | sim | sim — `claude-front-read-brand.test.cjs` | não |
| C8 | "Todas as marcas", WhatsApp, histórico por template publicado | Leitura não dispara; mensagem "Nada foi consultado" | sim | sim — `claude-front-read-brand.test.cjs` › "marca todas/olivas/ausente, canal WhatsApp e histórico por key não disparam leitura"; listener 400 sem conexão | não |
| C9 | Revogar o gestor de teste e recarregar | Leitura negada na hora; nenhum dado depois | sim | sim — PG17.10 `revocation_expiry_two_sessions:true` | não |

Evidência por passo: print com o seletor de marca visível + horário em Brasília + revisão do listener (`/healthz`, conferida pelo Codex).

## Reversão

- **R1 (imediata):** desligar `CRM_TEMPLATE_READ_ENABLED` → `/template-read` 503; o BFF deixa de anunciar a capability e o painel volta aos pedidos de hoje (provado byte a byte em `claude-front-read-brand.test.cjs`).
- **R2 (remoção, com aprovação):** rodapé de `crm-template-read-access.sql` (`DROP SCHEMA crm_template_read CASCADE; DROP OWNED BY crm_template_reader; DROP ROLE crm_template_reader;`) com o listener parado e sem conexões.

## O que este roteiro não prova

- WhatsApp publicado e histórico por template publicado (sem marca nos dados versionados).
- Qualquer escrita: criar, editar, publicar ou enviar template.
- Comportamento com volume real de templates; os testes usam fixture sintética.

## Resumo

| Passo | Preparado | Testado em isolamento | Validado no portal real |
|---|---|---|---|
| A1 CI/revisão #222 | sim | sim | não se aplica |
| A2 Imagem com revisão | sim | sim (local, `npm ci` fora do contêiner) | não |
| A3 Conferência do banco | sim | sim (pins) | não |
| B1 SQL | sim | sim (16.15/17.10) | não |
| B2 LOGIN/segredo | procedimento | só em cluster descartável | não |
| B3 Listener OFF | sim | sim | não |
| B4 Listener ON | sim | sim (17.10) | não |
| B5 BFF anuncia | sim (OFF na candidata) | sim | não |
| C1–C9 Aceite no portal | sim | sim | **não** |
