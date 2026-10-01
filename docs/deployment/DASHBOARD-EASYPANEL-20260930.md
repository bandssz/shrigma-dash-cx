# Instalação paralela do dashboard · 30/09/2026

Esta preparação autoriza apenas um ambiente de teste. Entrada em produção, mudança de tráfego, de origens autorizadas ou desativação do GitHub Pages exigem aprovação explícita posterior.

## Base e preservação do trabalho

- Repositório: `bandssz/shrigma-dash-cx`.
- Base imutável: `44415610439f098037186333aee579ded424578f`, confirmada no remoto `main` e no último build bem-sucedido do GitHub Pages.
- Branch exclusiva: `codex/dashboard-easypanel-20260930`.
- Worktree exclusivo: `.private/worktrees/dashboard-easypanel-20260930`, ao lado do checkout principal.
- Checkout principal observado: branch `codex/growth-reliability-20260924`, commit `552541830cf0c910725625c9f7fb76a2547d006f`, sem alterações locais. Não foi trocada a branch, feito stash, reset, merge ou push de produção. Não houve mudanças locais indispensáveis a incorporar.
- Instruções lidas: `README.md`, `docs/PANEL-ASSETS.md`, `docs/PANEL-LOGIN.md`, `docs/PANEL-SECURITY.md`, manifesto de assets, workflows e documentação dos serviços. Nenhum `AGENTS.md` foi encontrado nos ancestrais do checkout ou no projeto.

## Hospedagem atual e arquitetura

O frontend público está em <https://bandssz.github.io/shrigma-dash-cx/>. A API de configuração do Pages confirmou publicação legacy de `main` na raiz, HTTPS obrigatório, sem domínio próprio. O build observado foi publicado em 30/09/2026 às 05:52 de São Paulo. A branch de preparação não é fonte do Pages. Não há pipeline de deploy Pages declarado no repositório; os publicadores de imagens existentes têm disparo manual em `main`.

O dashboard é HTML/CSS/JavaScript estático. Seu build usa `esbuild@0.28.2`, fixado pelo pacote `tools/campaign-runtime-build`, e `tools/panel-build/manifest.json`. Bundles e hashes CSP são conferidos com `node tools/panel-build/build.cjs --check`. O frontend não precisa duplicar banco, coletores, n8n ou workers.

Entradas independentes: `/cx/`, `/crm/`, `/organico/`, `/creators/`. A entrada mestre é `/gestao/`, com navegação entre CX, CRM, Orgânico e Influs/Afiliados. Os HTML de conteúdo ficam na raiz. O build preserva os fontes e prepara uma cópia por allowlist para o teste; não edita manualmente os bundles originais.

Autenticação atual: credencial Bearer individual, identidade/área/concessões verificadas pelo backend, sessão somente em memória da aba, duração local de 8 horas, comunicação entre portal e iframe da mesma origem. Sair destrói o iframe e a chave. CRM e Creators possuem concessões reais de operação; carregar o frontend com credencial de produção pode permitir escrita. A instalação de teste usa somente credenciais próprias e grants de leitura.

## Serviços e integrações preservados

MCP autenticado confirmado para <https://comando.shrigma.com.br>. Consultas de configuração podem conter segredos e devem ser filtradas antes de exibição ou gravação. Não copiar variáveis, valores, tokens, arquivos privados ou strings de conexão dos serviços existentes.

Incidente de leitura: a resposta inicial do inventário foi exibida pelo executor sem a projeção necessária e incluiu credenciais de serviços existentes no registro da conversa. As consultas posteriores foram filtradas antes de exibição. Os valores não foram incorporados a arquivos, Git, imagens ou à instalação de teste. Nenhuma credencial existente foi alterada. Eventual rotação deve ser tratada em procedimento seguro, com aprovação e avaliação de impacto, fora desta preparação.

| Serviço existente em `comunicacao` | Relação com o dashboard | Revisão observada em 30/09 | Recursos CPU / RAM |
|---|---|---|---|
| `crm-panel-read` | Identidade CRM e cache autenticado em GET `/read`; PostgreSQL com role de leitura | `9bc7ee8fffdcc51a3cdab99a52242f65ad9643e2` | 0,5 / 512 MB |
| `crm-audience` | Públicos, segmentos, vínculos e ciclo de vida de grafos; algumas leituras podem renovar catálogo | `79861de6f9c3628885e7840858011180b5af9899` | 0,5 / 512 MB |
| `crm-campaign` | Criação/validação/agendamento de campanhas via Listmonk | `3a1b3b9962890cb0099b5228bb45f100c9d866b8` | 0,5 / 512 MB |
| `crm-shopify-sync` | Ingestão Shopify para as fontes do CRM; recuperação automática de trabalho pendente ao iniciar | `79861de6f9c3628885e7840858011180b5af9899` | 1 / 2048 MB |

Os quatro estavam em execução e saudáveis antes da preparação. Cada um mantém sua origem, revisão, flags, mounts, credenciais e limites. O caminho legado de campanhas no domínio n8n já aponta para `crm-campaign`; essa rota foi somente consultada.

Variáveis existentes, apenas nomes: `CRM_READ_ENABLED`, `CRM_READ_REVISION`, `CRM_AUDIENCE_*`, `CRM_CAMPAIGN_*`, `CRM_SHOPIFY_*`, `PG*`, `CRM_PG_*`, `LISTMONK_ORIGIN`, `LISTMONK_USERNAME`, `LISTMONK_TOKEN`. O sync possui arquivo privado de segredos montado; não será copiado. Na leitura inicial de 30/09, `CRM_AUDIENCE_BINDING_ENABLED`, `CRM_AUDIENCE_REGULAR_ENABLED`, `CRM_AUDIENCE_AB_ENABLED` e `CRM_AUDIENCE_GRAPH_LIFECYCLE_ENABLED` estavam desativadas. Essa observação histórica não descreve o estado atual.

**Atualização de 01/10/2026, somente leitura:** `crm-panel-read` continuou habilitado na revisão `9bc7ee8fffdcc51a3cdab99a52242f65ad9643e2bc2`. `crm-audience` e `crm-campaign` passaram a informar a revisão de fonte `03a02b4c98f471e6739c8a7cbe46e49aa4cbf285`; as flags `CRM_AUDIENCE_BINDING_ENABLED`, `CRM_AUDIENCE_REGULAR_ENABLED`, `CRM_AUDIENCE_AB_ENABLED`, `CRM_AUDIENCE_GRAPH_LIFECYCLE_ENABLED` e `CRM_CAMPAIGN_MEDIA_ENABLED` foram observadas ativas. O commit de fonte `03a02b4` e o merge `6cf7d09eb5db4616d88eb0bd524b1d84418f8854` fixado pelo gateway têm a mesma árvore Git `4d5cfcde60596a70b3a18f4ce389628af74331f6`; os arquivos pinados de audience/campaign têm conteúdo idêntico. Isso não comprova grants ativos do banco, nem publicação da sub-rota de mídia no host legado. Nenhum desses serviços ou suas configurações foi modificado pela migração.

O frontend usa URLs públicas em `config.js`: API/cache CX, A/B, cadastro de influenciadores, leitura e ação TikTok. `crm-read-config.js` aponta para `crm-panel-read`. Endpoints de campanhas, templates, públicos e grafos podem vir dinamicamente de `capabilities.endpoints`. Integrações externas de negócio ficam nos backends: n8n, PostgreSQL/Listmonk, Shopify, Meta/WhatsApp, SES, Gleap, TikTok e Troquecommerce. O frontend não coleta diretamente do Gleap.

Os backends e parte de suas funções SQL fixam a origem autorizada em `https://bandssz.github.io`. A mudança futura de origem depende de trabalho coordenado nas camadas HTTP e SQL. Não alterar CORS agora nem contornar a proteção com proxy para produção.

## Isolamento e capacidade

Projeto criado, exclusivo: `dashboard-preview-20260930`; serviço: `web`. Endereço de teste: <https://dashboard-preview-20260930-web.tazdb8.easypanel.host/gestao/>. Usa domínio automático de teste, sem DNS ou rotas atuais.

Capacidade consultada antes de iniciar: 8 CPUs, 32.094,82 MB de memória total, aproximadamente 23.424 MB disponíveis e 336,1 GB livres em disco. Histórico de 24 horas observado em amostras de 5 minutos: CPU máxima de 77,81%, memória máxima de 14.153,69 MB. Nova instância limitada a 0,25 CPU e 256 MB, com reserva de 0,05 CPU / 32 MB, uma réplica e sem sobreposição de réplicas no deploy. Nova consulta deve ocorrer imediatamente antes de qualquer publicação adicional; suspender a nova publicação se houver menos de 2 GB de memória livre, 5 GB de disco livre ou CPU sustentada acima de 85%.

Publicação de teste usa imagem oficial pronta Node 22 Alpine, fixada por digest `sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402`, verificado no registry. Não há build, instalação npm, compilação ou clone do repositório no servidor. Preparação e testes ocorrem no Mac. O pacote descompactado é limitado a 16 MB e o heap Node a 128 MB. A imagem pronta inicia `su` somente com `SETUID`/`SETGID` para executar Node como usuário `node`; o runtime exige UID 1000 antes de extrair arquivos ou abrir a porta. HTTPS `/healthz` confirmou UID/GID 1000, modo sintético, ausência de escrita e integrações externas. Demais capabilities são removidas. O Dockerfile portável usa `USER node` e heap de 96 MB; o orçamento da publicação com mounts é de 128 MB.

Configuração final, conferida por `inspectAppService`: três file mounts (`server.cjs`, `fixtures.cjs`, `bootstrap.cjs`) e um volume **novo e exclusivo**, `dashboard-preview-20260930_web_preview-assets`, montado em `/preview-data`. Não há binds ou volumes de serviços existentes. O volume contém somente `assets-pack.json`, sem credenciais. Seu checksum fixado em `PREVIEW_PACK_SHA256` é `1a77db9c60790e0bc7b4838c637aded545b0caa78063a97184512ef17670ae7f`. O bootstrap valida checksum, lista exata de 28 arquivos, encoding e limites; volume existente sem pacote válido impede iniciar.

O pacote foi semeado uma única vez por um mount temporário no próprio serviço novo e copiado para seu volume. Após confirmar volume, checksum e startup, o mount temporário foi removido e o serviço reiniciado novamente **sem** esse mount. O comando final apenas executa Node como `node`; não copia dados, baixa arquivos ou inicia jobs. O inventário geral do MCP e a inspeção do serviço voltaram a responder dentro do limite. Não manter o pacote grande no campo `mounts[].content`: ele ultrapassa o limite de resposta de 262.144 bytes do MCP. Para recriar do zero, usar o pacote privado regenerado e semear somente o volume novo; nunca limpar ou usar um volume existente de outra aplicação.

Imediatamente antes da criação: CPU 32,51%, memória disponível 22.058,98 MB, disco livre 329,8 GB. Antes do último reinício: CPU 29,08%, memória disponível 22.194,58 MB, disco livre 329,6 GB. Consumo observado do serviço em repouso após o último reinício: 13.570.048 bytes de memória (aproximadamente 13 MB), CPU 0,043%; são amostras pontuais, não uma certificação de carga máxima. Limites configurados e inspecionados: 0,25 CPU / 256 MB, reservas 0,05 CPU / 32 MB, uma réplica, sem sobreposição.

API sintética na mesma origem, sem clientes de banco, upstreams, timers comerciais, jobs, sincronização ou envio. Todas as escritas são recusadas; POSTs históricos exclusivamente de leitura, quando necessários pelos contratos Creators/TikTok, são traduzidos no browser para GET autenticado local mediante allowlist explícita. O servidor aceita somente GET/HEAD. CSP permite conexões somente à própria origem. A faixa de teste deve aparecer tanto nas entradas quanto nos painéis. Somente HTML, bundles e imagens públicas permitidos são servidos; código operacional, SQL, documentação, testes, `.git` e arquivos privados permanecem fora.

Credenciais de teste são geradas aleatoriamente no diretório privado do Mac, fora do Git, com arquivos modo 600. Apenas hashes SHA-256 por escopo são fornecidos ao runtime. Não colocar chaves em imagens, documentação, comandos, URL ou logs. Importar o JSON individual da área na tela de acesso; o JSON de controle com todas as chaves pertence apenas ao executor dos testes.

## Validação e limites do aceite

Validação local concluída: build original `--check` consistente; 30 testes existentes de entrada, autenticação, CSP, assets e rede passaram; 36 verificações de autenticação e 20 de operadores passaram em PGlite descartável, com zero chamadas reais. A suíte nova cobre startup fechado, permissões por área, mutações, Origin, caminhos/symlinks, exclusão de arquivos, CSP e integridade do pacote.

Navegador local: quatro áreas carregadas; login mestre por arquivo e chave, quatro gestores, logout, negativa de acesso cruzado, 27 abas em desktop e celular (390 × 844), 72 probes de mutação recusados, mais quatro consultas de dados fora do escopo recusadas. Dez famílias de leitura sintética foram exercitadas, incluindo os carregamentos sob demanda de escopo, TikTok e cobrança. A última rodada fez 190 requests, sem requisições externas, falhas de assets, erros de JavaScript/console/CSP ou credenciais em armazenamento/URLs/referrer. PNGs ficam somente no diretório privado do Mac.

O primeiro envio ao MCP foi recusado por HTTP 413 antes de criar o serviço. A consulta posterior confirmou somente o projeto novo vazio. O pacote foi reduzido para texto UTF-8 e imagens base64. A segunda criação executou, mas seu retorno ultrapassou o limite de resposta do MCP; não foi repetida. Contêiner, domínio e HTTPS confirmaram o resultado real. A persistência no volume exclusivo descrita acima removeu a limitação do inventário geral. Os quatro serviços existentes permaneceram idênticos à configuração inicial nas conferências posteriores.

A primeira rodada remota identificou uma consulta de capacidades de escrita TikTok que chegava à API e recebia 403, gerando erro no console. O guard de teste passou a recusar rotas `*-blocked` antes da rede; o servidor continua recusando as mutações diretamente. A suíte local final tem nove testes, todos aprovados, incluindo pacote restaurado byte a byte, pin SHA, leitura por volume e negativa de conexão externa. Aceitação do comando de deploy, isoladamente, não prova funcionamento.

Rodada final **no endereço remoto HTTPS**: 228 verificações aprovadas, 182 requests de navegador, dez famílias de integração sintética e 72 tentativas de mutação recusadas. Foram validados login mestre por JSON e chave, quatro acessos de gestores, logout, escopo entre áreas, entradas e abas em desktop e celular. UID/GID 1000 confirmado. Zero solicitações externas, falhas de assets, erros de console/JavaScript/CSP ou falhas inesperadas de API. As negativas esperadas foram 401 para chave inválida e 403 para acesso cruzado. Oito capturas remotas foram revisadas; o banner de teste está visível. Relatório sanitizado e capturas permanecem em `.private/dashboard-easypanel-20260930/`, fora do Git, com permissões privadas. Nenhum processo de teste local ficou ativo.

Conferência final de preservação: configurações completas dos quatro serviços `crm-*` acima coincidem com a leitura inicial, inclusive variáveis, fonte, revisão, deploy, mounts e recursos; todos continuam em execução e saudáveis. As 24 rotas originais permanecem idênticas; a única rota adicional é o endereço automático de teste. O inventário geral responde normalmente com seis projetos e 24 serviços. O checkout principal continua limpo na branch e commit registrados acima.

O teste valida o transporte de hospedagem, assets, navegação, sessão, isolamento de áreas e contratos sintéticos. Não valida credenciais humanas de produção, entrega de mensagens, reconciliação comercial, webhooks ou escrita nos sistemas reais. Dados sintéticos mínimos deixam gráficos e o bloco CSAT vazios; não comprovam cobertura/frescor das fontes de produção. A ferramenta de diagnóstico de pedidos não empacotada deve ser tratada como limitação separada. O seletor CRM “Visualizar como” apresenta sobreposição com o subtítulo em celular, sem impedir a navegação; a interface original não foi alterada. A opção de Dockerfile foi preparada, mas não foi construída neste Mac, que não dispõe de daemon Docker; a instalação remota validada usa a imagem oficial pronta fixada por digest.

Arquivos adicionados nesta branch: `services/dashboard-preview/` (build por allowlist, pacote, bootstrap, servidor/fixtures, guard/CSS, Dockerfile, `.dockerignore` e instruções), `tests/dashboard-preview.test.cjs`, `tests/dashboard-preview-browser.cjs` e este relatório. Nenhum arquivo existente do frontend, backend ou pipeline foi alterado. Os arquivos privados de acesso e configuração não são versionados.

## Entrada em produção e reversão — depende de aprovação

1. Revisar e aprovar a instalação paralela e o escopo da mudança. Fixar o commit final de produção após conciliar as tarefas em andamento; não publicar uma branch antiga por engano.
2. Preparar artefato estático de produção por allowlist e serviço próprio; manter o preview sintético separado. Definir orçamento de recursos e política de cache/CSP. Nunca promover as fixtures sintéticas para produção.
3. Planejar autorização da nova origem em todos os backends, HTTP e SQL, preservando a origem atual durante a transição. Inventariar autenticação de todas as áreas, endpoints fixos/dinâmicos, leitura via POST e permissões de operação. Obter aprovação para essas mudanças concretas antes de executá-las.
4. Validar leituras autenticadas com credencial própria de teste, sem concessões de operação e sem timers/ações duplicadas. Verificar escopos, expiração/revogação, CORS/preflight, cache, mídia e erros. Operações comerciais exigem ambiente e aceite próprios; não usar o banco de produção como teste de migração.
5. Somente com aprovação explícita, dirigir o tráfego real para a nova instalação. Manter GitHub Pages disponível e o artefato/revisão anteriores registrados durante a observação.
6. Reversão: devolver a navegação/rota ao GitHub Pages e revisão registrada, verificar leituras e logins, retirar apenas o frontend novo do tráfego. Como os backends, bancos, coletores e pipelines não são migrados nesta preparação, não há reversão de dados. Desativar o preview ou a hospedagem antiga somente após autorização específica.

Fontes externas consultadas: [imagem oficial Node](https://hub.docker.com/_/node), [serviço App do Easypanel](https://easypanel.io/docs/services/app). Evidências específicas de hospedagem/capacidade foram obtidas pelas APIs autenticadas de GitHub e Easypanel, com projeção sem credenciais.
