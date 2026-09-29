# Revisão operacional do grafo em sombra

A revisão descrita abaixo agora é consumida pela preparação durável e pelo [candidato de publicação pausada integrado ao painel](journey-graph-lifecycle-publication.md). O texto desta página descreve o módulo de leitura; ativação e envio continuam indisponíveis.

Este recorte confere um rascunho salvo e devolve uma **proposta de nova revisão**. Não salva nem altera a revisão original, não prepara release persistido, não cria clone, não publica, não admite, não ativa e não envia. Não há endpoint, anúncio de capacidade, serviço ou adaptação de produção. `ENABLED=false` e todas as autorizações da resposta permanecem `false`, mesmo quando a proposta é compatível.

## Interface somente de leitura

```js
const {createLifecycleReviewer} = require('./journey-graph-lifecycle-review.cjs');
const reviewer = createLifecycleReviewer({provider, timeoutMs: 10000});
const result = await reviewer.review({
  action: 'review', brand: 'fish', journey_id, expected_version
}, {authorization});
```

`provider` é uma dependência confiável do backend. Não vem do navegador e não recebe SQL ou métodos escolhidos pelo operador. Deve implementar somente as leituras abaixo. Cada método recebe `signal` e deve obedecer ao cancelamento e aos limites de sua conexão. O módulo não escolhe credencial, transporte, banco, relógio do servidor ou instância Listmonk.

| Método | Entrada adicional | Resposta exata |
| --- | --- | --- |
| `authenticate` | `authorization` | `{actor,caps,checked_at}` da autenticação Growth vigente |
| `readDraft` | `brand,journey_id` | `{server,definition,catalog,content_hash,checked_at}`; os três últimos campos de conteúdo pertencem à mesma revisão armazenada |
| `readCatalog` | `brand` | `{catalog,checked_at}`; catálogo atual de planejamento |
| `readSource` | `brand,binding` | `{source,checked_at}`; `source` tem exatamente o formato de `release_source_v1`, ou `null` para uma incompatibilidade confirmada de vínculo/slot |

`server` conserva os seis campos do contrato publicado: `journey_id`, `brand`, `version`, `revision`, `published_revision`, `paused`. `source` contém `brand`, `template_id`, `binding`, `source_snapshot`, `native`, `slot`, `published_version`. O corpo nativo fica apenas em memória para reutilizar `prepareMaterial` v2. Ele não aparece na resposta. Falha de acesso, SQL, transporte ou leitura não pode ser convertida em `source:null` pelo adapter.

O futuro adapter deve abrir transações de leitura com limites e consultar o estado atual em cada chamada; arquivos, snapshots constantes e valores do cliente não satisfazem essa interface. `checked_at` é horário da leitura concluída, UTC exato com milissegundos, não um carimbo acrescentado a dados em cache. O módulo recusa horário futuro ou mais de 30 segundos antigo. O prazo total configurável é 10 segundos, com teto de 20 segundos. Isso limita a resposta e impede próximas leituras após cancelamento; não prova que um adapter que ignore `signal` parou sua conexão externa.

A conferência autentica antes das leituras e no final, exigindo `read_content` e `validate` e a mesma identidade `panel:`. Copia o pedido antes do primeiro `await`. Lê a revisão e catálogo, confere o hash canônico armazenado e o `expected_version`, consulta a mensagem selecionada e relê todos esses pins. Versão, conteúdo, catálogo, fonte ou autoria divergentes impedem retornar proposta. Não há cache entre invocações ou marca de leitura gravada no banco. A releitura reduz a janela de mudança durante a revisão; **não substitui locks, CAS e autenticação na futura escrita**.

## Proposta e limites

`state=compatible_for_preparation` significa apenas que o rascunho e a mensagem consultados cabem no recorte. A proposta conserva a definição, identifica a versão de origem e sugere `revision+1`, com `revision_reserved:false`. Nenhum número de revisão foi reservado. `release_id`, `native_id` e `operational_catalog` permanecem `null`.

O primeiro recorte aceita somente Fish/Aristo, `cart.abandoned`, uma mensagem de e-mail e o slot publicado `email:carrinho-30min` da própria marca. Usa a fonte atual do slot, sem assumir que um ID histórico de template continua correto. Outros gatilhos, nenhuma/várias mensagens, WhatsApp, vínculo divergente, dados materiais incompatíveis e catálogo alterado recebem motivos em português. O validador existente confere os caminhos e condições. O maior prazo entre caminhos possíveis, incluindo espera por dado desconhecido, precisa ficar abaixo de uma hora. Esse limite de planejamento não renova a idade do carrinho nem garante prazo restante suficiente na futura admissão.

O preparador material existente confere variáveis, itens, link do carrinho, descadastro nativo, remetente e identidade da marca. A política `cart_customer_order_observation_v1` continua fixa no backend: observação de pedido do cliente vinculado, não ausência universal de compra. A proposta não marca consentimento como disponível, não altera o catálogo de planejamento e não converte dados desconhecidos em `false`. Consentimento, compra observada, supressão e validade devem ser conferidos no percurso real antes da reserva e do envio.

`source_plan_hash`, `material_plan_hash` e `planning_catalog_hash` usam `canonical_json_sha256_v1`. São hashes desta proposta; **não são o `material_sha256` calculado pelo PostgreSQL sobre `jsonb::text`**. `review_hash` inclui o resultado completo, pedido, autoria e prazo. É checksum de integridade, não assinatura, autenticação, recibo durável ou autorização de envio. A resposta não traz token, autor, HTML, destinatário ou dados de pessoas.

## Vocabulário futuro, ainda sem executor

`journey-graph-lifecycle-contract.cjs` valida campos exatos, Fish/Aristo, UUIDv4, hashes, versões e confirmação literal. O autor nunca é campo do comando. Campos extras, inclusive facts, provas, URL, capabilities e identidade do executor, são recusados. Os validadores não instalam nem executam nenhum dos comandos abaixo.

| Comando | Campos além de `action,brand` | Confirmação | Permissões a reconferir |
| --- | --- | --- | --- |
| `review` | `journey_id,expected_version` | — | `read_content,validate` |
| `status` | `journey_id` | — | `read_content` |
| `operation` | `request_id` | — | `read_content`; autoria/marca originais |
| `prepare` | `journey_id,expected_version,request_id,review_hash,confirm` | `preparar` | `read_content,submit` |
| `publish` | `journey_id,expected_version,request_id,prepared_revision,prepared_hash,confirm` | `publicar` | `read_content,submit` |
| `activate` | `journey_id,expected_version,request_id,published_revision,publication_hash,admission_review_hash,confirm` | `ativar` | `read_content,submit` |
| `pause` | `journey_id,expected_version,request_id,published_revision,confirm` | `pausar` | `read_content,submit` |

O futuro executor precisa resolver cada hash para sua evidência confiável exata e vigente; o checksum recebido sozinho é insuficiente. A revisão atual não grava essa evidência, portanto `prepare` ainda não tem percurso executável por esta interface. Preparação/publicação precisam de recibos duráveis próprios, reautenticação após locks, CAS e comparação dos pins. Identidade repetida com o mesmo payload deve consultar o recibo original; autoria, marca, ação ou payload diferentes devem ser recusados. Uma resposta incerta não autoriza nova identidade, nova criação de clone ou novo envio.

Publicação deve produzir revisão operacional nova e pausada, com release/catálogo fixados, mantendo o rascunho original e participantes antigos. Ativação exige controles, clone/cache da instância correta, época e entrada de eventos comprovados. `runtime.pause(false)` sozinho não atende esse contrato. Pausa deve continuar possível sem exigir que os gates de ativação estejam saudáveis, preservando ownership, reservas e recibos. O papel `crm_graph_worker` permanece sem lifecycle/admissão/alteração de controles.

## Verificação local

`node --test tests/journey-graph-lifecycle.test.cjs` cobre ambas as marcas, revisão fresca/antiga, hash incorreto, drift entre leituras, revogação de capacidades/autoria, cópia do pedido, timeout, erros sanitizados, recusas de escopo e zero chamadas de escrita. Um teste usa as funções SQL existentes em PGlite, em transação `READ ONLY`, e confere que templates e tabelas de release/recibo não mudaram. Não é prova PostgreSQL remoto, clone/cache, implantação ou operação completa.

Permanecem os próximos elos: preparação/publicação durável, fronteira autenticada, ativação/pausa coordenadas, admissão, ligação do coletor, agendamento e acompanhamento por jornada. Esta revisão não conclui o construtor operacional.
