# Retenção transacional Fish/Aristo — integração candidata

Escopo desta revisão: somente os seis tipos de pedido reconhecidos hoje em cada marca no workflow `ecK2wke9fKnO3mfy`. Popup, NPS mal endereçado, WhatsApp, Olivas e demais ramos legados não entram na fila nova. Nenhuma instalação, ativação ou transmissão é realizada pelo módulo.

Prova local: 17 testes de SQL PGlite e grafo/ACK/VM (dez SQL, sete patch/protocolo), incluindo os sete corpos reais de claim/seleção/finish com tabelas sintéticas; o runner de concorrência PostgreSQL 17.10 aguarda execução CI. Em 27/09 às 19:02:59Z, os hashes dos 12 corpos atualmente selecionados pela função de jornadas coincidiram com o AST anteriormente auditado; todos os campos usados, inclusive sete campos de itens, estão na projeção. Foi lido somente hash/metadado, sem HTML. Isso não comprova os tipos do payload recente do Shopify Flow.

## Entrada e identidade

`tx_inbox` vincula apenas eventos admitidos por este contrato; o consumidor não assume outros eventos transacionais que tenham entrado pela função genérica. A entrada reconhecida deriva o rastreio no nó existente, projeta os campos de e-mail e persiste `tx_admit_v1(marca, corpo)` antes de responder ao webhook. O recibo é da aceitação durável, não de envio. Falha do SQL responde 503, sem alegar persistência. A repetição exata encontra a mesma identidade `marca / transacional / pedido-<evento> / [email,order_id,0,false]`; corpo normalizado diferente é conflito, não nova mensagem. O corpo completo do webhook, cabeçalhos, credenciais e telemetria `_trk` não são persistidos. WhatsApp continua recebendo a saída original de Derivar Rastreio, sem passar pelo consumidor de e-mail.

Os campos projetados são os metadados usados pelo claim e os campos de dados do contrato de templates existente. Chaves sensíveis/de controle são recusadas; campos irrelevantes não integram o envelope de e-mail. O snapshot de templates legado já conferido fornece nomes dos campos, não prova de payload recente: a única execução inspecionada em 27/09 estava `new`, sem dados retidos, e o workflow não tem pinData. Antes de ativar, comparar o esquema real do chamador Shopify Flow com esta projeção. Não alegar que esta inspeção ocorreu.

## Consumidor

Workflow novo criado OFF. A cada minuto, até dez seleções por marca, com rotação durável por sequência, sem prazo artificial para pedido. `tx_next_v1(marca)` verifica o gate antes de disponibilizar preparo. Só a ausência comprovada do assinante permite reutilizar POST `/api/subscribers`; assinante existente não é atualizado/reinscrito. Há intervalo mínimo de 30 segundos entre seleções da mesma entrada (somente cadência de tentativa, sem expiração). O gate é rechecado no claim: um fechamento entre seleção e preparo pode deixar um insert-only de assinante em voo, mas não permite reserva/transporte de e-mail posterior ao corte. O POST nativo v6.1 retorna 409 para e-mail existente (sem atualização); o claim consulta novamente o banco, não adota o corpo do HTTP. Falha/resultado incerto de preparo sem assinante mantém o evento retido.

`tx_claim_v1(event_id)` reconfere gate, evento e assinante sob locks antes do claim original. A guarda conservadora exige assinante único enabled, vínculo nas listas 3/17 (Fish) ou 7/16 (Aristo) e nenhum vínculo unsubscribed nessas listas. Ausência de vínculo ou opt-out deixa review_required, sem reinscrição. Somente o primeiro claim confirmado retorna o token original. Resposta de claim perdida, `accepted` e `outcome_unknown` não recebem outro token. A recusa definitiva/bloqueio requer revisão; `flow_paused` continua retido. Não se inventa TTL para pedido.

`tx_finish_v1(dispatch_id,claim_token,response,context)` chama o finalizador original da marca e `reconcile_v1` na mesma transação. Preserva as quatro colunas originais; falha na reconciliação desfaz só os efeitos SQL do finish, nunca autoriza repetir HTTP. Após aceite confirmado, o consumidor conserva a remoção da lista de popup da marca. Falha desta consequência não reabre o transporte.

## Contratos para o instalador

- SQL incremental: `maintenance-tx-popup.sql`. Mesma schema `crm_maintenance_candidate`, sem alteração das funções originais, sem grants públicos.
- `patchTxProducer(workflow, guard)` e `buildTxConsumer(workflow, guard)` em `maintenance-tx-popup-patch.cjs`.
- Guard: `{version, workflowHash, connectionsHash}`; igualdade da versão editável/publicada ativa e export integral. Exigir janela de edição exclusiva, pois o PUT n8n não é CAS.
- Exports/definições fresh: `.private/runtime/tx-popup-retention-20260927/`, conferidos em 27/09. Workflow `40e08cb5-0c9c-47f4-87ef-b6cc2e01be48`; grafo igual ao export do diagnóstico de drenagem.
- Instalar SQL aditivo atomicamente; criar consumidor OFF; conferir schema/credencial/projeto/versões; gate aberto antes de publicar produtor; publicar/readback produtor; somente depois ativar consumidor. Não fechar gate nesta instalação.
- Rollback seguro: parar consumidor não apaga fila nem recibos. Restaurar bypass do produtor enquanto há eventos retidos pode perder a cobertura/deduplicação; exige conciliação e decisão separadas. Não restaurar SQL/grants antigos nem apagar eventos.

## Popup permanece fora do corte

O popup atual usa `popup-execution:<execution.id>`. A retomada interna preservaria a identidade, mas uma nova chamada gera outra execução. Não há pinData nem chamador identificado pela busca exata da rota no repositório/inventário retido. Nenhuma rota nova sem chamador é apresentada como cobertura. A integração posterior precisa ID estável de origem/entrega, persistido com a referência original; não hash de e-mail, janela arbitrária nem fusão de eventos.

## Fonte primária e limites

Listmonk v6.1.0: `cmd/subscribers.go:209–239` chama InsertSubscriber com `assertOptin=false`; `internal/core/subscribers.go:259–317` retorna 409 no conflito do e-mail, sem atualizar e sem enviar opt-in quando `preconfirm=true`. URLs: https://github.com/knadh/listmonk/blob/v6.1.0/cmd/subscribers.go e https://github.com/knadh/listmonk/blob/v6.1.0/internal/core/subscribers.go.

HTTP aceito de `/api/tx` é entrada em memória no Listmonk, não entrega SES. Esta retenção não comprova drenagem global: VIP, testes humanos, campanhas nativas e legados continuam sendo dependências da janela A/B.

## Validação operacional pendente e observação temporária

As tabelas reais de dispatch/log não guardam corpo/contexto: inspeção de colunas em 27/09 confirmou zero colunas JSON/payload e a API não encontrou execução success retida. Não se conclui compatibilidade dos tipos reais a partir das fixtures.

`maintenance-tx-observation.cjs/.sql` prepara um ramo temporário após Derivar Rastreio que computa somente nomes permitidos de campo, tipos e resultado da projeção; nenhum valor, endereço, identificador, hash de pessoa ou corpo. Guarda contadores agregados por marca/evento/revisão do normalizador no schema separado `crm_tx_input_probe`, sem mudar o selo CART. Há limite de tamanho e nomes/tipos no SQL, lock de até 250 ms, nenhuma nova tentativa e tratamento de erro que permite continuar. Até o fallback de erro do Code é projetado antes de chegar ao SQL. PUBLIC não recebe acesso.

O builder exige export/version/hash frescos, sucesso/erro sem histórico, execução manual sem persistência e ordem `v1`. Preserva todos os nós, configurações e destinos anteriores; posiciona os quatro nós novos abaixo dos existentes. O n8n [executa os ramos v1 completos de cima para baixo](https://github.com/n8n-io/n8n-docs/blob/main/docs/build/flow-logic/understand-execution-order.md), então a observação ocorre depois do caminho anterior. Se esse caminho falhar ou ficar pendente, pode não haver observação: **zero amostras é inconclusivo**. A checagem não prova eventos ainda não observados nem entrega SES. Ela acrescenta trabalho limitado depois dos envios; não deve ser tratada como custo zero.

`buildObservation(workflow, guard)` retorna candidato, revisão, hash do normalizador e payload de restauração. Instalar primeiro somente o schema da observação, publicar apenas o ramo temporário com novo GET/guarda de versão e conferir o corpo ativo. Não instalar nem ativar a retenção por essa etapa. `restoreObservation(current, freshGuard, prepared)` devolve o payload original somente se o publicado ainda for exatamente o candidato observado. Restaurar os ramos remove a observação; não apagar schema CART, fila ou recibos. O PUT não oferece CAS: continua necessária janela sem outro editor. Resposta incerta requer leitura/reconciliação, nunca repetição automática.

A leitura dos triggers de `shrigma_send_log` encontrou apenas triggers internos FK de DELETE/UPDATE; nenhum trigger de usuário/INSERT. Funções reais TX não acessam subscriber após dispatch. O runner PG inclui uma reserva original que segura o advisory enquanto o wrapper espera, finish real concorrente e opt-out que confirma enquanto o claim espera o assinante. Não se declara esse ensaio executado até CI.
