# Preparação durável de revisão — candidato em sombra

Este módulo prepara e relê um snapshot imutável, usando o material real do primeiro e-mail de carrinho da marca. Não há rota HTTP, capability pública, publicação, ativação, entrada de participante ou transporte. `enabled` e todas as autorizações de execução continuam `false`. Nenhuma instalação em produção faz parte deste recorte.

## Resultado concreto

`createLifecyclePreparer` combina o reviewer existente com os contratos SQL `catalog_v1`, `release_source_v1`, `release_prepare_v1` e `release_get_v1`. O material completo inclui corpo, assunto, remetente, resposta, descadastro, variáveis e requisitos de identidade/compra/consentimento. Contatos e eventos de clientes não são consultados.

O armazenamento possui três tabelas próprias, imutáveis: evidência de revisão, snapshot preparado e recibo da operação. A preparação persiste material/release e recibo na **mesma transação**. Não altera `journey`, `revision`, publicação, pausa ou controle. `proposed_revision` é uma proposta, `revision_reserved=false`; o identificador preparado é um UUID no espaço próprio, sem representação na tabela de revisões do runtime.

O catálogo real ainda informa `contact.email_allowed.available=false`. A composição preserva essa informação. Acrescentar a política existente `purchase.observed_for_cart` e vincular um material completo não comprova que o adaptador de elegibilidade está disponível: o snapshot registra `runtime_graph_valid=false` e os bloqueios humanos. Não inventa valores de compra, consentimento, destinatário ou checkout de cliente.

## Interface local

```js
const {createLifecyclePreparer}=require('./journey-graph-lifecycle-prepare.cjs');
const api=createLifecyclePreparer({pool,checkoutSha});
// checkoutSha: SHA Git completo (40 caracteres), fornecido pelo integrador
// confiável do checkout executado; não é aceito no corpo de uma solicitação.
const reviewed=await api.review({
  action:'review',brand:'fish',journey_id,expected_version
},{authorization});
const command={action:'prepare',brand:'fish',journey_id,expected_version,
  request_id,review_hash:reviewed.review.review_hash,confirm:'preparar'};
const result=await api.prepare(command,{authorization});
const readback=await api.operation({action:'operation',brand:'fish',request_id},{authorization});
```

O `pool` precisa emprestar uma conexão exclusiva até `release`, com timeout do **servidor** previamente configurado entre 1 e 20.000 ms e isolamento READ COMMITTED. O módulo recusa timeout zero/alto e outro isolamento antes de `BEGIN`, após espera e antes de `COMMIT`; não substitui essa garantia por temporizador JavaScript. `SET LOCAL lock_timeout` limita a espera de locks e não é apresentado como prova do timeout da conexão. Uma resposta de sucesso só sai depois de `COMMIT` confirmado.

`catalogFor`, quando fornecido, é uma dependência confiável no servidor; o padrão chama o catálogo SQL real. O chamador não injeta catálogo, actor, permissions, release/native id ou habilitação no corpo. O SHA do checkout é um pin de configuração, não uma atestação independente da árvore de arquivos: a futura composição operacional terá de verificar o checkout antes de construir o adaptador.

Autenticação usa `shrigma_panel_operator_v1`, incluindo as chaves longas/curtas e o actor retornado pelo helper, e confere `expira_em > clock_timestamp()` na mesma identidade. Isso fecha a expiração durante espera: o helper compartilhado usa `now()`, fixado no início da transação. Chave, permissões e actor são conferidos novamente depois das esperas, depois do material e antes da resposta. Não há fallback de autenticação legada.

`review` grava somente evidência de revisão compatível; uma revisão bloqueada retorna os motivos sem material ou snapshot preparado. É uma composição persistente distinta do reviewer original, que continua somente leitura. A evidência fixa actor, marca, jornada, versão/head, conteúdo/catálogo, fonte, material, checkout e a encarnação `xmin` da linha de controle OFF. A preparação busca essa evidência durável, verifica validade de 30 segundos, gera nova revisão somente leitura para comparar pins, trava controle/jornada e os registros da fonte escolhida. Um hash fornecido pelo navegador, sozinho, nunca é autoridade. O rascunho original é preservado.

Preparar usa `read_content` + `submit`, e a nova conferência requer também `validate`. Revisar usa `read_content` + `validate`. Releituras exigem `read_content` e o **mesmo actor e marca** do recibo. Podem consultar uma preparação histórica mesmo depois de o catálogo, rascunho, checkout ou controle mudar; isso não a revalida para publicar.

## Resposta incerta e integridade

`GRAPH_PREPARE_OUTCOME_UNKNOWN` em `prepare` inclui o `request_id` original. O módulo não reenvia, não faz nova operação e não transforma ausência em prova de rollback. O integrador deve consultar `operation` com o mesmo identificador. Ausência retorna `state:'unconfirmed', automatic_retry:false`. Replay explícito de uma preparação confirmada devolve o recibo original somente se o corpo exato e a autenticação ainda conferirem. Outro corpo com o mesmo UUID é recusado; outro UUID tentando consumir a mesma revisão é recusado.

Se a resposta de `review` se perder no commit, o erro inclui `review_hash` e `brand`. `reviewRecord({brand,review_hash},{authorization})` relê aquela evidência sem repetir a gravação. Uma evidência expirada pode ser consultada, mas não preparada. Falha de rollback descarta a conexão; um próximo usuário do pool não pode confirmar uma transação parcial.

São dois contratos de hash diferentes e explícitos: `canonical_json_sha256_v1` para revisão, conteúdo e snapshot; `postgres_jsonb_text_sha256` para o material persistido pelo SQL de release. A releitura recalcula ambos e valida a ligação entre material, catálogo, base, recibo e release. Corpo e outras informações do material são conteúdo autorizado: não devem ser registrados em logs genéricos. Falhas do adaptador/SQL são retornadas como códigos fixos sem detalhes sensíveis.

## Quem poderá consumir o snapshot

Uma futura fronteira autenticada de **publicação operacional** poderá reler `operation`, verificar o snapshot/recibo imutável e repetir a conferência fresca de actor, capabilities, checkout, controle, rascunho/CAS, catálogo e fonte. Ela ainda terá de conferir cópia nativa imutável, instância/cache e adaptadores disponíveis, e então reservar uma revisão real. Esse consumidor não foi implementado aqui.

O `runtime.publish` legado aceita revisões de planejamento; ele **não deve receber este snapshot por cópia direta** nem ser apresentado como publicação operacional. A separação física das tabelas impede adoção automática: o módulo não grava head/revisão/publicação. Tampouco prepara acesso do worker, serviço, credencial, retenção ou admissão. Compra, opt-out, confirmação, bloqueios, envio único e resposta incerta de transporte continuam sendo conferências obrigatórias do percurso de execução já existente, não decisões antecipadas pelo snapshot.

## Provas locais e limites

Os testes criam bancos PGlite descartáveis com o store, catálogo, release, helpers de autenticação e runtime reais; usam somente dados sintéticos. Exercitam Fish e Aristo, readback em uma nova instância, rollback entre release e recibo, ACK perdido, ausência, CAS, fonte/controle/checkout divergente, autenticação longa/curta, revogação/expiração durante espera e após material, TTL, hashes, isolamento/timeout e imutabilidade. Nenhum participante, intent ou envio é criado; native templates e head do rascunho permanecem idênticos.

```sh
node --test tests/journey-graph-lifecycle.test.cjs tests/journey-graph-lifecycle-prepare.test.cjs
```

PGlite valida SQL/contratos e falhas simuladas, mas não prova concorrência entre sockets, perda real da conexão ou comportamento de cancelamento do PostgreSQL de produção. Ainda serão necessárias essas provas em PostgreSQL 17 antes de instalação. A migração candidata não dá grants e não modifica o papel executor. Integração no painel, endpoint, permissões administrativas mínimas, publicação e ativação seguem pendentes. Nenhum aceite de produção foi feito nesta rodada.

### PostgreSQL real — 29/09/2026

O runner `tests/journey-graph-lifecycle-prepare-postgres.cjs` foi executado
em PostgreSQL17.10 descartável, com conexões independentes e dados sintéticos.
Fish/Aristo prepararam e recuperaram o mesmo recibo em duas solicitações
concorrentes; falha na gravação do recibo reverteu a preparação inteira.
Após COMMIT real, o teste fechou a conexão antes de entregar a resposta ao
chamador e recuperou o recibo por outra conexão. Isso exercita a resposta
incerta, sem afirmar perda de pacote em uma rede externa.

Uma trava real manteve a solicitação aguardando até a chave expirar pelo
relógio do banco; a preparação foi recusada após a espera. Revogação de
permissão por outra conexão, depois da geração do material, também reverteu
a escrita. Templates e revisões originais permaneceram iguais, controle OFF,
zero participantes, intenções e envios. Os24testes anteriores continuam verdes.

A prova usa o dono do banco sintético para testar transações; não comprova
as permissões de uma futura API de produção. Publicação operacional,
clone/cache, ativação e percurso integrado no painel continuam pendentes.
