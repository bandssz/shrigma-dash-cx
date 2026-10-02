# Públicos por perfil de compra — candidato em sombra

Este recorte ainda não está publicado nem ativo. A criação geral de públicos foi corrigida em produção pelas PR207/208; as categorias de relacionamento publicadas continuam sendo retratos de análise. Não usar seus números como quantidade autorizada para envio.

## Fonte e critérios

O consumidor de arquivos integra o worker existente `crm-shopify-sync` e começa desligado: `rfmRevision=null` rejeita a chamada antes de ler arquivos. O runtime e as rotas HTTP atuais não chamam `parseRfm`. A imagem atual também não inclui as novas dependências. Este código não é, sozinho, um produtor recorrente de dois Bulks.

Cada operação exige dois exports completos, distintos e conciliados da mesma loja: Customer primeiro, pedidos depois. O payload, a consulta realmente registrada em cada Bulk, os escopos, as contagens, as datas e os arquivos de código carregados são conferidos. Export parcial, ordem fora da sequência, histórico incompleto, registro duplicado, UTF-8 inválido e deriva de fonte são rejeitados. `read_all_orders` e uma consulta sem corte de datas são necessários; ausência de dados não prova ausência de compras.

Recência, frequência e valor vêm do mesmo export de pedidos atualmente `PAID`, ligados pelo Customer GID. O valor soma exatamente `currentTotalPriceSet.shopMoney`, com aritmética decimal, e não usa `Customer.amountSpent`. A medida não representa vendas líquidas. Dois Bulks sequenciais não provam um instante atômico de toda a Shopify. Fonte: [Order](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/Order), [BulkOperation](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/BulkOperation), [histórico de orders](https://shopify.dev/docs/api/admin-graphql/2026-07/queries/orders).

Os cortes usam quintis por marca, com empates na borda superior. Recência R é 6 menos o quintil de tempo desde a compra; valor M é seu quintil; frequência F é 1 para uma compra, 3 para duas ou três e 5 para quatro ou mais. Campeões têm quatro ou mais pedidos e R4–5. Leais têm mais de uma compra e R3–5, fora dos Campeões. Uma compra cai em Compra única ou Compra única em risco conforme R. Entre os demais, frequência4+ ou M4–5 caracteriza risco por frequência/valor; depois R1 é Inativo e R2 Precisa de atenção. Sem compras comprovadas, não há categoria RFM.

## Identidade e publicação da fonte

Um Customer GID só pode resolver para o mesmo contato nativo, UUID e e-mail vigente. A revisão também exige confirmação do e-mail resolvível e não ambíguo no novo Customer export; um vínculo histórico sozinho não é suficiente. A entrada privada usa um digest transitório para essa comparação. E-mail e digest não devem aparecer em `rfm_fact`, snapshots, API, recibos ou logs; digest não significa anonimização.

Ingestão e disponibilidade começam desligadas. A atualização valida tudo antes de trocar a operação atual e mantém a anterior em caso de erro. Operação/Bulk repetidos, snapshot mais antigo, fonte pausada e vencimento são rejeitados. Uma fonte pausada não é reativada por uma atualização. Fatos sem identidade permanecem desconhecidos; uma base elegível com qualquer resultado desconhecido não recebe contagem confirmada nem seleção liberada. O consentimento e opt-out são conferidos novamente no caminho regular da campanha.

O SQL atual é candidato, com guardas de contexto e dependências para ensaio local. Ainda não tem o instalador de produção selado com baseline, ACL/ownership completos, revisão e recuperação após resultado incerto. Não executar o arquivo diretamente em produção, nem reutilizar um plano ou recibo histórico como autorização atual.

## Cartões, contagem e consentimento

A fonte versionada inclui as sete quantidades de categoria, calculadas uma vez durante a troca atômica do snapshot. Os números descrevem Customer GIDs da Shopify, incluindo os ainda sem vínculo para envio. Não são a quantidade elegível de uma lista. Os cartões substituem o retrato legado somente quando a marca, versão v4, pin da fonte, operação, datas e todas as sete quantidades são válidos. Catálogo ambíguo, expirado ou divergente não prepara públicos para envio. Uma categoria com zero continua visível.

O catálogo já carregado pelo editor é compartilhado por cópia com os cartões. Não há GET adicional para montar esses cartões. Criar pelo cartão passa pelos mesmos guardas208: preservação do rascunho não salvo, confirmação da recuperação legada, resposta incerta e revalidação de marca/acesso/endpoint após a espera. O caminho completo cartão→editor→contar→salvar foi exercitado nas fontes e no bundle nas duas marcas, com dados sintéticos; não houve POST de QA em produção.

O candidato otimiza a contagem somente quando a regra raiz é uma condição RFM simples. Ele usa leitura da operação atual e joins nativos em conjunto, sem montar o snapshot JSON por contato. Regra composta mantém o caminho ternário anterior. Nenhum grant de tabela ou mudança no emissor é concedido por essa otimização. Contagem informativa não autoriza envio.

## Evidência e limites

Os recibos privados ficam em `graph-execution-next-plan/rfm-native-selection-shadow-v1/`. As revisões e falhas anteriores permanecem com seus próprios hashes. Integrações frescas usam main `f7f1739` e preservam as correções207/208, sem rebase do checkout candidato em `fd7bb4d`. O teste do painel completo inicialmente falhou porque seu harness ignorava o setup do catálogo e a escolha do bundle; corrigido o harness, integração25 passou127 testes com0 falhas/skips. O produto não precisou de correção nesse percurso.

A identidade18 e a prova nativa25 exercitaram consumidor de arquivos→ingestão restrita→catálogo/API→contagem→seleção regular nas duas marcas, com opt-out, refresh, identidade atual, rejeição de replay e sem armazenamento do digest em fatos/metadados públicos. A revisão20 passou a ler ambos os exports em chunks64KiB e validar Customer em lotes de1000, preservando duplicidade global de GID/e-mail e SHA do arquivo completo.

As provas de escala16 e26 são históricas para o recorte com apenas dois vínculos nativos. Elas não representam250mil contatos elegíveis. A escala28 passou a usar250mil e-mails atuais e estourou o heap256MiB no Node22 antes da contagem. A revisão29 compactou IDs de pedidos com BigInt e reteve apenas os nanossegundos da última compra; comparação, duplicidade, dinheiro, datas serializadas e pins de algoritmo/consulta permanecem iguais. O código da evidência mudou e precisa de pin de imagem novo.

Escala31: Node22.23.3 oficial local/Darwin arm64, PG17.10 descartável, heap256MiB,250mil clientes/vínculos nativos e500mil pedidos,214.333.370 bytes de entrada. Parse+serialização+gravação real passaram: payload56.389.913 bytes, gravação7,23s sob timeout20s, RSS amostrado551.108.608 bytes. A contagem anterior excedeu10s tanto para categoria densa quanto vazia. Escala33 mediu a contagem otimizada em0,716s para250mil elegíveis e0,523s parazero. A seleção atual selecionou1000 densos em0,078s, mas após uma atualização atômica para não compradores excedeu10s no caso vazio. Esse bloqueio impede liberação para envio por RFM.

A revisão34 validou a lista nativa depois que o catálogo foi carregado: lista removida, inativa, de outra marca ou opt-in inválido retorna fonte indisponível/NULL. Uma lista válida vazia retorna zero confirmado. Revisão37 removeu JSON de snapshot e consultas redundantes do matcher, com48 comparações de equivalência antiga/nova no PostgreSQL17; isso não eliminou o custo por destinatário em bases vazias.

A revisão40 exige que `rfm_source.shop_id` continue igual à loja Shopify da mesma marca. Ausência ou deriva torna snapshot/contagem/seleção indisponíveis e rejeita ingestão sem substituir os dados atuais. O estado enabled da fonte-pai não condiciona a fonte RFM independente. A ingestão bloqueia a fonte-pai antes da fonte RFM, na mesma ordem usada pela atualização de catálogo. Não há FK, mudança de grants ou índice adicional nessa revisão; o instalador selado ainda precisa impedir deriva de configuração após um snapshot.

Integração45 passou128 testes nas fontes e no bundle, preservando207/208. Root47 reproduziu o consumidor dos dois arquivos, papéis restritos, API/contagem/seleção, atualização, identidade e opt-out nas duas marcas em PG17.10. Escala46 repetiu250mil contatos/500mil pedidos com a loja correta: contagem passou,1000 seleções densas0,662s; seleção vazia ainda excedeu10s. Essas medições usam a expressão do matcher com contexto materializado sob papel proprietário da fixture; não provam as duas consultas NextCampaigns/NextCampaignSubscribers, o papel do emissor em produção ou o binário.

O probe38 foi corretamente recusado pelo guard de operação ao tentar mudar diretamente uma campanha draft para running. Diagnóstico44 identificou o percurso legítimo: prepare/schedule, scanner antes do horário sem resultados, espera real mínima de15min com heartbeat e as duas consultas nativas na mesma transação de medição, seguida de rollback. Não desligar guardas ou inventar flags para contornar a espera. A próxima revisão precisa otimizar em conjunto somente a regra raiz RFM, revalidando integralmente desconhecidos e consentimento; regras mistas mantêm o matcher anterior até prova própria.

Os vínculos de250mil contatos nessa prova foram gerados na fixture; não provam a importação real dessa cardinalidade. A segunda atualização para medir seleção vazia foi um array sintético SQL, não dois Bulks reais. Node22 local não prova o digest OCI, o container inteiro ou o runtime HTTP. O estado reduzido e os parâmetros ainda usam memória proporcional a clientes/pedidos. O heap permaneceu próximo do limite; é necessário provar o pipeline completo e seu isolamento/chunking antes de dimensionar produção.

## Fechamento em sombra — revisão65/root74

O fast path agora compõe as duas consultas nativas somente para regra raiz RFM bound, sem chaves de A/B. Os ramos rápido e legado são disjuntos; mistos, unbound e A/B continuam com o matcher anterior. `campLists` conserva a exigência de campanha running e precede o contexto/materialização do helper. Draft e scheduled retornam vazio, sem chamar o helper. Dados desconhecidos são validados na base inteira antes de cursor e LIMIT. Não há grant dos helpers para API/coletor; o instalador de produção continua pendente.

A integração66 passou131 testes, sem falhas/skips, preservando as fontes e o bundle207/208. A tentativa anterior com três testes pulados foi preservada e repetida com a fixture upstream exata. Root67 reproduziu a cadeia em PG17.10 nas duas marcas. Root68 mediu helpers em250mil contatos: dense2,12s,zero1,15s,sparse1,47s/10IDs; identidade desconhecida fora da página bloqueou o resultado.

Root69 executou as duas consultas completas novas após prepare/schedule verdadeiro,930segundos e heartbeat. Antes do horário, scanner e destinatários retornaramzero. Depois: dense1000 em2,476s (scanner1,189s);zero em1,305s (scanner0,668s). A query histórica084a ficou byte-exata e havia excedido10s no scanner em ambos os casos. O novo pin f8bfbb7f não foi aprovado como deployment: a fixture continua084a e executou o SQL candidato sob proprietário, sem binário/papel de produção. A/B composto usa contexto/helper sintéticos e não prova uma stack A/B completa agendada. Snapshotszero/sparse foram gerados SQL. Node22.23.3/Darwin não prova OCI. Nenhum banco de prova permanece ativo e nenhum e-mail foi enviado.

O produtor recorrente ainda não existe: main não passa rfmRevision e runtime/HTTP não chamam parseRfm. O journal atual registra apenas um Bulk de produtos. Requer fases duráveis Customer→Paid Orders sob o mesmo mutex, start intent por query, recuperação de respostas incertas e GET-only para confirmar o commit RFM; nunca repetir ingest após ACK incerto sem reconciliação. Os Bulks legados do n8n ainda ficam fora desse mutex. Não adicionar scheduler paralelo. A configuração do serviço foi inspecionada sem mudança, mas read_all_orders precisa prova da identidade OAuth exata do serviço, com credenciais montadas em arquivo privado.

As revisões49/54/58 e as integrações recusadas52/59 ficaram preservadas com seus bloqueios; somente65/66/67/68/69/70 descrevem este recorte final. O índice de hashes e limites é root-shadow-closeout74/closeout-safe.json. Estas provas não equivalem a ativação ou publicação RFM.

## Próxima entrega integrada

Provar regras compostas/A-B com cardinalidade nativa quando aplicável. Integrar no coletor existente o journal durável dos dois Bulks, downloads, recuperação após resposta incerta, lease global, ingestão em partes e finalização atômica. Preparar instalador OFF selado, imagem exata, cadência e leitura final nas duas lojas. Publicar somente em uma janela permitida e após esses gates. Não abrir outra instância, executar workflows à força ou enviar e-mails de QA a clientes.
