# Carrinho Fish/Aristo — integração candidata da retenção

Código preparado, **não instalado nem ativado**. Não há alteração em TX, popup, WhatsApp, CX ou Olivas. A base da PR129 permanece intacta. O incremento acrescenta funções/tabela/sequência privadas, um patch puro do emissor CART e um consumidor que nasce `active=false`.

## Comportamento e limites

O patch preserva todas as conexões, configurações, credenciais, classificadores e transportes do emissor `ekQxu1pUFyab8Iyd`; muda somente três corpos SQL:

1. `Elegíveis (PG)` exclui identidades CART Fish/Aristo **já retidas**, antes do `LIMIT 500`. Durante manutenção, os primeiros 500 não voltam indefinidamente à frente dos demais. Olivas mantém a seleção original. A identidade considera marca, peça/toque, assinante e abandono original, conforme PR129.
2. `R4 reserva carrinho` chama `cart_admit_claim_v1`: persiste a admissão e, se o gate está aberto, reserva pelo claim original na mesma transação. Fechado, apenas retém. O resultado só chega ao HTTP após a confirmação da transação. O payload, o contexto e o token de uma reserva válida são os originais.
3. `R4 finaliza carrinho` chama `cart_finish_v1` com os mesmos quatro argumentos. O wrapper trava o evento, chama o finish original e reconcilia o estado da retenção atomicamente. Devolve as mesmas quatro colunas originais (`dispatch_id`, `transport_state`, `send_log_id`, `error_code`). Assim, accepted/rejected/outcome_unknown não ficam indevidamente contados como claimed. Falha da conciliação desfaz os efeitos SQL do finish; **não desfaz nem repete o HTTP**. O dispatch fica bloqueado para conciliação, sem novo token.

O consumidor chama `cart_next_v1` em 20 consultas independentes por rodada, dez para Fish e dez para Aristo, com cron de um minuto. Cada consulta reserva no máximo **um** evento e mantém apenas os locks dessa reserva. Duas instâncias usam `SKIP LOCKED`; o gate continua sendo travado antes de qualquer evento. A sequência privada `cart_turn` garante rotação estrita das tentativas, mesmo quando timestamps empatam; os não avaliados vêm primeiro, depois o menor turno anterior. Carrinhos temporariamente pausados preservam a identidade e cedem a vez. Um erro SQL original desfaz a subtransação e deixa aquela entrada `review_required`, sem bloquear continuamente a frente da fila.

O consumidor copia o filtro, HTTP, classificador e finish do export revisado. O SQL do finish usa o mesmo wrapper acima. Somente `should_send===true` chega ao HTTP. O HTTP mantém `retryOnFail=false`; nenhuma nova reserva devolve novamente o token de um dispatch já vinculado. A ligação de itens e as expressões que recuperam claim/contexto preservam os nomes originais dos nós.

São limites de trabalho por rodada, não promessa de capacidade para o host. Não há captura de carrinhos que o seletor original nunca observou, extensão de prazo, garantia de entrega antes da expiração ou cobertura de outros emissores. A pausa de manutenção usa **o gate**, sem pausar jornada/coletor/seletor, para não interromper a captura. O claim original continua verificando opt-out, compra, cadência, template publicado e demais condições no momento da retomada. Recusas desconhecidas continuam bloqueadas para revisão. Expiração durante espera por lock desfaz a reserva original e mantém a evidência expirada, sem enviar.

## Preparação verificável

`maintenance-cart-patch.cjs` não faz I/O. `patchCartProducer(export,guard)` e `buildCartConsumer(export,guard)` exigem:

- ID exato do emissor, versão ativa igual à editável e à versão esperada;
- SHA-256 canônico do export completo e das conexões, obtidos do snapshot revisado;
- nó/SQL/expressão original de reserva, ramo exclusivo Fish/Aristo, filtro de vencedores, HTTP sem retry e conexão direta com o finish reconhecidos;
- assinatura original do finish conferida pelo instalador SQL. Função inexistente ou retorno diferente impede a instalação.

Não substituir o guard por hashes de um export desconhecido só para vencer uma recusa. Drift exige revisão do delta. O snapshot local usado para preparar os primeiros candidatos é a versão `894b0ebb-4615-4c19-9814-928a7950cb3e`, exportada na análise de drenagem de 27/09/2026. Antes de qualquer aplicação, obter novamente ativo/editável, projeto e referências de credenciais; esta versão documental não é uma leitura ao vivo.

## Sequência de implantação futura

1. CI e revisão aprovadas. Guardar export ativo/editável, conexões, settings, credenciais por referência e definições das funções originais/base. Conferir a base PR129 e o retorno exato do finish; usar a mesma conexão PostgreSQL e projeto autorizados do emissor. Nenhum token ou endereço individual entra no relatório.
2. Instalar PR129 com `enabled=false/mode=closed`, caso ainda não exista. Instalar `maintenance-cart.sql` uma única vez, de forma atômica e com schema/objetos esperados: `CREATE` recusa colisões. Instalação via util deve usar transação atômica adequada ao driver, sem deixar `BEGIN` aberto no pool. A entrega não inclui instalador remoto nem concede `PUBLIC`.
3. Criar o consumidor **inativo**, com as referências de credenciais existentes no projeto correto. Confirmar grafo, `active=false`, hashes, ausência de retenção de execução e ausência de retry no HTTP. Criá-lo não autoriza executá-lo.
4. Abrir o gate por `control_v1` com operação UUID durável e CAS, enquanto o emissor antigo ainda roda normalmente. Confirmar `enabled=true/mode=open`. Não fechar o gate nem iniciar uma janela durante esse intervalo: o emissor ainda não está integrado.
5. Aplicar/publicar somente os três SQL guardados do CART. Conferir versão publicada, hashes de cada corpo e igualdade de todos os demais campos/conexões. Em modo aberto, novos eventos seguem pelo claim e finish originais. Caso o patch não seja confirmado, não tratar o gate como cobertura do emissor.
6. Somente após readback aprovado e revisão operacional, ativar o consumidor. Ele atende eventos retidos/temporariamente não elegíveis; o caminho normal também pode enviar imediatamente. Não executar manualmente uma cópia para compensar resposta desconhecida.
7. Futuro corte de manutenção: fechar o gate por CAS e guardar o T0/recibo. O produtor continua capturando; o consumidor não reserva. Conciliar os grants anteriores ao corte e demais produtores antes de qualquer troca Listmonk. `reserved_unconfirmed=0` cobre apenas as entradas desta retenção; `drained` continua sempre falso. Reinício/troca do serviço exige a janela já reservada a Felipe.

## Reversão sem perder identidades

- Antes de integrar o produtor: consumidor continua OFF; reverter apenas o candidato/configuração nova. Não apagar schema, recibos ou identidades.
- Depois de integrar: para interromper o novo consumidor, desativá-lo e confirmar que suas execuções terminaram. Fechar o gate por CAS quando for necessário impedir novas reservas CART. Desativar um workflow não revoga grants já emitidos; conciliá-los antes de qualquer outra ação.
- O retorno ao export anterior **não é permitido durante uma manutenção fechada**, pois o claim antigo contornaria o gate. Tampouco se deve remover o filtro de identidades com queued/review_required/claimed ou dispatches incertos: isso reabriria a seleção fora da retenção.
- Resolver/retomar a fila com os mesmos IDs e conferir queued/review_required/claimed, execuções e estados originais. Só com a fila sem trabalho pendente e sem grants incertos, numa janela normal aberta, avaliar restaurar o export revisado anterior. Preservar todas as tabelas/recibos e dispatches. Nenhuma reversão reinicializa claims ou reenvia accepted/unknown.
- Falha só no wrapper de finish exige recuperação do **finish SQL** com o mesmo dispatch/token/outcome/contexto e evidência HTTP, nunca repetição do HTTP ou recriação do evento. Os testes provam atomicidade; a recuperação operacional ainda depende da evidência retida do emissor.

## Provas incluídas

Testes locais PGlite e de patch: gate aberto/fechado, identidade duplicada, seleção além de 500, isolamento de marca/tipo, rotação de pausados, expiry, erro sem reserva parcial, same-token, preservação de nós/credenciais/grafo e finish accepted/rejected/unknown. A fixture é 100% sintética e não contém transporte executável.

O runner PostgreSQL 17.10 usa banco descartável separado, sessões distintas e locks observados: produtor versus consumidor, close antes da admissão, consumidores concorrentes, resposta perdida, prazo atravessado atrás do lock original e finish/reconcile concorrente ou com falha. Termina OFF. Nenhum teste dispara e-mail ou demonstra fila global drenada.
