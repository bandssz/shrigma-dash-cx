# Serviço de públicos do CRM

Host HTTP para gestão de públicos (`/segments`), vínculo e agenda regular (`/campaign-audience`) e A/B (`/ab-experiments`). Novos vínculos e agendas têm gates próprios, desligados por padrão. O serviço não instala SQL, altera contatos ou emite mensagens. Após autenticação, renova exclusivamente o catálogo nativo de listas e registros de abertura/clique pela função SQL revisada. Nasce com `CRM_AUDIENCE_ENABLED=false`; nesse estado apenas `GET /healthz` responde normalmente.

## Fronteira

O navegador envia o bearer humano em `Authorization`; o serviço não possui token próprio e não traduz essa identidade. Cada API valida o bearer novamente no PostgreSQL. CORS permite somente `https://bandssz.github.io`; chamadas sem `Origin` continuam possíveis para probes internos, mas não ganham cabeçalho CORS.

O host aceita `GET` e `POST` em `/segments`, `/campaign-audience` e `/ab-experiments`, mais o preflight `OPTIONS`. POST exige JSON UTF-8 estrito e corpo de até 32 KiB. Query duplicada, dois headers de autorização, codificação de conteúdo, JSON inválido e `Content-Type` diferente de `application/json` são recusados antes da API. Há no máximo quatro requisições simultâneas e nenhuma fila ou retry interno.

Cada operação recebe uma conexão exclusiva do pool, uma transação `READ COMMITTED` e `statement_timeout=10000ms`. A role precisa ser exatamente `crm_audience_api`. O retorno só acontece após `COMMIT` confirmado. Erro, abort, rollback não confirmado ou perda do ACK do commit descarta a conexão. A parada deixa handlers e transações ainda vivas terminarem antes de encerrar o pool, inclusive quando o prazo HTTP já encerrou a resposta.

`GET /healthz` mostra apenas serviço, revisão, estado OFF/ON e parada em curso. Não testa banco, catálogo, schemas, grants, consentimento, capacidade do painel ou seleção Listmonk.

## Configuração e limites

Variáveis obrigatórias: `CRM_AUDIENCE_REVISION` (SHA Git completo), `CRM_PG_HOST`, `CRM_PG_USER=crm_audience_api`, `CRM_PG_PASSWORD` e `CRM_PG_DATABASE=listmonk`. `CRM_AUDIENCE_ENABLED` aceita somente `true` ou `false` e assume `false`. A imagem não contém segredos. `CRM_AUDIENCE_BINDING_ENABLED` também nasce `false`: habilitar gestão de públicos não libera novos vínculos. Deixe esse segundo gate desligado na publicação enquanto a seleção operacional não estiver concluída.

Os schemas/grants e a configuração inicial são responsabilidade do instalador. O refresh transacional só aceita os hashes semânticos de listas/eventos nativos que esta versão implementa; base, marca ou fontes divergentes bloqueiam a operação. Compras, produtos e origem não são anunciados como disponíveis. Os locks nativos ficam em helpers sem poder de alterar dados; a role não recebe UPDATE em campanhas, listas ou contatos. A conferência agregada usa o provider de contagem existente e deve continuar distinguindo fonte não confirmada de zero elegíveis. Vínculo e conferência permanecem `authorizes_selection:false` e `authorizes_send:false`; o guard de campanhas continua necessário até existir binário Listmonk revisado, seleção operacional e aceite separado.

A implantação candidata usa uma réplica inicialmente OFF, pool máximo 4, sem reiniciar n8n, PostgreSQL ou Listmonk. Ativar a capacidade pública só depois de instalar e reler schemas/ACLs, confirmar o catálogo das duas marcas e passar o percurso DOM→HTTP→PostgreSQL. Trocar este serviço por uma nova imagem exige apenas o rollout desta réplica; o restart do Listmonk pertence ao recorte futuro do binário de seleção.

## Validação da campanha vinculada

`campanha_publico_validar` passa pelo endpoint do vínculo e exige `validate` + `read_content` atuais do Gestor. Relê a versão nativa, vínculo, revisão imutável, catálogo, conteúdo e opt-out. A conferência é uma leitura sem mutação, com locks compartilhados durante a contagem; dura no máximo 60 segundos e não reserva pessoas. Fonte desconhecida retorna quantidade nula, e zero só aparece quando a consulta prova que ninguém é elegível. O editor chama essa rota para vínculos, sem acionar a revisão legada da base. A validação permanece em memória, sem gerar recibo de envio.

`segment-runtime-access.sql` é um único DO atômico, cria role NOLOGIN, sem permissões de transporte, e revoga PUBLIC nos helpers. Login/senha são provisionados separadamente em memória. A instalação composta exige pins frescos das dependências e readback de proprietários/ACLs; os scripts isolados não são autorização de implantação.

Provas disponíveis: testes DOM/PGlite do editor e `tests/crm-audience-runtime-postgres.cjs` com PostgreSQL 17.10 real, socket HTTP local, role dedicada e ambas as marcas. O runner verifica criação, vínculo, conteúdo, opt-out, bloqueio de schedule legado, escrita nativa recusada e prazo do lock. Não é prova de produção nem de transporte.


## Atualização da contagem Shopify

Depois da instalação existente de `segment-shopify-count.sql`, a migração
adicional `n8n/growth/segment-shopify-count-performance.sql` substitui somente
duas funções de contagem. Deve ser aplicada em uma transação com conferência
prévia e posterior dos metadados. Exige os corpos PR187 exatos e os controles
de seleção, worker e campanhas regulares desligados. Não repetir o instalador
original; em resposta incerta, conferir os hashes das funções antes de qualquer
nova tentativa. Fontes, consentimento, públicos salvos e permissões permanecem
preservados; essa atualização não libera envio com públicos salvos.

A migração inline da PR192 foi retirada: na base real, as oito contagens
das duas marcas atingiram o limite de dez segundos. A função agregada foi
restaurada ao corpo PR191, com `shopify_facts AS MATERIALIZED`, sem repetir
instaladores ou alterar dados, fontes e permissões. Não aplicar o SQL inline
histórico. Uma futura otimização deve provar regras escalares e de produto,
ambas as marcas e a cardinalidade de múltiplas listas, com o mesmo limite
de dez segundos da API; benchmarks de uma marca não bastam.

## A/B com público salvo — gate independente, inicialmente OFF

`CRM_AUDIENCE_AB_ENABLED=false` é o padrão. A rota `/ab-experiments` só admite
novas preparações, revisões e agendas quando esse gate e os gates de vínculo e
agenda regular estão ligados. A capacidade da página também precisa anunciar
`audience_mode: saved-audience-v1`, marcas e endpoint verificados. Nenhuma dessas
capacidades é habilitada por este código ou por instalar o SQL.

O percurso usa o diário de operações da tela já existente: duas campanhas salvas
vinculadas ao mesmo público/revisão → alocação imutável → revisão de material e
consentimento de até60s → confirmação humana → agenda conjunta. O horário deve
ser idêntico e ter antecedência mínima de15min. Nesta versão A/B a alocação aceita
regras de listas; condições externas ficam indisponíveis nesse percurso. A agenda
regular mantém seu suporte separado a listas, engajamento e fontes Shopify verificadas.

Preparação, revisão, admissão e recibo da operação da tela compartilham uma
transação. Perda de resposta retorna estado não confirmado; a tela consulta o
mesmo recibo por GET e não repete POST automaticamente. Cancelar atua nas duas
campanhas e só antes de qualquer início/recibo de transporte. Consulta de operações,
leitura e cancelamento seguro continuam disponíveis com o gate A/B desligado.

O papel da API lê e bloqueia contatos/material por funções parametrizadas de
leitura; não recebe UPDATE em campanhas, assinantes, consentimento, templates ou
settings. A agenda conjunta e o cancelamento possuem funções próprias restritas.
Alterações de tracking são serializadas antes do lock do experimento. Identidade,
alocação e configuração congeladas não podem ser trocadas depois da confirmação.

A execução reutiliza o worker regular publicado. Cada braço seleciona somente seus
membros ainda elegíveis; resultado de transporte desconhecido suspende o par sem
reenvio automático. O SQL de A/B não concede aprovação ao worker nem instala uma
imagem. Requer a mesma prova operacional de identidade, remetente, topologia e
janela de serviços registrada para agenda regular.

Provas adicionais: `tests/ab-audience-panel-path.test.cjs` (tela→diário→HTTP→SQL),
`tests/ab-audience-runtime-postgres.cjs` (login real restrito, ambas as marcas,
negação de escrita nativa e concorrência de tracking) e
`tests/ab-audience-regular-postgres.cjs` (espera pelo horário real, query exata do
worker, consentimento, braços disjuntos, pausa conjunta e recibos). São provas
sintéticas, sem envio a clientes; não substituem readback nem aceite de produção.

## Publicação pausada de fluxos — gate independente OFF

A rota `/journey-graph-lifecycle` integra o construtor existente. O gate
`CRM_AUDIENCE_GRAPH_LIFECYCLE_ENABLED=false` bloqueia conferência/preparação/publicação;
consulta de recibos e status permanece autenticada. Uma publicação cria revisão
imutável na mesma jornada, mantém a jornada pausada e preserva o histórico.
Não admite participantes nem envia. Usa o mesmo pool limitado e o login
`crm_audience_api`, com helpers SQL próprios sem UPDATE nativo.

O cliente compartilha o diário de rascunhos e consulta respostas incertas por GET,
sem repetir a publicação. O código não anuncia a capacidade: são necessários
SQL/grants, atualização da API na janela de Felipe e aceite nas duas marcas.
Contrato, limites e provas em [publicação pausada](../../n8n/growth/journey-graph-lifecycle-publication.md).


### Temporary Aristo product quarantine

The existing Aristo export contains one Customer whose declared order count exceeds its exported Order nodes. Its product absence must stay unknown. The guarded operational migration `n8n/growth/segment-shopify-product-quarantine.sql` disables only Aristo product availability in the catalog, source readiness and Customer matcher. It preserves scalar Shopify fields, Fish products, frozen export payloads/provenance, saved definitions, semantic pins and delivery gates. A subsequent nightly ingestion cannot automatically reopen this field.

Keep the product semantic hash in the unavailable catalog field: the real count provider uses it to select the aggregate wrapper even for scalar Shopify rules. Removing that hash sends scalar counts back to the older per-subscriber path. The native quarantine test exercises the real Counter with the API role and a ten-second limit, checks strict/confirmed product unknowns, scalar aggregate dispatch, Fish isolation, private permissions, immutable evidence, replay refusal and subsequent ingestion.

Apply only at an idle collector boundary after CI and exact runtime readback guards; no service restart or customer send is required. This is temporary containment, not the definitive parser/pin migration. Re-enable Aristo products only after coordinated parser, ingestion, SQL/JavaScript product semantics and source evidence validation. Never rewrite historical chunks to hide the discrepancy.

### Compatibilidade da contagem antes de migrar produtos

A API deve receber primeiro a compatibilidade de despacho agregado, antes de
qualquer migração SQL para `shopify-customer-products-v2`. O helper aceita somente
os hashes v1 e v2 calculados para a marca, loja, moeda e fuso verificados. Esse
suporte serve para escolher o contador agregado dos campos escalares; a prontidão
de produto continua exigindo o hash da semântica ativa e o campo disponível.
Uma quarentena com hash da versão ativa mantém o contador agregado, cuja
função SQL continua impondo prontidão e retornando desconhecido.
Produto com hash divergente segue pelo caminho existente de lógica de três
valores, preservando E/OU e a distinção entre desconhecido e zero.

Publicar e conferir os arquivos físicos de todas as réplicas da API ainda com
SQL PR194. Esta etapa não migra fatos, hashes de fontes, parser, SQL, públicos
salvos ou gates. A migração definitiva de produto só pode ocorrer depois desse
readback. A prova `segment-shopify-count-dispatch-compat-postgres.cjs` usa a role
da API com limite de dez segundos, duas marcas, 253.479 assinantes, 1,45 milhão
de memberships e uma rotação controlada de hash em fixture; ela não substitui a
prova da migração SQL v2 completa.

### Modo explícito da semântica de histórico de produtos

`CRM_AUDIENCE_SHOPIFY_PRODUCT_SEMANTICS` aceita somente `v1` ou `v2`, assume
`v1` e é capturada quando o processo carrega o módulo de fatos. A configuração
e o módulo carregado precisam concordar antes de abrir o pool. O healthcheck
publica `product_semantics`, permitindo comprovar todas as réplicas ainda em
`v1` durante a primeira fase e, depois, a troca completa para `v2`. A API
compatível reconhece somente os pins exatos v1/v2 para escolher o agregador;
isso não torna produto disponível e não substitui a prontidão imposta pelo SQL.

A sequência v2 é única e fail-closed:

1. conferir a API compatível ainda em `v1` em todas as réplicas e confirmar
   journal pendente zero, mutex livre e gates de seleção/entrega desligados;
2. deixar a nova imagem do coletor em `v2`, ainda OFF, com revisão de produtor
   igual à revisão da imagem, e conferir seu healthcheck;
3. instalar o SQL v2, derivar as atestações dos snapshots congelados e atualizar
   o catálogo, sem mudar a revisão de produtor vigente nas fontes;
4. trocar todas as réplicas da API para `v2`, reler o modo e provar as contagens;
5. preparar no ledger a transição da revisão antiga para a revisão exata do novo
   coletor; só então habilitar o coletor v2 e conferir seu readback.

O ledger autoriza a próxima ingestão, mas não bloqueia o scheduler depois do
commit; por isso o coletor permanece OFF até as etapas 1–5 terminarem. Não inicie
outro Bulk nem repita os arquivos congelados atuais. Durante a transição,
produtos permanecem indisponíveis até a evidência v2 ou uma atestação derivada
válida. Os campos escalares continuam no contador agregado em ambas as versões.
Não misture modos num mesmo conjunto de réplicas e não trate o suporte de
despacho como prova de que a API original entendia o novo pin.
