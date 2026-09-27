# Papel executor do primeiro carrinho — candidato OFF

`buildWorkerRoleSql({sendLogSequence,recipientKeySha256})` produz somente o fragmento SQL da instalação composta. Não conecta, não busca credenciais, não inicia transação própria, não habilita login nem executa comandos de operação. A instalação deve executar o fragmento inteiro na mesma transação das migrações verificadas. Colisão de papel/guards, divergência da sequência/helper ou privilégios efetivos fora da matriz abortam tudo. Não executar o fragmento avulso em produção.

O papel fixo `crm_graph_worker` nasce **NOLOGIN**, sem membership, superuser, administração, replicação ou BYPASSRLS. A criação posterior do serviço e a configuração de autenticação não fazem parte desta entrega. O executor conserva `current_user=crm_graph_worker`; não pode ser um usuário administrador com o nome configurado no serviço.

## Locks sem alteração de controle

As funções existentes continuam SECURITY INVOKER. PostgreSQL exige UPDATE em uma coluna para `FOR SHARE/UPDATE`; o papel recebe somente `singleton`, `brand` ou `id` nas tabelas de controle/jornada e `subscriber_id` nas associações. Triggers específicos recusam qualquer alteração efetiva dessas linhas quando o usuário corrente é o worker. Updates sem alteração são permitidos; os locks não disparam triggers. `intent.id` já é protegido pelo trigger imutável existente. Os guards não alteram o comportamento dos papéis legados/operadores.

O finish original exige UPDATE de `subscribers.attribs/updated_at`. O guard permite somente acrescentar `flows.cart_t05_at` de Fish/Aristo quando esse marcador ainda não existe, preservando todos os outros atributos: consentimento, identidade, material e outras marcas não podem ser modificados. Esse acréscimo exige um dispatch próprio do grafo em voo, vinculado ao mesmo assinante/carrinho. O papel não possui INSERT/DELETE de assinantes nem UPDATE de status/email/UUID; não pode alterar inscrição em listas. O journal de operações aceita somente ator fixo `worker:graph-cart-v1` e ações `step`/`apply_dispatch` sob esse papel.

O dispatch só pode nascer para Fish/Aristo, carrinho de 30 minutos, com permit efêmero e ownership; uma constraint adiada exige o vínculo cart_delivery ao commit. O worker só finaliza dispatch pertencente ao grafo, de in_flight para accepted/rejected/outcome_unknown. Estados terminais não podem ser reabertos, e dispatch legado/TX não pode ser alterado. O log exige o mesmo carrinho/clone e um dispatch próprio em voo; outra constraint adiada exige accepted e send_log_id apontando ao log no commit, preservando a ordem do finish original. As constraints são triggers SECURITY INVOKER, sem ampliar privilégios.

A matriz concede leitura, captura da fonte, transições/intenções, claim/finish originais e aplicação de recibos. Não concede admissão, publicação, pausa, alteração dos controles, preparação/criação de clones, épocas ou tabelas da fila de retenção. O único DELETE é do permit efêmero, usado dentro da mesma transação do claim.

## Dependências públicas e privilégios herdados

A única sequência liberada é a comprovada pelo default de `shrigma_send_log.id`, validada novamente no fragmento. Não há GRANT ALL ou concessão a todas as sequências.

`shrigma_email_recipient_key(text)` precisa estar SECURITY DEFINER e com fingerprint exato informado pela preparação revisada. O papel recebe EXECUTE nessa fronteira existente e **nenhum acesso** à tabela de chave HMAC. O fragmento não altera o helper. A instalação composta deve também fixar seu owner/configuração/ACL pela prova revisada.

A conferência final mede privilégios efetivos, incluindo PUBLIC/default ACLs, por coluna e tabela em todas as relações de usuário. Privilégios em objetos fora da matriz, SELECT/UPDATE de sequência indevida, funções de manutenção, funções de grafo fora da allowlist, ou outro SECURITY DEFINER executável tornam a instalação inválida. Não revoga permissões compartilhadas para contornar essa falha. Qualquer conflito exige revisão específica antes de instalar.

Não é isolamento por linha/marca nem proteção contra administrador malicioso: o código do serviço é confiável, e o papel consegue ler as relações necessárias e gravar as colunas operacionais concedidas. As guardas de consentimento/identidade/controles não dependem de o código da aplicação se comportar corretamente.

## Provas

- `tests/journey-graph-worker-role.test.cjs`: PGlite com SET ROLE, fonte nova capturada pelo worker, admissão apenas pelo operador da fixture, duas transições e transporte HTTP sintético; Fish/Aristo, recibo único, opt-out, resultado incerto sem reenvio, proibições de escrita, grafo OFF com claim/finish legado preservados, alteração de dispatch legado/TX/reabertura negadas, rollback de dispatch/log órfãos, recusa de drift/colisão e rollback de grants PUBLIC indevidos.
- `tests/journey-graph-worker-role-postgres.cjs`: exige PostgreSQL17.10 em `journey_graph_worker_role_test`, localhost:5432, usuário `synthetic`, sem senha e `GRAPH_TEST_DATABASE_ISOLATED=1`. Usa pools distintos de administração e worker, duas sessões reais concorrentes para o mesmo envio e as mesmas recusas. Papel inicialmente ausente; remove apenas a fixture descartável/role criado pelo próprio teste. Nenhum envio, rede externa ou base real de CRM é permitido.

PGlite não substitui a prova de concorrência PostgreSQL. Aprovação desse runner deve ser lida na CI antes de declarar a matriz comprovada em PostgreSQL real. Testes não significam instalação do papel ou ativação do serviço.
