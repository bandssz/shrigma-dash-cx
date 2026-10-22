# Plano Compose isolado — sem aplicação

Plano público para projeto **dashboard-image-20260930**, com serviço externo exclusivo `crm-manager-install-v3-<sufixo novo>` e um volume nomeado exclusivo. Usa somente a imagem imutável `ghcr.io/bandssz/shrigma-dash-operational-canary@sha256:5ca20e4ea134b7a1a139b80c74a65573a4386d9584fcac40aeedaeb9cf8fe815`, Node22 e pg8.13.1. O builder verifica os oito arquivos públicos pelos pins: executored5b2c03, supervisor 5610bad1, health03498749, SQL33a/dace/a20/objects00eb/emptya55. Não inclui teste, credencial, cofre, dado de negócio, fonte de outro serviço ou volume atual.

`compose.plan.json` é JSON válido e, portanto, YAML válido para Docker Compose. O `.env` deste plano está **vazio**. O coordenador usará `createDotEnv:true`; somente o runner tem `env_file: [.env]`. `PGPASSWORD` será colocado em memória pelo canal privado exclusivamente depois de aprovação explícita. O bootstrap recusa falta da variável antes de iniciar supervisor/SQL. Nada foi implantado, iniciado, conectado ou modificado no Easypanel; repositório, operação e dados vigentes estão preservados.

São dois componentes, com teto combinado de320MiB; ambos fixam uma réplica, restart:no e deploy.restart_policy.condition:none, com limites também de PIDs em deploy.resources.limits. `prepare_volume`: root 0:0, sem rede, sem env_file ou ambiente de aplicação, raiz somente leitura, todas as capabilities removidas exceto CHOWN, no-new-privileges, CPU0.1, memória64m **e swap64m**, heap16, 16PIDs, uma réplica, restart desligado. Só admite o volume novo vazio, root-owned modo0755; chmod0700 ocorre **antes** de chown1000:1000. Confere novamente vazio/proprietário/permissões e nunca cria arquivo. Um volume já usado, com arquivos ou permissões divergentes é recusado.

`installer`: UID/GID1000, raiz somente leitura, capdropALL, no-new-privileges, CPU0.25, memória256m **e swap256m**, 32PIDs, uma réplica, restart desligado, heap96, init habilitado. Espera `service_completed_successfully` do inicializador; este plano exige Docker Compose nativo com essa condição, não um caminho Swarm; o único volume persistente é o novo volume de prova. Fontes são reconstruídas em tmpfs `/review` de64MiB, UID/GID1000 modo0700, nosuid/nodev/noexec, depois arquivos0444 e diretórios0555. O bootstrap verifica todos os SHA antes da cópia e chama diretamente `startCli(['install'], env)`; não há pai adicional que retenha credencial ou abra banco.

O manifesto base64 é dividido em argumentos de até24KiB, para respeitar o limite Linux de128KiB por argumento; nenhum código Compose contém interpolação `${}`. O loader verifica SHA do bootstrap e manifesto antes de decodificar. O guard lê somente metadados locais: Linux/Node22, UID/GID, raiz RO, capabilities/NNP, limites **cgroupv2**, tmpfs64MiB, volume vazio e ausência de mounts SSH/AWS/socketDocker. Não altera flags, ACLs, configuração de host, cgroup ou rede para fazer o ambiente passar. cgroupv1 ou perfil desconhecido recusam antes de SQL.

O runner participa somente da rede externa `easypanel`, necessária para o host fixo `comunicacao_postgres`. Não há ports, domínio, DNS, rota, webhooks ou worker. Supervisor mantém status somente em `127.0.0.1:8099`; Health local exige ação install e prova tipada, code0/signalnull do filho, barreira de fsync independente, pins, fingerprint4f, quatro tabelas vazias e duas roles NOLOGIN. O MCP oferece apenas status/failing-streak de Health, **não** JSON/log do probe nem código do pai; Health saudável representa esta barreira previamente revisada, sem alegar inspeção do JSON via MCP.

Comando de geração, sem Docker ou acesso ao servidor:

```sh
node compose/build-compose.cjs <12 caracteres hex de sufixo novo>
```

O coordenador deve confirmar ausência dos nomes de serviço/volume, capacidade do servidor e recursos efetivos antes da criação; essa consulta não foi realizada por este pacote. Após uma tentativa, usará somente os procedimentos MCP exatos já revisados para parar **o serviço novo** e esvaziar **o ambiente desse serviço**, preservando a prova e os demais serviços. Sem Health conclusivo, a próxima ação admissível é verificação READ ONLY independente em outro volume novo; nunca retry DDL ou DROP automático.

Testes: VM com filesystem/cgroups/capabilities sintéticos, parser JSON e RubyYAML.safe_load, staging por pins/readonly, recusa de volume pré-existente/segredo no inicializador, perfil privilegiado, limits sem teto, mounts inesperados e payload adulterado. Nenhum teste abre socket, banco ou daemon Docker. Ruby é somente dependência da prova de parser, não da imagem nem do runtime. O inicializador Node com64MiB e o perfil real de mounts/cgroup ainda devem receber smoke test isolado na CI; se OOM ou guard incompatível ocorrer, isso bloqueia aplicação, sem reduzir o guard ou ampliar o limite silenciosamente.

Esta preparação não autoriza a exceção de DDL no banco atual. O instalador continua NOLOGIN, sem issuer e sem consumidor; rollback vazio permanece condicionado aos requisitos documentados do executor. Nenhum objeto/ACL global ou dado legado foi alterado por esta preparação.

A conexão própria agora tem orçamento `transaction_timeout=500ms` confirmado no servidor antes do DDL; os cinco SQLs e o fingerprint continuam iguais. Expiração não autoriza retry ou aumento do limite.
