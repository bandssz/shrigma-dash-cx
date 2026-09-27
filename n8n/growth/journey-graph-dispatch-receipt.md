# Recibo original aplicado ao fluxo

Candidato privado, sem instalação ou transporte. `runtime.applyDispatch` recebe
`request_id`, `actor`, `brand`, `entry_id`, `expected_version` e `intent_id`.
Não aceita resultado, endereço, conteúdo, token de claim ou ID de dispatch no
pedido. O adaptador confiável `readDispatch({query,brand,intent_id})` chama
`cart_dispatch_v1` **na mesma transação**, pelo `query` fornecido; a função
reconfere o vínculo imutável e trava o dispatch original `FOR SHARE`.

A instalação candidata segue store → ponte CART → dispatch-receipt. A migração
recusa colisão ou alteração inesperada do CHECK de operações, acrescenta apenas
`apply_dispatch` e um ledger imutável. Não habilita execução nem concede acesso.

| Estado original | Efeito na entrada |
|---|---|
| `in_flight` | Mantém espera, sem novo envio e sem próxima execução agendada. |
| `outcome_unknown` | Mantém resultado incerto; só outro resultado confirmado do mesmo dispatch pode resolver. |
| `accepted` | Avança uma aresta da revisão fixada e define `next_due_at`; aceitação não prova entrega. |
| `rejected` | Marca a tentativa como falha, sem reenvio. |

O ledger registra cada estado observado uma vez por intenção; recibo, transição,
versão da entrada e operação confirmam juntos. O mesmo request reproduz sua
resposta original após `beforeCommand` reautorizar. Outra operação precisa da
versão atual; repetir um estado já aplicado não avança novamente. Resultado
terminal contraditório e regressão para `in_flight` são recusados.
Uma mudança do estado nativo exige uma nova operação durável; não reutilizar o ID
da leitura `outcome_unknown` para aplicar um `accepted` posterior. O coordenador
pode vincular essa identidade à tupla intenção/dispatch/estado obtida na consulta
confiável; o pedido de aplicação continua sem campo de resultado.

Pausa/OFF permitem registrar o que já aconteceu. `step`/`due` continuam bloqueando
nova execução. Não há releitura de consentimento para apagar histórico de um
envio já reservado; a próxima etapa mantém suas guardas normais de consentimento,
compra, fonte e material. Locks: operação → controle → jornada → entrada → intenção
→ dispatch. Aplicar recibo ocorre **depois** do commit do finish original, nunca
dentro dele (que já pode segurar dispatch/assinante).

Provas locais: `journey-graph-dispatch-receipt.test.cjs` usa PGlite com um vínculo
SQL sintético, cobrindo duas marcas, pin de revisão, OFF/pausa, CAS, estados,
reautorização, resposta perdida, rollback e migração. O runner
`journey-graph-dispatch-receipt-postgres.cjs` exige PostgreSQL 17.10 local, usuário
sintético e DB vazio `journey_graph_receipt_test`; acrescenta concorrência real
de operação, pausa/OFF e finish. Não alegar prova PostgreSQL até o runner passar.
As fixtures não substituem a integração com a ponte CART nem comprovam envio real.
