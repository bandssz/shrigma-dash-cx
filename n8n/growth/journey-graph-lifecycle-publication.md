# Publicação pausada pelo construtor

Candidato integrado à API `crm-audience` e à tela existente. O gate
`CRM_AUDIENCE_GRAPH_LIFECYCLE_ENABLED` nasce `false`. Esta entrega não habilita
ativação, entrada de participantes, transporte nem anúncio de capacidade.

O Gestor salva o rascunho, clica em **Conferir publicação**, confirma **Preparar
mensagem** e, depois, confirma **Publicar pausado**. A conferência dura 30 segundos.
O primeiro recorte aceita Fishermans e O Aristocrata, carrinho abandonado e uma
mensagem de e-mail ligada ao slot publicado `email:carrinho-30min` da própria marca.
Os bloqueios são apresentados no mesmo construtor. Outros gatilhos, WhatsApp e
múltiplas mensagens permanecem fora deste recorte.

Preparar fixa o material e sua origem, sem reservar uma revisão. Publicar cria
`base.revision + 1` na mesma jornada, avança a versão, aponta `head_revision` e
`published_revision` para a revisão nova e mantém `paused=true`. A revisão anterior
e seus participantes são preservados. A publicação fica disponível para consulta;
o salvamento de rascunho não pode sobrescrevê-la. Outra preparação começa em um
novo fluxo enquanto não existir um percurso próprio de edição de publicação.

## Fronteira e recuperação

A rota `/journey-graph-lifecycle` pertence ao serviço existente. POST aceita somente
`review`, `prepare` e `publish`; GET aceita `operation` e `status`. O contrato é
`journey_graph_lifecycle_panel_v1`. Ativar e pausar execução não são rotas deste
recorte. Os comandos têm campos exatos e o ator sempre vem da credencial Growth.

Cada operação usa conexão exclusiva, READ COMMITTED, prazo no PostgreSQL e
reautenticação após esperas e antes do COMMIT. A preparação e a publicação
compartilham o namespace de request IDs. Locks, comparação da versão, catálogo,
origem e material protegem a escrita. Revisão e recibo da publicação são atômicos.
O login `crm_audience_api` usa helpers limitados e não recebe UPDATE em fontes
nativas, credenciais ou jornadas, nem permissões de entrada ou transporte.

O cliente reutiliza o diário durável de rascunhos, inclusive a trava entre abas.
Depois de perder uma resposta, consulta o mesmo request ID por GET. Uma operação
sem confirmação bloqueia novas gravações e não repete POST, mesmo que a interface
legada de rascunho permita retomar um salvamento. A tela grava a identidade e o
recibo localmente antes de liberar a próxima operação. Edições locais mais novas
são preservadas durante a recuperação. Consultas permanecem disponíveis quando o
gate de novas publicações é desligado.

## Liberação separada

O anúncio da tela exige endpoint HTTPS válido e:

```json
{"contract":"journey_graph_lifecycle_panel_v1","prepare":true,"publish_paused":true,"activate":false,"brands":["fish","aristo"]}
```

Esse anúncio só deve ser instalado após conferir SQL, grants, versão da API e o
percurso autenticado nas duas marcas. A atualização do serviço existente depende
da janela de Felipe. Não reinstalar o núcleo graph nem os módulos de campanha,
A/B ou Shopify já presentes. Os DDL de preparação, publicação e acesso são
aditivos e recusam colisões.

Publicar pausado não comprova cópia/cache nativo, identidade da instância, entrada
de eventos, consentimento disponível no runtime ou emissão. A ativação exige
essas provas e um comando próprio; as autorizações de envio continuam falsas.

## Provas do candidato

- `journey-graph-lifecycle-panel-path.test.cjs`: DOM → diário → API → banco,
  duas marcas, resposta perdida, recarga, consulta e publicação sem edição.
- `journey-graph-lifecycle-client.test.cjs`: trava compartilhada, recibos
  incompatíveis, mudança de ator e recuperação sem novo POST.
- `journey-graph-lifecycle-publication.test.cjs`: versão/revisão, material,
  autoria, atomicidade e histórico preservado.
- `journey-graph-lifecycle-runtime-access.test.cjs`: papel restrito e grants.
- `journey-graph-lifecycle-runtime-postgres.cjs`: login PostgreSQL real,
  conexões independentes, concorrência, rollback e conexão fechada após COMMIT.

São provas sintéticas sem envio; resultados e hashes devem constar no recibo da
rodada. Não substituem readback e aceite da implantação.
