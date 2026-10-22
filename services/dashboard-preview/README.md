# Instalação paralela sintética

Este pacote publica cópias isoladas dos bundles de frontend do commit `4441561`.
A API usa somente fixtures escritas neste diretório. Não usa banco, n8n, Shopify,
TikTok, Listmonk, e-mail, workers, tarefas agendadas ou upstreams.

`node services/dashboard-preview/build.cjs /caminho/privado/dist-vazio` gera o
contexto mínimo. `node services/dashboard-preview/pack-runtime.cjs
/caminho/privado/dist /caminho/privado/mounts-vazio` gera quatro arquivos para
mounts do serviço e `mounts.json`. Esses arquivos não contêm credenciais.
Use somente o diretório `dist` como contexto Docker, nunca o repositório inteiro.
O Dockerfile fixa a imagem oficial Node por digest, não instala dependências e
executa como `node`. A alternativa sem build usa a mesma imagem pronta, os mounts
em `/app/` e comando `su -s /bin/sh node -c 'exec node
--max-old-space-size=128 /app/bootstrap.cjs'`. Nessa alternativa, a troca inicial
de usuário usa somente `SETUID`/`SETGID` com todas as demais capabilities removidas;
o processo Node executa depois como UID/GID 1000, sem capabilities. Os arquivos
montados precisam ser legíveis pelo usuário `node`. A imagem Docker portável
usa `USER node` diretamente e heap 96 MiB; a alternativa de mounts usa heap
128 MiB dentro do mesmo limite de memória 256 MiB.

Para evitar respostas administrativas acima do limite do MCP, use um volume
novo exclusivo `preview-assets` em `/preview-data`. O seed inicial copia o pack
de `/app/assets-pack.json` para `/preview-data/assets-pack.json` e aplica modo
644 antes de iniciar como `node`. Após confirmar health, o mount de seed pode
ser removido e o comando volta ao `su` acima. O bootstrap prefere exclusivamente
o pack do volume; só usa `/app/assets-pack.json` quando `/preview-data` estiver
ausente. Volume presente sem pack, arquivos simbólicos ou pack inválido impedem
o início. Defina `PREVIEW_PACK_SHA256` com o SHA do artefato escolhido para fixar
a revisão, além do checksum interno e da allowlist exata de 28 arquivos.

Defina antes de iniciar: `NODE_ENV=preview`, `PREVIEW_MODE=synthetic`, `PORT=3000`,
`HOST=0.0.0.0`, `PREVIEW_EXPECT_UID=1000`,
`PREVIEW_ORIGIN=https://endereco-exclusivo-de-teste`,
`PREVIEW_ACCESS_HASHES={"digestSHA256":"master"}`. O último campo
é um JSON privado com hashes hexadecimais de chaves exclusivamente de teste.
Escopos aceitos: `master` (ou `todos`), `cx`, `growth`, `organico`, `influs`.
Chaves em claro nunca devem entrar no build, nos mounts, no Git, nos logs ou em URL.
Use chaves aleatórias no formato `[a-z0-9-]{8,128}`. Não reutilize chaves reais.
O processo recusa iniciar sem mapping válido, sem modo sintético, com
`NODE_ENV=production`, usuário divergente de `PREVIEW_EXPECT_UID` ou variáveis de
integrações conhecidas. Testes locais podem omitir `PREVIEW_EXPECT_UID`.

`/` abre `/gestao/index.html`; entradas de área: `/cx/`, `/crm/`, `/organico/`,
`/creators/`. `/healthz` é público e informa somente isolamento e UID/GID do runtime.
APIs exigem Bearer
e concedem apenas `read`; todos os métodos de escrita são negados. A cópia do
browser traduz apenas os POSTs históricos explicitamente de leitura para GET
local. A API aplica sua própria allowlist de rotas, ações, campos e escopos.
O banner TESTE é inserido em todas as entradas e painéis. A CSP dos dois lados
aceita conexão somente da mesma origem e mantém hashes válidos para os scripts
inline copiados; logos externas são substituídas por arquivos públicos locais.

Inventário: endpoints fixos CX/cache, CRM read, A/B, Influs, TikTok leitura/ação,
cobrança, links orgânicos, candidaturas, aprovações e escopo são substituídos
por `/preview-api/...`. Endpoints dinâmicos de `capabilities.endpoints` (CRM
campanha, audiência, segmentos, templates, e-mail e gráficos de jornada) ficam
ausentes nas fixtures, com escrita indisponível. Links de ajuda/serviços externos
embutidos nos bundles são bloqueados pelo guard; imagens externas, fetch, XHR,
WebSocket, EventSource e beacons também são bloqueados. Nenhum proxy é fornecido.

Reserve uma réplica com limite inicial de 0,25 CPU e 256 MiB, `capDrop: ALL`
(na alternativa `su`, adicione apenas `SETUID`/`SETGID` para a troca inicial),
sem volumes de host/banco, sem publicação de domínios atuais e sem zero downtime.
Só iniciar após conferir a margem do host. O bootstrap valida checksum,
allowlist de nomes/extensões, contagem e tamanho máximo de 16 MiB e extrai
somente para um diretório temporário novo.

Limitações: fixtures mínimas não validam dados reais, sincronizações, campanhas,
pagamentos, envio de mensagens, webhooks ou escrita. Estatísticas e ausência de
dados exibidas são de teste. O teste da autenticação confirma isolamento por área,
nunca o comportamento das chaves/identidades de produção. O cutover e o rollout
do backend exigem uma etapa posterior aprovada explicitamente.
