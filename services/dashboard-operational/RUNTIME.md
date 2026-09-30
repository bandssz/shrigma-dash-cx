# Pacote e inicialização do dashboard operacional

Usa a imagem prebuilt oficial `node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402`, sem build ou instalação de dependências no servidor. O runtime usa stdlib, inclusive `node:sqlite`. O pacote fechado contém exatamente 22 arquivos públicos e quatro módulos (`server`, `auth`, `proxy`, `fixtures`). Não inclui Git, SQL, n8n, documentação, `.env`, banco, credenciais ou fontes privadas.

## Preparação local

```sh
node services/dashboard-operational/build.cjs /private/tmp/dashboard-operational-build
node services/dashboard-operational/pack-runtime.cjs /private/tmp/dashboard-operational-build /private/tmp/dashboard-operational-pack
node --test services/dashboard-operational/runtime.test.cjs
```

As duas pastas de saída devem estar vazias. Regenerar depois de qualquer mudança em frontend ou módulos runtime. `deployment-metadata.json` registra SHA, tamanhos e imagem. `runtime-pack.json` é JSON gzip/base64 com texto UTF8 e binários base64; a integridade cobre o JSON descomprimido, incluindo código. `seed-mounts.json` tem o pacote mais os dois módulos de boot e deve ter menos de 950 KB. `mounts.json` mantém apenas os dois módulos pequenos, preservando a capacidade de inspeção pelo MCP depois da instalação inicial.

## Contrato de runtime

- UID **1000**, GID **1000**, obrigatório antes de ler artefato ou abrir SQLite.
- Volume **novo e exclusivo** em `/dashboard-data`, proprietário 1000, modo 0700; banco fixo `/dashboard-data/dashboard.sqlite`, WAL/SHM 0600. Nenhum volume ou banco de produção deve ser conectado.
- `DASHBOARD_PACK_SHA256`: obrigatório, valor de `deployment-metadata.json`. Pin incorreto, checksum inválido, arquivo extra, encoding errado, tamanho excessivo, symlink ou target existente impedem inicialização antes de importar o runtime.
- `DASHBOARD_MODE=synthetic` inicialmente; `operational` somente quando as integrações reais estiverem explicitamente autorizadas e configuradas. O empacotamento não habilita ações comerciais nem upstreams.
- `DASHBOARD_EXPECT_UID=1000`, `DASHBOARD_EXPECT_GID=1000`, `HOST=0.0.0.0`, `PORT=8080`. `DASHBOARD_DB_PATH`, se informado, deve ser exatamente o caminho fixo acima. `DASHBOARD_PUBLIC_DIR` é definido pelo boot após a extração privada em `/tmp`.
- Variáveis da identidade/gateway continuam sendo as documentadas em `server.cjs`: hosts, domínios de e-mail, administrador inicial, hash de bootstrap, chave de criptografia e configuração explícita de upstreams. Seus valores devem ser injetados privadamente em runtime, nunca no pacote ou respostas.
- Limites sugeridos: **512 MiB**, **0,5 CPU**, uma réplica, heap Node 128 MiB. O scrypt de senha consome aproximadamente 128 MiB nativos; ele não está incluído no limite do heap. Uma réplica preserva consistência SQLite; não usar zero-downtime/réplicas sobre o mesmo banco.

## Instalação inicial no serviço novo

Criar só o volume exclusivo e os mounts descritos pelo pacote. Preparar o volume uma única vez como root, antes de trocar para node: copiar `/app/runtime-pack.json` para `/dashboard-data/runtime-pack.json` enquanto o volume ainda pertence ao root; aplicar chmod 0600 no pacote e 0700 no diretório; somente depois mudar os proprietários de ambos para UID/GID 1000:1000 e executar su. Esta ordem evita precisar de DAC_OVERRIDE/FOWNER. A etapa precisa de CHOWN além de SETUID/SETGID; não conceder essas capacidades para o processo Node final. Não usar cópia ou chown recursivo sobre volumes existentes ou compartilhados.

O comando final é:

```sh
su -s /bin/sh node -c 'chmod 0700 /dashboard-data && exec node --max-old-space-size=128 /app/bootstrap.cjs'
```

No ensaio remoto, o Easypanel reaplicou modo de diretório diferente de0700 ao volume durante o redeploy. O usuário `node` continua dono UID1000; por isso o próprio processo corrige **somente** o modo do volume antes de o boot validar ownership, pack e banco. Caso o dono mude, o `chmod` falha e o serviço permanece fechado. Essa correção foi validada em um redeploy com a conta SQLite existente.

Na atualização isolada de 30/09/2026, o pacote v3 foi validado pelo checksum e copiado para o volume com a cópia v2 preservada. O serviço de teste exporta o novo `DASHBOARD_PACK_SHA256` no comando de partida antes de executar o boot, porque a API do Easypanel substitui o bloco completo de variáveis e não foi usada para reescrever os segredos existentes. Em instalação definitiva, manter um único SHA efetivo, registrar a revisão correspondente e retirar mounts de seed somente após identificar seus índices de forma verificável.

Aplicar `capDrop=ALL`; apenas SETUID/SETGID podem ser necessários para a troca inicial feita por `su` quando a imagem inicia como root. Preferir configuração de usuário 1000 diretamente se o painel suportar. Depois de inicializar e validar saúde/login, remover o mount grande do seed, CHOWN e a etapa de cópia. Manter o volume e somente `mounts.json`. Não sobrescrever pacote no volume a cada boot, pois isso poderia restaurar uma revisão obsoleta silenciosamente.

Um volume presente é autoritativo: pacote ausente/inválido dentro dele **não** cai no seed. O fallback `/app/runtime-pack.json` existe apenas quando o volume está ausente; o start de produção ainda recusa volume ausente para a identidade persistente. O boot não cria diretório arbitrário nem banco fora do volume fixo.

## Validação e reversão

Os testes locais verificam SHA, lista fechada, paths, encoding, gzip excessivo, symlinks, proteção contra sobrescrita, UID/GID, permissões do SQLite, prioridade do volume, recusa sem segredos e o runtime real extraído em modo sintético. A extração não comprova integrações reais nem versão Node22 do servidor: confirmar `/healthz`, UID1000, navegação, login, sessões, escopo, negativas e restart/persistência no serviço novo antes de considerá-lo funcionando.

Backup da identidade inclui SQLite e o material criptográfico correspondente, com acesso privado. Fazer backup consistente offline ou pela API de backup SQLite; copiar só o arquivo principal enquanto WAL está ativo não assegura consistência. Não exportar banco pelo HTTP ou pelos assets. A troca do pacote exige SHA correspondente, revisão guardada e compatibilidade do schema de identidade; rollback de frontend não desfaz ações comerciais. Este empacotador não publica serviço, muda DNS ou conecta backend.
