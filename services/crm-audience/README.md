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
