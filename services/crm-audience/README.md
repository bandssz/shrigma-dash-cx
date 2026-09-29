# Serviço de públicos do CRM

Host HTTP candidato para as APIs existentes de rascunhos de público (`/segments`) e vínculo público–campanha (`/campaign-audience`). Ele não instala SQL, altera contatos, ativa seleção, agenda ou envia campanhas. Após autenticação, renova exclusivamente o catálogo nativo de listas e registros de abertura/clique pela função SQL revisada. Nasce com `CRM_AUDIENCE_ENABLED=false`; nesse estado apenas `GET /healthz` responde normalmente.

## Fronteira

O navegador envia o bearer humano em `Authorization`; o serviço não possui token próprio e não traduz essa identidade. Cada API valida o bearer novamente no PostgreSQL. CORS permite somente `https://bandssz.github.io`; chamadas sem `Origin` continuam possíveis para probes internos, mas não ganham cabeçalho CORS.

O host aceita `GET` e `POST` somente em `/segments` e `/campaign-audience`, mais o preflight `OPTIONS`. POST exige JSON UTF-8 estrito e corpo de até 32 KiB. Query duplicada, dois headers de autorização, codificação de conteúdo, JSON inválido e `Content-Type` diferente de `application/json` são recusados antes da API. Há no máximo quatro requisições simultâneas e nenhuma fila ou retry interno.

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
