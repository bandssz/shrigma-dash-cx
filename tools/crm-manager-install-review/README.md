# Prova nativa proposta — PostgreSQL 17

Pacote de revisão para a CI da candidata; nenhum container, socket ou SQL nativo foi iniciado no Mac. O job exclusivo reutiliza Node 22 e `pg@8.13.1` fixado pelo lockfile da candidata, mas cria **outro cluster efêmero** com PostgreSQL 17.10, CPU 1, memória 512 MiB, dados em tmpfs de 256 MiB e porta exclusiva `127.0.0.1:5438`. O Mac está sem servidor PostgreSQL e sem daemon Docker ativo; não é necessário iniciar o aplicativo Docker para esta preparação.

O HBA contém quatro regras nativas, montadas antes da inicialização: local TRUST, IPv4 loopback TRUST, IPv6 loopback TRUST e demais IPv4 SCRAM. `pg_hba_file_rules` não é substituído nem simulado. O único password no pacote é a constante sintética do cluster descartável. A conexão administrativa é fixada em host/porta/banco/usuário, recusa PG diferente de 17, marcador de cluster diferente ou qualquer relação/função pública/papel da fixture/default ACL pré-existente. O processo não aceita URL de banco, senha, host remoto ou credencial de produção.

Antes da instalação, a fixture estabelece metadados reais: quatro regras HBA e as 18 classes do relatório de ACL, com somente `central_leitor SELECT` em `public`. O legado sintético usa quatro fontes públicas de autenticação/leitura verificadas por SHA. A instalação V3 `33a412f3…` e a reversão `dace1eab…` são copiadas e enviadas byte a byte, sem substituir gates, funções ou privilégios. O novo proprietário e emissor devem permanecer NOLOGIN; o teste faz tentativa real de conexão pelo loopback TRUST **dentro do container** para distinguir NOLOGIN de falta de password SCRAM.

O teste contém oito subcasos sequenciais: contexto divergente; instalação/reversão positiva com dados, definições, ACLs, defaults e quatro triggers antigos restaurados; e seis recusas de reversão (issuer, operação, LOGIN habilitado, view externa, grant adicional em `caps`, corpo de função alterado). As violações são criadas e desfeitas somente na fixture. Os erros exigem a mensagem fixa de recusa e `ROLLBACK` na mesma conexão; o estado instalado deve ser preservado.

O fingerprint nativo deve ser exatamente `4f5b8bdec729d2924c043da6bd3c0f8f2ce01a82af614187cefa1322ecef11c9`. Se divergir, o teste falha fechado, informa somente fase e dois hashes de metadados e **não aprende nem adota** o hash novo. Os demais erros são genéricos; o runner não imprime SQL, logs do container ou erros crus do PostgreSQL.

Comando exato no runner Linux descartável, depois de instalar a dependência fixada da candidata e copiar esta pasta para o caminho indicado na proposta:

```sh
CRM_MANAGER_V3_NATIVE_PROOF=1 NODE_PATH="$GITHUB_WORKSPACE/services/crm-manager-provisioner/node_modules" bash tools/crm-manager-install-review/run-native-v3-proof.sh
```

Executar esse comando requer um runner Linux descartável com daemon Docker local. Sem o opt-in, `node --test native-v3-proof.test.cjs` apenas registra SKIP e não carrega `pg` nem abre socket. O runner sempre aponta Docker para `unix:///var/run/docker.sock`, não para `DOCKER_HOST` ou contexto remoto, e remove somente o container novo que criou.

Limitações: esta preparação ainda não comprova resultado nativo positivo, origem/login/TLS do servidor real, isolamento de rede de produção, concorrência de publicação ou serviço desligado na operação atual. A imagem está fixada em versão, sem digest previamente verificado nesta preparação; pode ser fixada por digest após obtenção/revisão na CI. Um resultado verde comprova esta fixture PostgreSQL 17; não autoriza DDL, LOGIN, issuer, runtime ou alteração de tráfego em produção. `ci-job-proposal.yml` conserva a proposta original como referência; o job integrado está somente no workflow exclusivo da candidata. Não altera publishers, pipelines de produção ou serviços existentes.
