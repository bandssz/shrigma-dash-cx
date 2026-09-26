# Segmentos Growth v1 — contrato de preparação e contagem

Estado: candidato local, sem endpoint, instalação ou envio. `TRANSPORT_SUPPORTED=false`.

## Limite comprovado do Listmonk 6.1.0

A hipótese de configurar `campaigns.subscriber_query` não se confirma no release oficial: o [modelo Campaign](https://github.com/knadh/listmonk/blob/v6.1.0/models/campaigns.go), o [schema](https://github.com/knadh/listmonk/blob/v6.1.0/schema.sql) e a [persistência de campanhas](https://github.com/knadh/listmonk/blob/v6.1.0/internal/core/campaigns.go) não contêm esse campo. Na [API documentada](https://listmonk.app/docs/apis/campaigns/), `query` filtra nome/assunto de campanhas; não seleciona seus destinatários. Não enviar uma propriedade desconhecida esperando que ela restrinja o público. Esta leitura não identifica um eventual binário customizado instalado.

## Interface pura

`normalize({schema_version:'crm-segment-v1',brand,name,rule})` aceita somente Fish/Aristo. Folha: `{op:'in_list',list_id:123}`. Grupo: `{op:'and'|'or',rules:[...]}`. Não aceita SQL, NOT, nomes de colunas, contatos ou campos arbitrários. Limites: profundidade 4, 32 nós, 16 filhos por grupo; nome até 160 caracteres. Retorna cópia canônica, ordenando/removendo repetições equivalentes no mesmo grupo.

`compileCount(definition,{catalog,baseListId})` recebe catálogo e base da configuração **confiável do servidor**, nunca como prova de autorização enviada pelo navegador. Todos os IDs, inclusive a base, precisam constar uma única vez no catálogo atual da marca e estar disponíveis. A base não é inferida pelo contrato: 16/17 não são autorização.

A saída contém `text` e `values` para execução parametrizada, definição canônica e IDs de listas. Só a consulta agregada retorna `source_confirmed`, `eligible_count` e `checked_at`; não retorna assinantes. Exige `subscribers.status='enabled'`, vínculo válido com a base e consentimento nas folhas: double exige confirmed; single aceita confirmed/unconfirmed. A origem das listas é reconferida pela função existente `shrigma_campaign_list_brand`. Lista removida, inativa, remapeada ou com opt-in desconhecido gera `source_confirmed=false` e contagem **nula**, não zero.

A contagem é uma leitura naquele instante, não uma reserva de destinatários. Uma mesma pessoa é contada uma vez. Não substituir a conferência de público da campanha por este número nem anunciar envio disponível: ainda faltam ponte autenticada, vínculo da revisão com a campanha e um adaptador que aplique o mesmo predicado durante a seleção real. Não criar listas derivadas que percam o descadastro das listas de origem.

## Evidência

`tests/segment-contract.test.cjs`: rejeição de SQL/campos extras/IDs inválidos e limites; catálogo/base/brand obrigatórios; E/OU executado em PostgreSQL embarcado (PGlite), nas duas marcas, com opt-out, dupla confirmação, status global, falta de base e origem alterada. Isso não comprova o emissor ou capacidade instalada. Nenhuma consulta de produção é feita pelo módulo/teste.

## Armazenamento e contrato do backend

`segment-store.sql` é uma instalação nova, atômica, que recusa colisões. Cria somente `shrigma_segment_config`, `shrigma_segment`, `shrigma_segment_revision` e `shrigma_segment_request`; Fish/Aristo nascem com `enabled=false` e base não configurada. Todas as funções são `SECURITY INVOKER`, com `search_path` fixo e execução pública revogada. Não configura credenciais nem concede acesso a papéis operacionais.

A função `shrigma_segment_api_v1(actor text,caps jsonb,p jsonb)` é uma interface **interna confiável**, não um endpoint autenticado. A futura ponte deve obter ator/capabilities exclusivamente de autenticação estrita do painel Growth, nunca do corpo enviado pelo cliente, limitar duração/tamanho e não conceder acesso SQL direto ao navegador. Permissão de área não significa ACL individual por marca: gestores Growth podem trabalhar com Fish e Aristo. A base vem da configuração do servidor e sua associação atual é reconferida junto às demais listas.

| Ação em `p.acao` | Campos além de `brand` | Resultado |
| --- | --- | --- |
| `segmentos_listar` | `limit` até 100, `offset` até 10000, opcionais | `segments`, página, capabilities `draft/count/send` |
| `segmento_obter` | `id` | Segmento atual, inclusive arquivado |
| `segmento_criar` | `definition`, `idempotency_key` | Nova identidade e revisão 1 |
| `segmento_salvar` | `id`, `expected_version`, `definition`, `idempotency_key` | Nova revisão da mesma identidade |
| `segmento_arquivar` | `id`, `expected_version`, `idempotency_key` | Arquivado, com revisão e histórico preservados |
| `segmento_contar` | **ou** `definition` **ou** `id` + `expected_version` | Contagem agregada, origem confirmada, horário e revisão quando salva |
| `segmento_operacao` | `idempotency_key` | Recibo do mesmo ator/marca ou `SEGMENT_OPERATION_UNCONFIRMED` |

Leituras/contagem exigem `read_content`; criar/salvar/arquivar exigem `draft`. A resposta usa `_http` e `_body`. Uma capability ativa anuncia apenas preparação/contagem; `send` e `transport_supported` permanecem falsos. Nenhuma operação altera campanhas, contatos, vínculos ou listas nativas.

Toda mutação aceita chave de operação de 8–128 caracteres (`A–Z`, `a–z`, números, `_ . : -`). O bloqueio da chave vem antes da configuração e da linha do segmento. A versão esperada é obrigatória para edição/arquivamento; payload ou marca diferentes com a mesma chave são recusados. Segmento, revisão e recibo são gravados na mesma transação. Rejeições definidas também têm recibo; resposta perdida/timeout não vira rejeição e não autoriza criar outra chave. Consultar a operação é somente leitura. Recibo antigo não é recalculado após outra versão ou desativação da configuração; permissões ainda são verificadas. Falha inesperada aborta a transação.

A contagem não fica gravada como número atual do segmento: cada consulta reavalia base, listas e consentimento naquele instante. `definition_hash` é o SHA-256 da definição normalizada pelo PostgreSQL; o cliente não deve recalculá-lo a partir da ordem das chaves JSON. Consultas com identidade salva incluem a versão conferida; editar invalida a contagem anterior.

`tests/segment-store.test.cjs` executa instalação OFF/colisão, CRUD/histórico, CAS, recibos exatos, isolamento por ator/marca, ACL, atomicidade com falha na escrita do recibo, contagem e paridade com o contrato puro. A prova local é PGlite; não substitui o ensaio de concorrência em PostgreSQL real nem a instalação com papel mínimo. Ainda faltam ponte autenticada, interface, validação de configuração/roles em ambiente isolado e integração ao emissor antes de disponibilizar seleção para envio.

## Possível reaproveitamento do candidato A/B — não implementado

O candidato A/B já altera as duas consultas nativas de admissão/contagem e seleção por lote, preservando consentimento original. Ele não fornece um predicado genérico de segmento. Uma futura integração poderia ligar **campanha + identidade/revisão imutável do segmento** a essas duas fases e reavaliar o consentimento nas listas de origem por lote. Precisaria de sua própria guarda OFF, paridade entre contagem/seleção, prova de desempenho e revisão de composição com A/B, mantendo campanhas comuns inalteradas. Não converter segmento em braço A/B, não congelar uma contagem como autorização e não publicar só o vínculo de UI: o emissor atual não aplica este contrato. Nenhum arquivo A/B foi alterado.
