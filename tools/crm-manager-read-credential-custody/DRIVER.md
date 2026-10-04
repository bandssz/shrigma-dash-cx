# Driver READ — processo local, OFF por padrão

`driver.cjs` reconstrói o plano branded, recebe um único bootstrap privado e compõe o StageRunner. Importar ou chamar sem opt-in é inerte: não importa os componentes compostos nem acessa ambiente, arquivos, streams ou providers. O driver é uma ferramenta do operador fora do pacote do dashboard; não instala SQL nem concede aprovação.

## Entradas públicas e privadas

A API `runDriver(config, deps)` exige os campos fechados de configuração, aprovação separada de stage/reconcile e caminhos explícitos para plano, RSA4096, custódia, fences e requests. O plano público é `crm-manager-read-driver-plan-file-v1`, com `stage:{suffix,sources,intent,domainId,isolatedProject?:true}`, `reconcile:null|{suffix,domainId}` e SHA do plano reconstruído. O SHA dos bytes do arquivo é distinto do SHA do plano. A opção literal true escolhe somente `crm-manager-stage-20261004`; sem ela, mantém o projeto legado. Reconcile conserva o projeto e os volumes originais, sem seletor novo.

CLI OFF: `node driver.cjs`. O opt-in usa apenas caminhos/digests públicos: `node driver.cjs --opt-in startup.json startupSHA provider.cjs providerSHA`. Startup, plano e provider devem ser arquivos próprios600, de um link, em diretórios canônicos0700, sem symlink, com bytes/digest conferidos. Aprovação/configuração são verificadas antes de carregar o provider pinado. Ele exporta somente `createProviders`; é código local de confiança, não um sandbox nem um conector já implementado. Credenciais nunca pertencem aos argumentos, ambiente, startup ou provider.

O processo confirma TTY com echo e modo canônico desativados e instala o parser antes de READY seq0. Aceita somente uma linha UTF8 JSON de até16384 bytes, em10s, com `{schema:'crm-manager-read-private-bootstrap-v1',seq:0,mode,planSha256,adminPassword,servicePassword,serviceVerifier}`. Execute exige senha de serviço64hex e SCRAM canônico, correspondentes na custódia; reconcile exige ambos null e recupera o verifier original pela callback privada, comparando com a cápsula. Senha administrativa fica somente no fluxo privado em RAM. Echo, campos extras, UTF8 inválido, segundo pacote, bytes antecipados, EOF, cancelamento ou timeout recusam o bootstrap.

## Providers e ligação da ponte

`bindScopes`, `admission` e `observeStatus` são obrigatórios. Reconcile exige ainda `getRetainedVerifier`. Nenhum provider real, ausência de alvo ou boolean de admissão é fabricado pelo driver.

Antes de ACK0/invocação, o driver deriva todas as consultas/mutações do plano exato, incluindo o DTO privado de env e os scopes do alvo original em reconcile. A expansão JSON privada deve caber4096 bytes antes de qualquer efeito. `bindScopes` recebe quatro metadados enumeráveis (`schema`, `planSha256`, `mode`, `scopesSha256`) e os arrays literais privados não enumeráveis. O provider deve instalar esses scopes no relay e devolver o recibo exato; não pode apenas aceitar o primeiro DTO que chegar. Bytes de entrada antecipados são recusados antes e depois de ACK0 e antes do primeiro frame da ponte. A cápsula é retida antes da primeira QUERY seq1. Os fences, duas barreiras públicas e não repetição continuam no StageRunner.

Os providers são fronteiras de confiança: podem executar código de aplicação e devem ser revisados, vinculados ao plano e comprovados no ambiente real. ACK0 confirma somente o bootstrap/binding; aceitação MCP não comprova efeito SQL. `completed` não significa verificado: a CLI só termina0 quando o resultado interno é `verified`. Resultado incerto preserva plano/cápsula/fences para reconcile autorizado, sem reenviar stage.

## Provas e limites

O lote integrado de14 arquivos passou121/121 em Node22 com ambiente limpo e guard de rede/processo. Inclui24 casos do driver, opção do projeto fixo, paridade dos descritores legados e herança do reconcile. A revisão independente não encontrou bloqueador de fonte.

O primeiro processo TTY real usou bootstrap fictício e uma QUERY simulada. Um ensaio posterior chegou a READY0→ACK0→uma `listDomains` MCP nativa seq1 pelo relay real, com scopes previamente vinculados e cápsula retida, e recusou a admissão (`not_dispatched`, exit1 esperado). A prova posterior SHA `26a0d07690b01ae7f6267fa53f559d01ff59173272057a08304dd12ef12e25ee` registra uma consulta, mutações0, PostgreSQLfalse e credenciais reais0. Não comprova mutação MCP privada, canal com credenciais reais, GET remoto ou stage PostgreSQL.

O [provider público](PROVIDER.md) agora compõe binding, evidência pinada com validade de dez segundos e observação HTTPS; falta sua execução real autorizada. Um projeto vazio foi criado separadamente via MCP dentro do escopo original de preparação paralela; `inspectProject` confirmou `services:[]`. Essa observação não substitui coleta fresca antes do stage. `inspectComposeService`404 não comprova ausência de serviço: um App existente devolveu o mesmo erro. LOGIN/issuer, ativação, usuários, edição e corte continuam etapas críticas separadas; nenhuma credencial real foi aberta para estas provas. Os limites de armazenamento privado/auditoria/limpeza do MCP descritos em MCP-STAGE permanecem.
