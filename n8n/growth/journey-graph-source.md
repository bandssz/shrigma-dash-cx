# Fonte de carrinho candidata — Fish e Aristo

**OFF, não instalada.** Esta peça captura identidade de fonte e fornece fatos ao runtime existente. Não inscreve participantes, publica fluxos, reserva e-mails, reativa listas ou envia. Todos os IDs de testes são sintéticos.

## Caminho implementado

1. `patchCollector(export,{expectedVersion,brand})` exige os nós/encadeamento e listas existentes. Fish usa base 17/carrinho 22; Aristo base 16/carrinho 21. Preserva Upsert, reconciliação e Resumo; acrescenta recibos, sem consumidor automático. A integração atual Fish foi conferida em export local de `rhUFehViMkOST0Or`; o shape do export Aristo ainda precisa ser conferido antes de aplicar.
2. O recibo inclui somente subscriber_id interno, referência e hashes de cart_id/material. O patch também corrige no normalizador candidato o fallback monetário `amount||0`: ausência/inválido permanece null, enquanto zero explícito é preservado. Não reescreve dados históricos. Só inclui a linha quando os dados realmente recebidos no lote correspondem ao carrinho persistido. Um evento antigo ignorado pelo Upsert **não** renova a observação de um carrinho novo. O carimbo conservador é colhido antes das requisições Shopify; lote que exceder 5 min é recusado.
3. O driver confiável configura `collectorWorkflowIds` e chama `captureHandoff(batch)`. Identidade idempotente deriva de workflow+execução+lote. `source_capture_v1` relê o assinante após o bloqueio, compara ref/hashes e grava atomicamente evento imutável+observação+recibo. Nenhum payload do editor é aceito como prova de fonte. Até 200 itens/lote e 2000/execução.
4. `readSource({source_ref,brand,trigger,now,query})` implementa `journey_source_v1`. `now` vem do relógio confiável do runtime, nunca do operador. O UUID do assinante nativo é conferido novamente. Compra positiva, status global, descadastro de marca/listas e reservas/flags legados são relidos; nenhuma leitura renova a data do material.

O evento é definido por marca+assinante+cart_id+ref. Uma mudança de compra ou consentimento não muda `source_revision`. Outro carrinho torna o antigo inelegível. Recibos persistem só hashes/UUIDs internos; nome, email, telefone, URL e itens não são copiados para essas tabelas. Material mínimo existe apenas na leitura em memória.

## Fatos e limites reais

- `purchase.confirmed=true`: `last_order_at >= ref`, sem aceitar carimbo futuro. Ausente, inválido ou anterior não equivale a Não.
- A opção `purchaseFor` é adaptador de servidor **ainda não conectado**, sem implementação padrão. Só aceita prova exaustiva ligada à mesma marca/assinante/evento, cobrindo de antes do abandono até o instante da decisão. O consumidor deve confirmar paginação completa e erros da origem. Webhook e contador vazio não constituem essa prova.
- `contact.email_allowed`: exige enabled, associação à lista de carrinho e nenhum descadastro em base/listas da marca; recusa consentimento explicitamente negado. Conserva a semântica nativa de confirmed/unconfirmed; não cria ou reinscreve contatos.
- `contact.first_name`, `cart.checkout_url`, `cart.items`, `cart.total` só quando presentes/tipados e com hash igual ao recibo. Itens preservam apenas campos reais. URL exige HTTPS, mas vínculo de domínio Shopify da marca ainda deve ser validado na integração do consumidor. Items são material para o release, não tipo de condição do GraphContract.
- Qualquer reserva operacional do carrinho, inclusive resultado desconhecido, envio histórico ou flag de toque bloqueia esta entrada conservadoramente. Isso não é um mutex de envio: o consumidor **precisa reutilizar claim/dedupe atômico legado e repetir compra/opt-out antes do transporte**, inclusive após `waiting_message`.

A coleta Fish atual é horária. Os materiais expiram após 5 min na liberação de mensagem: precisamos de refresh confiável ao vencer a espera, não apenas ligar esse ledger. Também faltam consulta completa de compra para Não, consumidor do handoff, ownership/claim contra o legado, autorização operacional e transporte. Nenhum desses pontos foi declarado pronto por esta peça. O construtor não está completo.

## Instalação e provas

`journey-graph-store.sql` é pré-requisito; `journey-graph-source.sql` é transacional e recusa objetos homônimos, sem adotar schema desconhecido. Dependências nativas: subscribers, lists, subscriber_lists, shrigma_email_dispatch e shrigma_send_log. Funções/tabelas novas ficam sem acesso PUBLIC. Não há mudança de função, cadastro ou tabela nativa.

`tests/journey-graph-source.test.cjs`: captura/replay, marcas, opt-out, compra desconhecida/positiva, legado, timestamps/material, colisão, patch de recibo e integração source→runtime→wait_data/saída sem intenção. `tests/journey-graph-source-postgres.cjs`: PostgreSQL 17.10 descartável, concorrência, mudança de fonte durante espera e reconsulta de opt-out. Rodar com `GRAPH_TEST_DATABASE_ISOLATED=1`, `TEST_DATABASE_URL=postgres://synthetic@localhost:5432/journey_graph_source_test`; somente essa base loopback é aceita. Execução real depende da CI; testes locais usam PGlite.
