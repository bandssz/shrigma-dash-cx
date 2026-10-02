# Contratos HTTP para o dashboard operacional — 30/09/2026

Auditoria dos contratos de origem a partir do commit `257a9ec6a7b697445c567da2b30afea18a3e0c17`, no worktree exclusivo `dashboard-operational-20260930`. A branch também incorporou a melhoria publicada de Influs em `e180f4ca484efa9a3fc8ba430b3a714e5ecbb907`, que acrescenta o KPI de clientes novos ao frontend e não libera novas ações no gateway. Esta **auditoria de contratos** não executou chamadas autenticadas, operações de escrita, SQL ou migrações. Configurações privadas, credenciais, hashes de acessos reais e conteúdos de clientes não foram copiados. A instalação sintética posterior está registrada no plano operacional, separado deste inventário de contratos.

## Conclusão e limites da evidência

### Verificação do catálogo PostgreSQL ativo

Em 30/09/2026, a descoberta de procedimentos do MCP do Easypanel para consulta SQL, metadados de tabelas, constraints e funções retornou apenas inspeção de **configuração/status** do serviço PostgreSQL (`inspectPostgresService`), lista de bancos (`getServiceDatabases`) e consultas de logs. Nenhum procedimento de consulta SQL ou catálogo foi disponibilizado. A listagem geral de projetos e serviços excedeu o limite de resposta de 262144 bytes do MCP; não foi usada para inferir o esquema. Não houve acesso a linhas de `crm_dash_chave`, `shrigma_panel_permission_v1` ou às definições ativas das funções.

Assim, **colunas, índices, constraints, grants e versões das funções no banco ativo não estão verificados**. Os arquivos `n8n/access/panel-auth.sql`, `panel-short-keys.sql` e `panel-operator.sql` mostram a intenção versionada: hash SHA-256 e validade na tabela de chaves; permissão por `principal_id` e `area` (`growth`/`influs`), `caps` JSON array e chave primária composta; funções de autenticação e operador. Sua presença no Git não comprova que os patches foram aplicados no PostgreSQL atual. Antes de provisionar gestores ou habilitar escrita, um operador de banco deve conferir **somente metadados** via `pg_catalog`/`information_schema` em sessão de leitura, sem selecionar valores de chaves, hashes ou dados pessoais; comparar assinaturas e grants efetivos; e registrar o resultado sem segredos. Até lá, o gateway deve manter as ações de escrita fechadas.

O frontend tem contratos suficientes para um gateway na mesma origem, mas não existe um único transporte de autenticação. Há Bearer em cabeçalho, chaves em corpo JSON e cabeçalhos legados específicos. `POST` também transporta leituras. A decisão deve usar a combinação exata de rota, método, seletor (`acao`, `action` ou `method`), campos e permissão; liberar todos os GET ou todos os POST de uma família seria incorreto.

**Nenhuma escrita comercial foi confirmada segura para um teste conectado à produção.** Salvar dados, criar preparações, aprovar modelos, aprovar parceiros, agendar campanhas, testar e-mail e decidir amostras têm efeitos reais ou alteram condições de trabalhos já existentes. A instalação sintética paralela continua sendo a evidência apropriada para testar escrita negada sem duplicar ações.

Mesmo algumas consultas fazem escrita técnica: `shrigma_panel_auth_v1` atualiza `crm_dash_chave.ultimo_uso` e incrementa `usos` quando autentica. Portanto, GET de identidade, CX e cache que chamem essa função não satisfazem uma promessa literal de zero escrita em banco. Não enviam comunicação comercial por esse motivo, mas a telemetria precisa ser considerada antes de conectar a instalação operacional a credenciais reais. Fonte: `n8n/access/panel-auth.sql:6`.

Os contratos abaixo são os implementados no checkout. Os fontes de patches descrevem mudanças possíveis e históricas; sua presença não comprova a versão ativa do workflow remoto, grants atuais, flag de envio, política de destinatários ou ausência de deriva. Consultas operacionais posteriores devem comparar a configuração ativa sem exportar credenciais. “Deploy aceito” ou capability anunciada não substitui recibo e validação da operação.

Atualização de 01/10/2026: a configuração de `crm-audience` e `crm-campaign` informa a revisão de fonte `03a02b4c98f471e6739c8a7cbe46e49aa4cbf285`, com flags de público (binding, regular, A/B e ciclo de grafos) e mídia de campanhas ativas. Essa revisão e o merge `6cf7d09eb5db4616d88eb0bd524b1d84418f8854`, fixado no manifesto do gateway, têm a mesma árvore Git `4d5cfcde60596a70b3a18f4ce389628af74331f6`; os arquivos de origem pinados têm checksums idênticos. A diferença de IDs de commit, isoladamente, não exige reconstruir as rotas já revisadas. A configuração ativa, porém, não comprova grants no PostgreSQL nem o mapping externo de `<campaign path>/media`; a biblioteca integrada continua fechada para dados reais até essa verificação.

Legenda: **L** = consulta de negócio; **P** = preparação, renderização, avaliação ou contagem que exige análise própria de efeito/custo; **W** = altera estado; **E** = pode enviar, criar cupom comercial, decidir amostra ou liberar execução futura. L não garante ausência da telemetria de autenticação descrita acima. A coluna de autenticação descreve o transporte atual do cliente até o backend, não um segredo a publicar no navegador.

## Endpoints fixos e rotas propostas

Os valores exatos dos webhooks já públicos estão nas constantes indicadas. Os sufixos opacos não são credenciais e não devem ser usados como autorização. O gateway deve resolver um mapa fixo no servidor; não aceitar uma URL arbitrária do navegador.

| Rota local sugerida | Endpoint de origem / definição fixa | Área | Fonte |
| --- | --- | --- | --- |
| `/api/cx` | `CX_API_URL`, host `n8n-n8n.tazdb8.easypanel.host`, webhook `cx-dash-api-*` | Identidade e dados CX/Growth/Orgânico/Influs | `config.js`, `panel-entry.js:41`, `app.js:101`, `area-view.js` |
| `/api/cache` | `CX_CACHE_URL`, mesmo host n8n, webhook `cx-dash-cache-*` | Cache dos painéis | `config.js`, `organico.html:600`, `app.js` |
| `/api/crm-read` | `CRM_READ_API_URL`: `https://comunicacao-crm-panel-read.tazdb8.easypanel.host/read` | CRM / Growth | `crm-read-config.js`, `crm-entry.js:46`, `growth.html:868` |
| `/api/ab` | `AB_API_URL`, mesmo host n8n, webhook `crm-teste-api-*` | Registro A/B CRM legado | `config.js`, `growth-ab-server.js:30` |
| `/api/influ` | `INFLU_API_URL`, mesmo host n8n, webhook `crm-influ-api-*` | Influenciadores / Creators | `config.js`, `influs.html:486`, `creators-pilot-ui.js:21` |
| `/api/tts` | `TTS_API_URL`, mesmo host n8n, webhook `tts-painel-api-*` | TikTok Shop, dentro de Influs | `config.js`, `influs-tts.js:586` |
| `/api/tts-action` | `TTS_ACAO_URL`, mesmo host n8n, webhook `tts-acao-api-*` | Decisão manual e regras TikTok | `config.js`, `influs-tts-manual.js`, `influs-tts.js:501` |
| `/api/organico-links` | `ORGANICO_LINKS_URL`, mesmo host n8n, webhook `organico-links-utm-*` | Links UTM Orgânico | `organico.html:558`, `organico-links.js:34` |
| `/api/tts-cobranca` | `TTS_COBRANCA_URL`, mesmo host n8n, webhook `tts-cobranca-painel-*` | Cobrança / produtos TikTok | `influs.html:264`, `tts-cobranca.js:29` |
| `/api/candidaturas` | `CANDIDATURA_URL`, mesmo host n8n, webhook `parceiros-candidatura-*` | Candidaturas Creators | `influs.html:1223`, `partner-candidaturas.js:26` |
| `/api/aprovacao` | `APROVACAO_URL`, mesmo host n8n, webhook `parceiros-aprovacao-*` | Aprovação / envio / encerramento Creators | `influs.html:1224`, `partner-candidaturas.js:31` |
| `/api/escopo` | `ESCOPO_URL`, mesmo host n8n, webhook `influs-escopo-*` | Contratos e conteúdos de Creators | `influs.html:1230`, `influ-escopo.js:19` |

Na implantação, a configuração privada do gateway deve coincidir com as URLs integrais fixadas em `services/dashboard-operational/proxy.cjs`; um caminho diferente no mesmo host recusa a inicialização. Não copiar parâmetros `k`, cabeçalhos de autenticação ou valores de credenciais para configuração pública, imagem, logs, Markdown ou respostas.

## Endpoints dinâmicos CRM

Estes endereços vêm de `API.capabilities.endpoints` no payload Growth. Sua ausência deve desabilitar a função correspondente. Um endereço anunciado não autoriza uma nova origem nem uma nova rota no gateway.

| Rota local sugerida | Campo recebido | Família backend esperada | Fonte / validação |
| --- | --- | --- | --- |
| `/api/templates` | `endpoints.templates`; fallback opcional global `TEMPLATE_API_URL` | API n8n de templates, e-mail, testes e builder de jornadas | `growth-templates-api.js:27`, `growth-builder.js:30`; endpoint e capabilities obrigatórios |
| `/api/campaigns` | `endpoints.campaigns` | `crm-campaign`, via alias n8n publicado no caminho fixo de `services/crm-campaign/server.cjs:6` | `growth-campaign-api.js`; contrato `crm-campaign-v1`, marcas `fish` / `aristo` |
| Sub-rota de mídia de campanhas | Derivada de `endpoints.campaigns` com sufixo `/media`, não anunciada separadamente | `crm-campaign`, `<campaign path>/media` | `growth-media.js`, `services/crm-campaign/server.cjs`; GET de biblioteca requer `read_content`, POST de upload requer `edit_content`. GET anônimo na rota pública retornou 401 e revisão do backend, comprovando o encaminhamento; credencial individual, grant e GET autenticado ainda não foram comprovados. |
| `/api/segments` | `endpoints.segments` | `crm-audience`, `/segments` | `growth-segment-client.js`; contrato e marcas conferidos |
| `/api/campaign-audience` | `endpoints.campaign_audience` | `crm-audience`, `/campaign-audience` | `growth-campaign-audience-client.js`, `growth-campaign-regular-client.js` |
| `/api/ab-experiment` | `endpoints.ab_experiment` | `crm-audience`, `/ab-experiments`, ou endpoint legado explicitamente conferido | `growth-ab-experiment-client.js`, `growth-ab-experiment-panel.js`; modo muda o transporte de autenticação |
| `/api/journey-graph` | `endpoints.journey_graph` | API de rascunhos em grafo | `growth-journey-graph-api.js`, `growth-journey-graph-ui.js` |
| `/api/journey-graph-lifecycle` | `endpoints.journey_graph_lifecycle` | `crm-audience`, `/journey-graph-lifecycle` | `growth-journey-graph-api.js`; publicação deve permanecer pausada |

Vários clientes usam `new URL(endpoint)` sem base e exigem HTTPS, sem usuário/senha, query ou fragmento. O gateway precisa devolver **URLs absolutas HTTPS da sua própria origem**, como `https://<host-autorizado>/api/segments`, em todos os campos anunciados. Substituir por apenas `/api/segments` quebra esses clientes. Origem deve vir de configuração confiável; não refletir `Host` / forwarded headers arbitrários. Endpoints externos desconhecidos devem ser removidos e capacidades associadas desabilitadas, sem proxy genérico.

Nesta revisão, `campaigns`, `segments`, `campaign_audience`, `ab_experiment` e `journey_graph_lifecycle` têm destinos candidatos exatos no manifesto de código e exigem revisão do serviço ativo antes de receber credenciais. O alias publicado da rota **base** de campanhas foi confirmado por leitura no Easypanel; a sub-rota `/media` permanece sem comprovação de mapping. `templates` e `journey_graph` não têm destino aprovado e falham fechado; a opção de endpoint legado de AB também não foi liberada. Um novo commit que mude o conteúdo dos arquivos CRM pinados exigirá nova revisão, mesmo que a etiqueta de revisão ativa permaneça igual.

## Contratos de identidade e consultas comuns

| Rota | Método e seletor | Classe | Autenticação atual | Escopo / campos essenciais |
| --- | --- | --- | --- | --- |
| cx | GET `access=1&painel=<área>` | L + telemetria de acesso | `Authorization: Bearer …` | Identidade `shrigma_access_identity_v1`; mestre (`panel=todos`) ou gestor de uma área. Painéis permitidos vêm do servidor. |
| cx | GET `painel=cx/growth/organico/influs` | L + telemetria de acesso | Bearer | Payload precisa confirmar `_escopo` / painel. Diagnóstico Growth auxiliar ainda usa essa leitura, não `crm-read`. |
| cache | GET `painel=<área>` | L + telemetria de acesso | Bearer | Cache; não tratar resposta antiga como integração atual. Orgânico pode recorrer a cx se cache indisponível. |
| crm-read | GET `action=identity&painel=growth` | L + telemetria de acesso | Bearer obrigatório; sem `k` | Exatamente dois campos; inclui `permissions.growth` e `permissions.influs` quando presentes. |
| crm-read | GET `action=cache_growth&painel=growth` | L + telemetria de acesso | Bearer obrigatório; sem `k` | Exatamente dois campos. Frontend principal recusa cache Growth com mais de 20 min; não inicia coleta custosa como fallback. |

Fontes: `panel-entry.js`, `crm-entry.js`, `growth-view.js`, `area-view.js`, `growth.html:851`, `growth-diagnostic-ui.js:36`, `services/crm-panel-read/server.cjs`, `n8n/growth/crm-read-fast.sql`. A origem do iframe deve coincidir com a origem do pai no handshake `shrigma:read-access`; credenciais em URL entre subdomínios não são um mecanismo válido de compartilhamento de sessão.

Há uma diferença a conferir no cache: o frontend Orgânico consulta `painel=organico`, mas o helper histórico `requestAccess(input,'cache')` em `panel-auth-patch.cjs:10` fixa o pedido de autenticação em `cx`. A presença do parâmetro na interface não comprova suporte do cache ativo a um gestor Orgânico. Preservar o fallback previsto e conferir a versão ativa antes de liberar a rota por área; não ampliar autorização no backend para fazer o teste passar.

## CRM / Growth: contratos completos de transporte

| Família | Método e ação exata | Classe | Transporte atual de credencial | Efeito / permissão que o gateway deve preservar |
| --- | --- | --- | --- | --- |
| campaigns | GET `acao=campanha_catalogo`, `campanha_listar`, `campanha_obter`, `campanha_operacao` | L | Bearer; legado GET `k` apenas se não houver cabeçalho | `brand`, IDs e operação limitados ao escopo. Origem e campos validados pelo serviço. |
| campaigns `/media` | GET `brand`, paginação ou consulta de uma tentativa por `operation_id`/`filename`/`sha256` | L + telemetria de acesso | Bearer obrigatório | Biblioteca de imagens Listmonk, com `read_content`; só a listagem paginada é candidata à primeira ponte de leitura. A flag ativa não comprova a publicação da sub-rota nem seus grants. |
| campaigns `/media` | POST multipart de imagem | W | Bearer obrigatório | Upload real para Listmonk com `edit_content`; permanece bloqueado no gateway paralelo. Não exercitar contra serviço real no ensaio de hospedagem. |
| campaigns | POST `acao=campanha_salvar` | W | `body.k`; cliente não manda Bearer no POST | Persiste campanha/material no Listmonk. `expected_version` + `idempotency_key`; sem retry automático. |
| campaigns | POST `acao=campanha_validar` | P/W | `body.k` | Valida versão/material; não assumir função pura nem liberar no teste. |
| campaigns | POST `acao=campanha_agendar`, `campanha_cancelar`, `campanha_recuperar` | W/E | `body.k` | Agendamento altera envio real; cancelar/recuperar muda estado real. Confirmação, versão e recibo são obrigatórios. |
| segments | GET `acao=segmentos_listar`, `segmento_obter`, `segmento_operacao` | L | Bearer em todos | `read_content`; brand `fish/aristo`; paginação/ID e operação exatos. |
| segments | POST `acao=segmento_contar` | P | Bearer, sem `k` no corpo | `read_content`; contagem de público real / fonte externa, snapshot e catálogo. Fonte classifica como não mutação do segmento, mas custo e refresh de fonte impedem classificá-la como leitura trivial. |
| segments | POST `acao=segmento_criar`, `segmento_salvar`, `segmento_arquivar` | W | Bearer, sem `k` | `draft`; definição/pins, versão, idempotência. Contrato de segmento anuncia `send:false`, mas gravação é real. |
| campaign-audience | GET `acao=campanha_publico_obter`, `campanha_publico_operacao` | L | Bearer | Consulta binding/recibo por brand/campanha/operação; `read_content`. |
| campaign-audience | POST `acao=campanha_publico_conferir` | P | Bearer | Avalia intenção de vínculo; resposta expira em até 300 s. Pode atualizar catálogo/fonte; não incluir na liberação inicial de leituras. |
| campaign-audience | POST `acao=campanha_publico_validar` | P | Bearer | Exige `validate` e `read_content`; versão/hashes vinculados. Avaliação não equivale a autorização de envio. |
| campaign-audience | POST `acao=campanha_publico_vincular` | W | Bearer | `draft` + `read_content`; grava binding e altera campanha/versionamento. |
| campaign-audience | POST `acao=campanha_publico_preparar_envio` | P/W | Bearer | Grava review de admissão, expiração máxima 60 s; materializa público/material. |
| campaign-audience | POST `acao=campanha_publico_agendar` | W/E | Bearer | Requer `submit` além das guardas de validação; `confirm=agendar`, review, versões, hashes, idempotência. Agenda envio real. |
| campaign-audience | GET `acao=campanha_publico_agendamento_operacao` | L | Bearer | Consulta o mesmo recibo sem reaplicar agendamento. |
| ab (registro legado) | GET `acao=capacidades`, `registro`, `operacao` | L | `X-AB-Write-Key`, não Bearer | Acesso legado ou `crm_operator` conferido; registro/ator/operação devem coincidir. |
| ab (registro legado) | POST `acao=criar`, `encerrar` | W | `body.k` | Grava cadastro/conclusão A/B, com `operation_id` e versão. Não confundir registro com experimento que agenda braços. |
| ab-experiment | GET `method=capabilities`, `list`, `get`, `campaigns`, `operation` | L | Modo `saved-audience-v1`: Bearer. Legado: `X-AB-Write-Key` | Em `operation`, `action=prepare/review/schedule/cancel/close`, com brand/operation_id; não é comando executável via GET. |
| ab-experiment | POST `method=mutate`, `request_payload` com allocation (prepare), `action=review` / `review_saved` | P/W | Modo salvo: Bearer sem `body.k`; legado: `body.k` | Prepare exige `draft`; review exige `validate`; grava alocação/preparações. Backend de públicos salvos recusa `action=review` legado e usa seu contrato próprio. |
| ab-experiment | POST `method=mutate`, `request_payload.action=schedule/cancel/close` | W/E | Igual à linha anterior | Schedule/cancel exigem `submit`, close `draft`; confirmações `schedule_both` / `cancel_both` / `close_measurement`. Agendamento dos dois braços é real. |
| templates | GET `acao=listar`, `email_capacidades`, `historico`, `submissao` | L | Bearer | `read_content`, `list_history`, `submission`, conforme ação/capabilities; histórico por key/draft, submissão por ID. |
| templates | GET `acao=operacao` | L | `X-Template-Key`; Bearer adicional quando `bearerWrite=true` | Consulta de escrita pela mesma chave/ator e `idempotency_key` + `operacao`; não substituir pela credencial genérica de leitura. |
| templates | POST `acao=email_previa` | P | Bearer, sem `k` | Renderiza rascunho via contrato nativo. Não publica/envia pelo contrato do cliente; fonte remota/render deve estar controlada. |
| templates | POST `acao=rascunho`, `validar`, `submeter` | W / P/W / W/E | `body.k`, `Idempotency-Key`; e Bearer quando e-mail avançado (`bearerWrite=true`) | Respectivamente `draft`, `validate`, `submit`; submissão pode publicar template Meta ou e-mail Listmonk. Efeito futuro depende de uso em jornada existente. |
| templates (builder) | GET `acao=fluxos_listar`, `listar`, `fluxo_operacao` | L | Bearer | Mesmo endpoint templates; operação consultada com credencial do autor da tentativa. |
| templates (builder) | POST `acao=fluxo_salvar`, `fluxo_publicar`, `fluxo_estado` | W / W/E | `body.k`, não Bearer no cliente atual | Salva draft, publica versão, pausa/retoma jornada. `confirm=publicar/retomar/pausar`; próximos eventos podem enviar. Mensagens aceitas/em trânsito não são recolhidas. |
| templates (teste e-mail) | GET `acao=email_teste_capacidades_v2`, `email_teste_operacao`, `email_teste_operacao_v2`, `email_teste_testadores_v2` | L | Bearer | Gestor `panel:*` com `draft`, `validate`, `submit`; operação não reenvia. |
| templates (teste e-mail) | GET `acao=email_teste_previa` | P | Bearer | Prévia legada pode envolver preparação/render nativo. Não afirmar zero escrita sem comparar fluxo ativo. |
| templates (teste e-mail) | POST `acao=email_teste_previa_v2` | P/W | Bearer | Cria token de prévia no banco por destinatário/versão; TTL 300 s. |
| templates (teste e-mail) | POST `acao=email_teste_testador_v2` | W | Bearer | Altera permissão de destinatário de teste, por brand. |
| templates (teste e-mail) | POST `acao=email_teste`, `email_teste_v2` | W/E | Bearer | **Envia e-mail real** via infraestrutura existente. Legado usa destinatário fixo; v2 destinatário selecionado. Prefixo `[TESTE]` e quotas 5/revisão e 20/ator/hora não tornam o envio sintético. |
| journey-graph | GET `action=capabilities`, `catalog`, `list`, `get`, `operation` | L | Bearer | Brand e IDs; contrato `journey_graph_draft_api_v1`. Flags `authorizes_send/publish=false`. |
| journey-graph | POST `action=create`, `save` | W | Bearer, sem `k` | Draft/versionamento persistente; pausado e sem revisão publicada. Request UUID e versão, permissão explícita de draft. |
| journey-graph-lifecycle | GET `action=status`, `operation` | L | Bearer | `journey_graph_lifecycle_panel_v1`; recibo e revisão correspondentes. Desde #202, status também pode retornar `active`, em transação somente de leitura. |
| journey-graph-lifecycle | POST `action=review`, `prepare`, `publish` | P / P/W / W | Bearer | Review exige `read_content+validate`; prepare/publish `read_content+submit`. Prepare cria snapshot/release/recibo; publish publica **pausado**. Flags activate/enrollment/send false e pins operacionais continuam obrigatórios. Não é autorização para ligar esteira. |
| journey-graph-lifecycle | POST `action=activation_review` | P/W | Bearer | #202: grava review de ativação ligado a brand/jornada/versão/revisão/hash e request UUID; exige `read_content+validate`, com validade de até 30 s. Bloqueado no gateway paralelo. |
| journey-graph-lifecycle | GET `action=activation_operation` | L | Bearer | #202: consulta review/recibo pelo mesmo ator e request UUID, sem reaplicar comando; exige `read_content`. Não está na allowlist do gateway paralelo. |
| journey-graph-lifecycle | POST `action=activate` | W/E | Bearer | #202: exige `read_content+submit`, `confirm=ativar`, request UUID da review e hashes correspondentes; abre execução CART para novos eventos elegíveis, com possibilidade de envio real posterior. Bloqueado no gateway paralelo. |

Fontes principais: `campaign-contract.js:94`, `growth-campaign-api.js:37`, `services/crm-campaign/server.cjs:7`, `growth-segment-client.js:34`, `growth-campaign-audience-client.js:39`, `growth-campaign-regular-client.js:32`, `growth-ab-server.js:34`, `growth-ab-experiment-client.js:37`, `growth-templates-api.js:63`, `growth-builder.js:32`, `growth-email-test.js`, `growth-journey-graph-api.js:40`. Revalidações backend estão em `n8n/growth/segment-api.cjs`, `segment-audience-api.cjs`, `segment-campaign-binding.cjs`, `segment-regular-admission.cjs`, `ab-audience-panel-api.cjs`, `journey-graph-workflow.cjs` e `journey-graph-lifecycle-panel-api.cjs`.

Na interface de templates, `set_mode` e `activate` aparecem como capabilities declaradas em `growth-templates-api.js:34`, sem ação HTTP concreta correspondente nesse cliente. O cliente de graph passou a implementar as ações de ativação acima em #202 (`a3f7810`), pelo endpoint lifecycle existente; isso não exige novo arquivo público, origem, CSP ou rota no pacote paralelo. O BFF remove `graph_drafts`/`graph_lifecycle`, reduz `activate:true` a false e nega as três novas ações antes de qualquer fetch. Migrar a hospedagem não autoriza ativar workflows.

## Orgânico e Influs: contratos completos de transporte

| Família | Método e ação exata | Classe | Transporte atual de credencial | Efeito / escopo |
| --- | --- | --- | --- | --- |
| organico-links | POST `acao=listar` | L | `body.k`, sem Bearer | Links salvos; identidade válida `organico` ou `todos`. |
| organico-links | POST `acao=salvar`, `arquivar` | W | `body.k`, sem Bearer | Salva/arquiva URL UTM pública e atribuição analítica. SQL atual não exige uma capability de escrita separada. |
| influ | POST `acao=listar` | L | Bearer; cliente remove `k` do JSON | `ini/fim`, `pilot`, `conciliacao_pedidos`, `marca`. Retorno pode incluir candidatos, valores, termos e conciliação de pedidos reais. |
| influ | POST `acao=salvar_influ`, `salvar_cupom`, `salvar_custo` | W | `body.k` e `autor`; sem Bearer no cliente | `creators_edit` via operator ou writer legado no workflow; revalidação server-side. Cadastro composto pode fazer três chamadas sequenciais, sem transação entre elas. |
| influ (pilot) | POST `acao=piloto_operacao` | L | `body.k` | Recibo da mesma tentativa; este caminho depende de acesso de operação/escrita e não de uma simples chave de leitura. |
| influ (pilot) | POST `acao=piloto_salvar`, `kind=candidato/link/pagamento` | W/E | `body.k` | `creators_edit`; candidato contém dados pessoais; pagamento pode conter CPF/PIX; link ativo pode atribuir vendas/comissões. Link inicia pausado, ativar não é teste inocente. |
| candidaturas | POST `acao=ler`, `print` | L | `body.k` | `shrigma_panel_operator_v1(...,'influs')`; print por ID retorna imagem privada em base64, não URL pública. Sem cache/log do corpo. |
| candidaturas (LP pública) | POST `acao=termo`, `enviar` | L / W | Público, sem credencial do painel | É a mesma URL, mas **não é contrato do dashboard**. Gateway do painel deve negar ambos. `enviar` cria candidatura e imagens pessoais. |
| aprovacao | POST `acao=ler` | L | `body.k` | Operator Influs; `pode_escrever` informa presença de `creators_edit`. |
| aprovacao | POST `acao=aprovar` | W/E | `body.k`; `request_id` UUID | `creators_edit`; reserva código, busca/cria desconto na Shopify, registra creator/cupom/link/parceria. Mesmo request_id protege replay; não garante ausência de efeito remoto se resposta se perde. |
| aprovacao | POST `acao=envio`, `encerrar` | W/E | `body.k` | `creators_edit`; muda envio/rastreio ou encerra parceria/atribuição. A recusa na interface usa `piloto_salvar(kind=candidato,state=recusado)`, não `acao=recusar` nesta URL. |
| escopo | POST `acao=ler` | L | `body.k` | Operator Influs; conteúdos reais e mês `YYYY-MM`. |
| escopo | POST `acao=vincular`, `escopo_salvar`, `conteudo_marcar` | W | `body.k` | `creators_edit`; vincula Instagram, escopo contratual desde mês, conteúdo manual com UUID. |
| escopo (backend extra) | POST `acao=conteudo_ignorar` | W | `body.k` | Backend permite, mas não há botão/transporte exercido no frontend atual. Gateway deve negar por padrão. |
| tts | POST sem `acao`, JSON `{ini,fim}` | L | Bearer; sem `k` | Payload TikTok já coletado no backend, filas/amostras/KPIs. A ausência de seletor só é válida nesta rota/corpo exato. |
| tts-action | GET `acao=capacidades`, `operacao` | L | `X-TTS-Write-Key`, não Bearer | `tts_manual_runtime_v1`; operação consultada com chave da mesma tentativa, marca/application_id/operação. |
| tts-action | POST `acao=revisar` | W/E | `body.k`, `autor` | `APPROVE/REJECT` de amostra real; pode liberar produto/frete. Reserva/receipt/CAS de envio, identidade e readiness de corte/admissão. Nunca replay automático. |
| tts-action | POST `acao=regra` | W/E | `body.k`, `autor` | Muda limites, `modo` e `cobranca_modo`, guardados separadamente. Ativo pode habilitar ações ou mensagens futuras; `esperado_atualizado_em` deve preservar concorrência. |
| tts-cobranca | POST `acao=ler`, `produtos` | L | `body.k` | Operator Influs; textos/modelos/estado de fila e catálogo de produtos/imagens. |
| tts-cobranca | POST `acao=modelo_salvar`, `modelo_revogar`, `resolver`, `reativar` | W/E | `body.k` | `creators_edit`; salvar também aprova o texto. Resolver/reativar devolve à régua ou remove supressão. Trabalho existente pode enviar depois; não criar worker duplicado. |

Fontes: `organico-links.js:34`, `n8n/organico/links-utm.sql:25`, `influs.html:486`, `creators-pilot-ui.js:21`, `partner-candidaturas.js:26`, `n8n/creators/partner-candidatura-workflow.cjs`, `partner-aprovacao-workflow.cjs`, `partner-aprovacao.sql:61`, `influ-escopo.js:19`, `n8n/influs/escopo.sql:78`, `influs-tts.js:586`, `influs-tts-manual.js`, `n8n/tiktok/manual-decision-workflow.cjs`, `acesso-unico-patch.cjs`, `acao_valida.js`, `tts-cobranca.js:29`, `n8n/tiktok/cobranca-auto.sql:271`.

## Permissões backend e diferenças que o gateway não deve apagar

1. **Leitura por painel:** `shrigma_panel_auth_v1` valida painel, ativo, revogação e validade; a credencial de mestre pode ler outras áreas. Para entradas com hash migrado, o transporte header importa. O patch dá precedência ao Bearer; um cabeçalho presente inválido não deve cair no `k` alternativo. Fonte: `n8n/access/panel-auth-patch.cjs`.
2. **Escrita por grant explícito:** `shrigma_panel_operator_v1` exige linha em `shrigma_panel_permission_v1` para área `growth/influs`, além de estado e SHA-256 da credencial. Mestre sem grant não é escritor. `shrigma_crm_operator_auth_v1` preserva fallback de writer de templates legado. Fonte: `n8n/access/panel-operator.sql`.
3. **CRM:** `read_content`, `draft`, `validate`, `submit`, histórico/submissão e flags de marca/rota são independentes. Teste de e-mail exige ator `panel:*` com `draft+validate+submit`; não deve ser liberado para leitor genérico. Campanhas/segmentos aplicam versão, brand, contrato e autorização no backend. Idempotência não substitui autorização e não autoriza retentativa com payload alterado.
4. **Influs:** `creators_edit` habilita cadastro, pilot, escopo, aprovação e cobrança. A autoria vem do operator quando disponível. Não confiar em `autor`, `pode_escrever` ou scope enviados pelo navegador como autorização. Fonte: `n8n/access/panel-operator-patch.cjs`, SQLs de Creators/escopo/cobrança.
5. **Orgânico:** `organico_operador_v1` aceita painel `organico/todos`, inclusive hash curto legado, e não separa leitura/escrita por capability. Uma sessão operacional apenas de leitura deve reduzir esse poder no gateway. Fonte: `n8n/organico/links-utm.sql:27`.
6. **TikTok manual:** o patch de acesso único mantém writer legado e uma allowlist server-side de hashes de painel, distinta dos grants dinâmicos do banco. Revogar grant no banco não comprova remoção dessa lista. Readiness `write/cutover_verified/admission_verified` e modo de regras precisam corresponder ao runtime ativo; comentários de patch não comprovam estado atual. Fonte: `n8n/tiktok/acesso-unico-patch.cjs`.

A identidade pública e `allowedPanels` só controlam acesso à área; capabilities de payload são disponibilidade declarada. O gateway precisa interseccionar a permissão da sessão autenticada, a permissão operacional explicitamente configurada, a allowlist da rota e a autorização existente do backend. Nunca usar uma credencial mestre única para transformar todas as sessões em operadores irrestritos.

## Origin, CORS e autenticação no gateway

Os serviços Node `crm-panel-read`, `crm-campaign` e `crm-audience` recusam Origin diferente de `https://bandssz.github.io`; suas requisições comuns aceitam Origin ausente. `crm-audience` exige Origin correta no OPTIONS, mas isso não implica recusa de chamada server-to-server sem Origin. Os módulos de segmentos, bindings, AB de públicos salvos e lifecycle também aceitam ausência de Origin e recusam outra Origin. A função SQL `shrigma_crm_read_fast_v1` aceita Origin nula/vazia ou GitHub, e repete a guarda dentro do banco.

O patch de leitura compartilhada n8n e o de templates têm guarda explícita de Origin. Workflows de Orgânico, candidaturas, aprovação, escopo e cobrança usam configuração `allowedOrigins` de webhook/CORS; seus trechos de montagem não mostram a mesma validação explícita de Origin. O comportamento da versão ativa do n8n diante de Origin ausente não foi confirmado nesta auditoria. Não generalizar a regra de um serviço para todos.

Fontes: `services/crm-panel-read/server.cjs:21`, `services/crm-campaign/server.cjs:56`, `services/crm-audience/server.cjs:16`, `n8n/growth/crm-read-fast.sql:47`, `n8n/access/panel-auth-patch.cjs`, `aux-read-auth-patch.cjs:17`, `n8n/growth/segment-audience-api.cjs:17`, `segment-campaign-binding-api.cjs:14`, `ab-audience-panel-api.cjs:44`, `journey-graph-lifecycle-panel-api.cjs:33`.

Uma chamada server-to-server do gateway pode omitir Origin onde o backend explicitamente permite ausência, mantendo autenticação e demais guardas. Isso não exige alterar os serviços existentes. O gateway deve primeiro validar Origin/CSRF da sua própria sessão; não pode simplesmente apagar Origin estrangeira de uma chamada pública e encaminhar. Para POST de leitura, exigir CSRF também é uma opção conservadora porque usa cookie de sessão. Bloquear `k`, Bearer, cabeçalhos legados e escolha de upstream fornecidos pelo navegador; injetar o transporte de credencial correto **no servidor**, por rota, preservando principal e permissões.

Não encaminhar cookies da sessão do dashboard, headers arbitrários, resposta Set-Cookie do upstream ou redirecionamentos para serviços externos. Negar cabeçalhos/campos duplicados, seletores mistos, ações desconhecidas e métodos incompatíveis. Definir limite de corpo por família: impressão privada de candidatura exige limite distinto de JSON normal; não ampliar todos os endpoints para caber imagens. Limitar resposta, concorrência e duração; evitar retries de escrita. Os clientes de campaigns/AB aguardam até 90 s e dependem de conciliação após timeout, portanto 504 não é prova de operação não executada.

## Allowlist inicial recomendada para operação apenas de consulta

Esta é uma proposta, não uma liberação de produção. Permissões reais e deriva devem ser conferidas antes de uso. Manter todos os demais caminhos negados, incluindo ações via GET desconhecidas.

| Rota | Método | Ações / campos permitidos |
| --- | --- | --- |
| cx | GET | `access=1,painel` para identidade; ou `painel` para dados. Área limitada à sessão. Aceitar telemetria de auth precisa ser decisão explícita. |
| cache | GET | `painel` de área permitida. Mesma ressalva de telemetria. |
| crm-read | GET | Exatamente `action=identity/cache_growth,painel=growth`. |
| influ | POST | Apenas `acao=listar` e filtros de leitura conhecidos. Não permitir payload de cadastro na mesma chamada. |
| tts | POST | Sem seletor; somente janela `{ini,fim}` válida. |
| organico-links | POST | Apenas `acao=listar`. |
| escopo | POST | Apenas `acao=ler`, mês válido. |
| candidaturas | POST | Apenas `acao=ler` / `print` com ID válido; dados/imagens privados. |
| aprovacao | POST | Apenas `acao=ler`. |
| tts-cobranca | POST | Apenas `acao=ler/produtos`. |
| campaigns | GET | `acao=campanha_catalogo/campanha_listar/campanha_obter/campanha_operacao` e campos específicos de cada ação. |
| segments | GET | `segmentos_listar/segmento_obter/segmento_operacao`. |
| campaign-audience | GET | `acao=campanha_publico_obter/campanha_publico_operacao/campanha_publico_agendamento_operacao`. |
| templates | GET | `listar/email_capacidades/historico/submissao`; consultas de recibo/capabilities/testadores somente se sua permissão específica estiver disponível. |
| journey-graph | GET | `action=capabilities/catalog/list/get/operation`. |
| journey-graph-lifecycle | GET | `action=status/operation`. |
| ab-experiment | GET | `method=capabilities/list/get/campaigns/operation` e campos/ação de consulta exatos. |
| ab / tts-action / influ pilot | GET / POST conforme contrato | Consultas que exigem acesso de operador/writer só habilitar após confirmar o mapeamento e a política. Nunca usar credencial poderosa apenas para fazer aparecer um botão. |

`segmento_contar`, previews, `conferir`, `validar`, `review` e qualquer criação de token/review ficam fora da allowlist inicial. A investigação por fonte permite graduar cada uma depois, com aprovação da finalidade e ambiente separado; um rótulo “sem envio” não prova zero escrita nem custo desprezível.

## Riscos comerciais e critérios antes de habilitar escrita

| Efeito | Operações envolvidas | Condição mínima para testar |
| --- | --- | --- |
| E-mail / WhatsApp / campanhas reais | Agendar campaigns, regular/AB schedule, testes de e-mail, publicar/retomar builder, submissão de template usado por jornada | Transportes, destinatários, listas e banco de teste; ausência de workers reais conectados. Prefixo de teste não é isolamento. |
| Cupom/desconto, produto/frete ou parceria real | Aprovar parceiro Shopify, revisar amostra TikTok, ativar link de atribuição | Loja/API sandbox, entidades sintéticas e política de efeito explícita. Não usar produtos/creators reais. |
| Mensagens futuras de cobrança | Aprovar modelo, resolver/liberar/reativar, mudar cobranca_modo/regra | Sender de teste e filas separadas; jobs de produção não podem observar a escrita. |
| Contabilidade, comissão e dados pessoais | Custos, pagamento pilot, candidato, escopo, envio/rastreio, conciliação | Banco/dados sintéticos, exclusão de CPF/PIX/imagens e logs sensíveis, comprovação de rollback de dados quando aplicável. |
| Material/preparações no banco | Draft/template/segmento, AB alocação, review de público, token de email, release de graph | Banco/namespace isolado e flags negando transporte; ainda classificar como escrita. |

Para uma entrada operacional futura: validar primeiro consultas e negativas por função/área em uma mesma origem; conferir endpoint/capabilities e grants ativos sem revelar credenciais; manter writes negadas até existir teste seguro de cada contrato; então habilitar somente as ações aprovadas, com sessão, CSRF, autoria, versão e recibo. O gateway não deve instalar pipelines, sincronizadores, agendas, workers, webhooks ou migrações existentes. `crm-shopify-sync` é integração de backend existente, não endpoint de navegador a clonar.

Reversão da hospedagem não desfaz uma mensagem enviada, cupom criado ou transporte aceito. Por isso, não usar troca de tráfego/reversão do frontend como justificativa para testar essas operações na produção. Escritas cujo estado remoto não esteja comprovado devem permanecer bloqueadas e ser conciliadas pela mesma operação, sem nova tentativa automática.

## Verificação deste documento

A varredura incluiu chamadas `fetch`, wrappers de transporte e seletores nos fontes de CRM/Orgânico/Influs, entradas de autenticação, services Node e patches/SQLs associados. Atalhos para Shopify Admin, administração do Listmonk, Instagram/TikTok, Partner Center, OAuth e `wa.me` são navegação externa; a biblioteca integrada de campanhas é um contrato autenticado separado, descrito acima. Não proxyar URL extraída de dados livremente; imagens externas demandam CSP/allowlist própria e não recebem credenciais do dashboard.

Não foram executados testes HTTP comerciais para confirmar os efeitos. A documentação distingue contrato de fonte, autenticação técnica e operação real. A publicação operacional, mudança de Origin/DNS, instalação de SQL e liberação de escrita permanecem fora desta auditoria e dependem do escopo/autorização específicos.
