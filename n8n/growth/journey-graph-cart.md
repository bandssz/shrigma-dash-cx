# CART → grafo: ponte candidata, desligada

O recorte cobre somente o primeiro e-mail de carrinho (30 minutos), Fish e Aristo. Reutiliza `shrigma_email_claim_cart` e `shrigma_email_finish_cart`; não cria transporte nem substitui o executor legado. Instalação, fonte real, autorização HTTP, agendamento, anúncio de capacidades e ativação permanecem etapas separadas. Os testes usam contatos sintéticos e não enviam mensagens.

## Identidade, época e pausa

`cart_control_v1` nasce `enabled=false` nas duas marcas. `cart_epoch_open_v1(actor,brand,journey_id,expected_version,cache_target)` fixa uma revisão publicada, um material v2 e um clone nativo pronto. O início vem do relógio do banco: só carrinhos cujo `ref` esteja na época pertencem ao grafo. Há no máximo uma época aberta por marca e a revisão deve conter uma única mensagem de e-mail. `cart_enroll_v1(brand,entry_id)` vincula entrada/fonte/época imutavelmente; não adota carrinhos anteriores nem redefine a janela original de uma hora.

Pausar ou fechar uma época conserva a propriedade. O hook no claim legado recusa a coorte inclusive antes da criação de sua entrada, evitando fallback silencioso para outro conteúdo. Não há fila de retomada automática neste módulo. Falhas de captura podem deixar carrinhos da coorte sem envio: a futura ativação precisa observar essa cobertura antes de abrir a época.

## Claim e recibo

O servidor chama `createCartBridge({query,cacheTarget}).claim({brand,intent_id,expected_entry_version,preflight})` dentro da mesma transação do preflight. A prova privada é `journey_graph_message_preflight_v1`, com identidade do assinante, URL original, material/clone e prazo de até cinco segundos. Ela nunca vem de um formulário ou endpoint do operador. O adaptador confere a URL canônica; o SQL revalida a identidade nativa, elegibilidade, material, clone, revisão e prazo depois dos locks. A prova Shopify é responsabilidade do callback confiável do preflight; o SQL não a fabrica.

`cart_claim_v1(text,uuid,integer,jsonb,text)` retorna exatamente `{should_send,dispatch_id,claim_token,payload,context,reason}`. Só o primeiro vencedor recebe token, payload e contexto. Esse retorno é privado e efêmero. O contexto preserva `graph_expires_at`; ultrapassar esse instante depois do commit não autoriza iniciar HTTP ou renovar a prova. O estado reservado deve ser consultado/conciliado, sem simular aceitação ou rejeição.

A chave original é `(brand,carrinho,carrinho-30min,[email,ref UTC em milissegundos,subscriber_id,false])`. Não muda para o ID do grafo. Reserva original e vínculo `cart_delivery_v1` são atômicos. Uma reserva legada anterior bloqueia o grafo, mas não é apropriada por ele. `cart_dispatch_v1(brand,intent_id)` reconfere vínculo e segura o dispatch `FOR SHARE` até o fim da transação; não devolve token, destinatário ou conteúdo. O finish original usa o mesmo contexto e token; não foi alterado.

## Ordem e integridade

A retenção deve estar instalada antes da execução. `cart_maintenance_guard_v1()` exige gate `enabled/open`, mantém `FOR SHARE` até commit e recusa gate ausente ou fechado. A ordem coordenada é gate de manutenção → controle global → controle da marca → jornada → entrada/intenção → advisory legado → dispatch → assinante/listas. O preflight de claim não trava previamente o assinante. O finish original usa dispatch → assinante; aplicação do recibo na entrada ocorre em transação posterior. O hook legado não adquire locks de jornada/entrada.

O patch exige hashes exatos das duas funções originais e quatro âncoras únicas do claim. Mudança no banco exige novo review; a instalação recusa drift e colisão em vez de sobrepor uma versão. O namespace de permissão temporária existe somente na transação, guarda hashes e é removido antes do retorno. O clone é fixado depois do slot legado, preservando sua pausa/cadência sem deixar um template editável substituir o clone. TTL vencido durante a reserva desfaz a subtransação inteira.

A migração é exclusiva e transacional, não um instalador repetível. PUBLIC não recebe permissões. Papel SQL, ator, callbacks, cacheTarget e endpoint nativo são dependências confiáveis da instalação; este módulo não implementa autenticação pública. `cacheTarget` não comprova sozinho a topologia/cache da instância.

## Provas

`tests/journey-graph-cart.test.cjs` usa o SQL original exportado em fixture sintética: ambas as marcas, propriedade/pausa, clone, dedupe, finish, drift, prova inválida e rollback do vínculo. `journey-graph-cart-postgres.cjs` exige banco descartável `journey_graph_cart_test`, usuário `synthetic`, localhost:5432 e `GRAPH_TEST_DATABASE_ISOLATED=1`; verifica concorrência real, leitura do recibo versus finish, opt-out durante espera e prazo atravessado antes/dentro da reserva. O runner não é executado em produção.

## Coexistência ainda necessária no produtor

O produtor de retenção deve reconhecer `graph_owned` como propriedade do grafo antes de enfileirar/retomar, sem descartar o recibo. O SQL de retenção atual trata recusas desconhecidas como `review_required`; essa classificação genérica não é uma transferência operacional comprovada. Um patch específico de coexistência (produtor e eventos já retidos) ainda precisa ser revisto antes da ativação. Esta migração não altera a retenção nem finge drenar eventos existentes.
