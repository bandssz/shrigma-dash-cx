# Executor Node interno — candidato OFF

Encaixe: serviço separado `comunicacao/crm-flows`, uma réplica e sem domínio público, recebendo chamadas autenticadas da automação. Não hospedar este código no Code node do n8n. A inspeção de 27/09 encontrou n8n 2.0.2 sem allowlist de módulos externos e Listmonk 6.1.0 com uma réplica; isso não disponibiliza um `pg.Pool` nem comprova o cache compilado de um clone. O serviço novo, papel/grants SQL, configuração, imagem/ref imutável e ligação autenticada ainda dependem de instalação e provas próprias. Nada neste módulo cria serviço, reinicia aplicação ou anuncia capacidade do painel.

## Composição do servidor

`createWorkerPool({connectionString,Pool,onError?})` recebe o construtor `pg.Pool` instalado pelo serviço: máximo quatro conexões, timeout de conexão 3 s, SQL 8 s, leitura de query 10 s. Nenhuma conexão/credencial vem de uma operação. Erros do pool reportam apenas um código.

`createWorkerHttp({listmonkOrigin,listmonkAuthorization,cacheTarget,shops,shopifyTokenFor,fetchImpl?})` fixa HTTPS e a mesma origem Listmonk para `/api/templates`, `/api/templates/:id` e `/api/tx`. `shops` contém `{fish:{id,myshopifyDomain},aristo:{id,myshopifyDomain}}`. O supplier `shopifyTokenFor(brand,{shop,signal})` renova credenciais no servidor. Token, autorização Basic e dados privados ficam em memória e não entram em recibos/logs. O adaptador permite apenas as três queries Shopify já validadas, versão 2026-07, host da marca, resposta de até 256 KiB, timeout e sinal compartilhado. Não há retry ou redirect. Templates têm resposta máxima 350.000 bytes; transporte, 65.536 bytes. O limite vale durante a leitura, antes de interpretar JSON.

`createWorker({pool,enabled=false,actor,authorizeWorker,cacheTarget,shops,shopifyRequest,collectorWorkflowIds,sendTx})` compõe fonte Shopify, revisão/material/clone imutáveis, preflight, claim CART original, transporte, finish original e aplicação do recibo. `actor` é fixo `worker:graph-cart-v1`; `authorizeWorker({query,actor,brand,action})` deve retornar `true` somente para a identidade/role interna verificada. O callback é repetido antes dos comandos; não representa uma ACL inventada do operador. O `readSource` opcional destina-se à composição confiável e a testes; nenhuma rota/job pode fornecê-lo. O processo não lê env sozinho.

## Operações internas

- `inspect()`: contagens e gates por marca, sem pessoas ou material. Informa sempre `admissions:false`, `publish:false` e `panel_activation:false`; disponibilidade de tabelas não comprova instalação operacional completa.
- `captureHandoff(handoff)`: captura apenas o recibo allowlisted do coletor após reconciliação, com sua identidade estável. Pode preparar a fonte com execução OFF. Nunca cria entrada, propriedade ou intenção.
- `tick({brand,limit=5})`: limite de 1 a 5 ações, uma chamada por marca de cada vez, sem fila implícita. Recomenda-se `limit:1` no primeiro agendamento. Primeiro concilia reservas existentes; depois avança entradas vencidas já pertencentes à coorte e, havendo orçamento, processa intenções sem reserva. Não admite novos participantes, cria release/clone, publica jornada, abre época ou altera flags. Config OFF recusa execução. Gates SQL e manutenção são conferidos novamente pelo caminho de reserva.
- `reconcile({brand,intent_id})`: somente consulta e aplica o resultado persistido. Funciona durante pausa/OFF; jamais recupera token/payload ou repete HTTP.

A chamada de tick termina a ação iniciada e não inicia outra depois de 50 s; não é uma garantia de duração total de 50 s. Cada transporte tem o teto existente de 40 s, fonte 4,5 s e locks/SQL limitados. O servidor deve reservar margem para a ação corrente e não interpretar timeout do chamador como autorização de repetição de envio. Nenhum timer ou polling começa ao importar/construir a factory.

IDs de comandos usam hash determinístico da identidade fixa, marca, ação e versão/dispatch. A operação de recibo é localizada pelo mesmo ID após reinício/perda de resposta, conferindo ator, marca, intenção, estado e dispatch. A versão atual é lida para a primeira aplicação. Um commit de claim perdido não fornece grant: o tick seguinte consulta a reserva original; `in_flight` e `outcome_unknown` não são enviados novamente. Contenção que ainda resta entre leitura e claim é fechada pelos locks e pela chave original CART.

## Recorte e provas

Somente Fish/Aristo, `cart.abandoned`, e-mail de 30 minutos. A entrada já precisa ter ownership válido e clone pronto. O próximo passo de admissão/época continua separado; o serviço não o finge pronto. Antes de ativar qualquer coorte: instalar/revisar migrações e role, comprovar cache nativo na instância fixada, integrar handoff real e jornada publicada, validar relógios/identidade/consentimento e fazer aceite controlado. O campo de compra continua observacional e versionado, sem prometer ausência universal.

Os testes novos usam PGlite com SQL legado completo, as duas marcas e transporte sintético: worker → claim → finish → recibo, restart com reserva, HTTP incerto, perda de ACK do commit, autorização, OFF/manutenção, captura sem admissão e single-flight. Os adaptadores HTTP são testados com `fetch` injetado: destinos/credenciais por marca, cancelamento, limites de stream e zero retry. Nenhuma consulta externa, contato real, serviço remoto, envio ou implantação foi executado nesta entrega. Os ensaios não medem capacidade do host.

A prova adicional `journey-graph-worker-postgres.cjs` exige PostgreSQL17.10 descartável em `journey_graph_worker_test` (localhost:5432, usuário synthetic, `GRAPH_TEST_DATABASE_ISOLATED=1`). Duas factories concorrem pela mesma intenção em cada marca; as barreiras apenas alinham as leituras, enquanto claim/finish/recibos usam sessões SQL independentes. Espera exatamente um HTTP sintético, dispatch e recibo, sem reenvio após restart. Resultado depende da execução da CI; não foi executada em banco real local.
