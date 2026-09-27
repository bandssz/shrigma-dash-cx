# Retenção durável Growth — candidato OFF

Este componente não está instalado e não pausa, publica ou envia nada. Acrescenta somente armazenamento e funções em `crm_maintenance_candidate`, com `enabled=false`, `mode=closed`, sem permissões para `PUBLIC`. Não há webhook, navegador, agendador, descoberta de fila, consumidor ou integração de emissores nesta entrega. A CI usa funções originais **sintéticas**, PostgreSQL descartável e nenhum transporte.

## Contrato e corte

1. O servidor entrega a `admit_v1(brand,kind,body)` os argumentos já normalizados do claim existente. A função persiste evento, identidade, hash e recibo imutável na mesma transação. O recibo confirma **retenção**, com `persisted=true` e `authorizes_send=false`; não confirma elegibilidade nem envio. Uma repetição idêntica recupera o mesmo recibo; conteúdo diferente para a mesma identidade é recusado.
2. A confirmação ao produtor só pode ocorrer após o COMMIT confirmado dessa chamada. `maintenance-adapter.cjs` usa uma única consulta parametrizada em conexão autocommit, sem `BEGIN`, transporte, logs ou retentativas. Não se deve fornecer a ele uma conexão emprestada com transação externa ainda aberta. Erro/resposta perdida resulta em `MAINTENANCE_UNCONFIRMED`: consultar/repetir a **mesma admissão** é seguro; nunca criar outra identidade para contornar o resultado.
3. `claim_v1(event_id)` trava `control FOR SHARE`, depois o evento e chama o claim original dentro da mesma transação. O primeiro resultado válido pode devolver o token/payload/contexto originais, sem alterá-los; confere identidade e token contra o dispatch persistido. Nenhuma repetição devolve o token novamente. Se a resposta da reserva se perder, o evento fica vinculado ao dispatch, para conciliação, sem novo envio automático.
4. `control_v1(operation_id,expected_version,enabled,mode)` usa CAS e recibo durável por operação. Fechar exige `control FOR UPDATE`, aguardando as reservas anteriores terminarem sua transação. O `cutoff_at` T0 é registrado nesse corte. Uma reserva que chega depois espera e observa `closed`. Mensagens tardias continuam sendo admitidas e retidas.
5. Reservas confirmadas **antes** de T0 podem já estar no transporte ou aguardando sua chamada HTTP. O recibo de fechamento contabiliza `reserved_unconfirmed` e sempre informa `drained=false`. T0 não é uma prova de fila vazia, nem revoga tokens já entregues. Ainda é necessário conciliar os dispatches anteriores com evidência do transporte.
6. Reabrir libera avaliação da mesma identidade contra o claim original: opt-out, compra posterior, limites, template publicado e demais verificações continuam sob autoridade do emissor existente. Não há novo dedupe, limpeza de dispatch, reinicialização de claim ou reenfileiramento de `accepted`, `outcome_unknown`, `rejected` ou `in_flight`.

Ordem de locks: admissão `control SHARE → advisory da identidade`; reserva `control SHARE → evento → locks do claim original`; controle `advisory da operação → control UPDATE`, sem travar eventos. A conciliação trava `evento → dispatch` e não chama claim. Não há chamadas HTTP dentro de qualquer transação.

## Identidades verificadas

As assinaturas existentes devem devolver exatamente `TABLE(should_send boolean, dispatch_id uuid, claim_token uuid, payload jsonb, context jsonb, reason text)`; a instalação recusa ausência ou outro contrato. A verificação de implantação deverá reconferir os corpos ativos e sua semântica, além dessa assinatura. Estes hashes MD5 são evidência pontual de 27/09/2026, não certificação de atualização automática:

| Caminho | Claim original / MD5 verificado | Identidade preservada |
|---|---|---|
| Carrinho Fish/Aristo | `shrigma_email_claim_cart(jsonb)` / `2ac184cbc776d61c3f3e6cd8d943ce99` | Marca, `carrinho`, peça, `['email',ref UTC,subscriber_id,false]`. `ref` é o abandono original; `marketing_7d` não participa do corpo retido. |
| Pós-venda Fish/Aristo | `shrigma_flow_email_claim_tx(text,jsonb)` / `14f2403a6b069a21d995b424cd522f03` | Marca, `transacional`, `pedido-<event_type>`, `['email',order_id,0,false]`. Tipos: recebido, confirmado, preparando, enviado, em_rota, entregue, cancelado. |
| Popup Fish/Aristo | `shrigma_email_claim_engagement(jsonb)` / `1cfa234aea62d539aaa940ae770995fa` | Marca, `popup`, `cupom-boas-vindas`, `['email','popup-execution:<execução original>',email normalizado,false]`. Não cria outra execução/ref na retomada. |

O wrapper transacional utiliza os claims por marca (`fish` MD5 `0f405a4db22f62ff515b8725d894baaa`; `aristo` MD5 `133c671b20fb971651b7e8999908c246`). NPS, Olivas, WhatsApp e qualquer produtor de CX não pertencem a este contrato.

O hash de admissão representa os argumentos recebidos. Não é o hash final do dispatch: os claims atuais podem selecionar o template publicado e normalizar o envelope antes de reservá-lo. O componente não contorna essa autoridade nem reconstrói seu resultado por aproximação.

## Prazo e estados preservados

Só carrinho possui `expires_at`: abandono original + 1h/4h/5h/27h/51h para t05/t1/t2/t24/t48. O prazo é conferido antes **e depois** do claim. Se vencer enquanto se aguarda um lock, a subtransação desfaz a reserva e quaisquer efeitos originais, e o evento fica `expired`, com recibo e payload preservados, sem token. Não é tratado como entregue. A publicação futura também deve preservar os controles do emissor entre concessão do token e HTTP; isto não prova o instante de entrega.

Transacional e popup não recebem TTL inventado: permanecem retidos ou bloqueados até resolução explícita. Não há descarte, limpeza automática nem ampliação da janela de marketing.

- `flow_paused`, `journey_paused`, `not_due`, `cadence_or_cap_changed`: sem dispatch, permanecem `queued`, na mesma identidade. Nova avaliação só pelo consumidor futuro, respeitando a janela original.
- Demais recusas sem dispatch: `review_required`, preservadas e sem tentativa automática. Motivos conhecidos são guardados como códigos; razão desconhecida vira `unrecognized_original_refusal`. Esta entrega não contém operação administrativa de desbloqueio.
- Dispatch existente: conserva vínculo e estado real; `in_flight` corresponde a `claimed`. Não devolve payload/token para reenviar. `reconcile_v1` apenas acompanha o estado original e nunca transforma HTTP aceito em entrega.

## Pontos exatos de integração futura — não aplicados

| Emissor verificado | Inserção antes do claim existente | Retomada e confirmação |
|---|---|---|
| `ekQxu1pUFyab8Iyd` — carrinho, versão `894b0ebb-4615-4c19-9814-928a7950cb3e` | Entre seleção/normalização de `Elegíveis (PG)` e `R4 reserva carrinho`: `admit_v1(brand,'cart',body)`. Não interromper a coleta nem desativar o workflow inteiro. | Guardar evento antes de confirmar processamento; chamar `claim_v1` pelo ID persistido. Somente `should_send=true` segue para `R4 Listmonk carrinho`, sem retry, e para seu finish original. |
| `ecK2wke9fKnO3mfy` — pós-venda/popup, versão `40e08cb5-0c9c-47f4-87ef-b6cc2e01be48` | Substituir o ponto de reserva de `R4 reserva exclusiva Fish/Aristo`, preservando os argumentos de `Derivar Rastreio — Fishermans`/ramo Aristo; e entre `SES popup prepara` e `SES popup reserva`, com o body normalizado e ref original. | ACK só após admissão persistida; retomada chama `claim_v1` com o evento. A saída original liga às mesmas condições e nós `R4 Listmonk Fish/Aristo` ou `SES popup Listmonk` e aos finishes atuais. Nenhum clone de transporte. |

**Bloqueios reais antes de cobrir produção:** o webhook pós-venda hoje confirma no recebimento, antes do claim. A integração deve mudar esse percurso autorizado para confirmar só depois da persistência, sem afetar outros ramos. A ref de popup depende da execução n8n: a retomada interna preserva essa ref, mas uma nova entrega externa que gere outra execução não está automaticamente deduplicada por este componente. É necessária uma identidade estável da entrega original/recibo no adaptador de ingresso antes de prometer dedupe entre retentativas externas; não se deve inventá-la a partir de e-mail ou conteúdo.

No carrinho, pausar a seleção por jornada hoje pode impedir que um evento chegue à retenção. O corte futuro precisa manter a admissão dos elegíveis funcionando e fechar apenas a reserva via este gate; não pode simplesmente pausar a jornada/coletor e presumir que o inbox capturou tudo.

As versões acima são snapshots de evidência, não uma autorização de patch sobre uma versão futura. A integração deverá reler ativo/editável e grafo, verificar todos os caminhos/fallbacks Growth, proteger a confirmação e testar as conexões. Produtores fora desse recorte e chamadas diretas aos claims originais **não passam pelo gate**. Não é possível certificar a drenagem global do Listmonk com este candidato.

## Dados e autorização

Armazenar somente o argumento normalizado já necessário ao claim, nunca request bruto, cabeçalhos de autenticação, credenciais ou captura do navegador. O payload pode conter e-mail, URLs de pedido/carrinho e campos de personalização indispensáveis; fica no banco privado, limitado a 128 KiB, sem logs, export público ou recibo contendo esses valores. Identidade e payload são imutáveis; colisão não sobrescreve conteúdo. A recusa de campos sensíveis no envelope é defesa adicional, não um sanitizador genérico para request bruto.

Funções são `SECURITY INVOKER`, nenhuma credencial/grant novo é instalado e `PUBLIC` não acessa schema, tabelas ou funções. Um papel de serviço futuro precisa de permissões revisadas para a retenção e os claims existentes; controle open/closed exige papel administrativo separado, sem endpoint/browser. Não conceder acesso direto de alteração do gate/eventos a um cliente público. A retenção de dados posterior à resolução precisa de política própria antes do rollout; esta entrega preserva tudo e não implementa purge.

## Provas

`maintenance-retention.test.cjs` usa PGlite e contratos originais sintéticos: identidade, receipt/replay, isolamento de marca, prazo original, template/payload sem substituição pelo wrapper, recusas temporárias, revisão bloqueada, accepted/unknown sem reenvio, token divergente, rollback, privilégios e imutabilidade. `maintenance-adapter.test.cjs` cobre ACK somente após resultado, perda de resposta e erro sanitizado.

`maintenance-concurrency-postgres.cjs` roda exclusivamente em PostgreSQL 17.10 descartável na CI: duas sessões, admissão/reserva simultâneas, lock comprovado em `pg_stat_activity`, close antes/depois do claim, chegada tardia, perda de respostas de admissão/claim/controle, abort, falha original e prazo atravessado esperando o lock original. Termina OFF. Não prova um workflow publicado, fila de transporte vazia, comportamento de produtores não integrados ou entrega de e-mail.

## Implantação e rollback

Esta entrega não executa a instalação. A instalação futura exige export fresco e guarda de versão dos emissores e corpos das funções originais, teste isolado, cobertura de ingresso/retomada e revisão de acesso. O SQL é uma transação única e recusa namespace já existente; não adota tabelas nem sobrescreve funções de outro componente.

Rollback deste PR: reverter o commit, pois não há dados candidatos em produção. Se instalado em ensaio ou numa implantação futura, fechar e desabilitar pelo controle com versão esperada, preservar eventos/recibos e conciliar reservas já concedidas. Não apagar tabelas/dispatches nem retirar a retenção de um ingresso com eventos pendentes. Uma reversão dos emissores precisa de plano específico para esses eventos antes de executar.
