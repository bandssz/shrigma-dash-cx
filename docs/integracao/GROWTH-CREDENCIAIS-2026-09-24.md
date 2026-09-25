# Growth: credenciais e impacto OpenAI, 24/09/2026

Inventário fresco: 208 workflows no n8n. Os 35 exclusivos de CX foram
excluídos das intervenções; nenhuma chave ou credencial de CX foi alterada.
As referências abaixo são IDs/nome, nunca valores de credenciais.

## OpenAi Shrigma

A credencial é `cUqqleynx284gVXp`. É necessário pesquisar por ID, pois alguns
workflows antigos ainda a chamam de `OpenAi account 2`.

Há **três workflows ativos fora dos 35 exclusivos de CX** com essa referência:

| Workflow | Uso e impacto observado |
|---|---|
| `8r1QOnLEro1AHrVE` — CX — Social · Comentários (orgânico + ads, rotativo) | Classifica sentimento após gravar os comentários. O nó continua pela saída regular em erro; o handoff registra que falhas não viram sentimento indefinido. Não foi executado nem alterado nesta frente Growth. Como não retém sucesso/erro, a lista vazia de execuções não demonstra saúde. |
| `QPDtoVtwIemXA46j` — Comentarios FB + IG (organico) | Classificação no coletor legado que escreve em Google Sheets. Está ativo e usa retry no nó OpenAI. Sem execução retida na leitura atual; não se comprovou que o nó esteja sendo alcançado. Também contém token Meta literal, pendente da etapa Orgânico. |
| `KVZebbMZ0zcslZne` — Categorização e Renomeação Automática (GPT-4o thumbnail + SharePoint) v5 | Cinco execuções recentes terminaram no nó GPT com HTTP 429 e `insufficient_quota`. Renomeação/resultado posteriores dependem desse nó, sem saída regular de erro. Cada execução durou cerca de 6,5–7,5 minutos e gerou 83,95 MB de `runData` em JSON compacto. Carga adicional no n8n; causa de travamento ainda não provada. |

Os IDs das cinco execuções verificadas são 1709802, 1710218, 1710786,
1711460 e 1711976, iniciadas entre 18:15 e 19:15 BRT. Os downloads brutos
foram removidos após preservar somente metadados e tamanhos, sem conteúdo
de arquivos ou imagens.

Cinco workflows inativos também referenciam a mesma credencial: análise de
Meta Ads Aristo (`6zcvCg6xohwzkns4`), análise Meta Ads Fish
(`g6Yd0MB9l65nnI2n`), comentários Aristo (`9t8cfBkmC2gQZ0b8`), UGC Ads
(`NRsSz0UAUChx3NCm`) e Veo3 + Sora2 (`zTkHI7K7wunoHf41`). Sua inatividade
não autoriza exclusão ou mudança de provedor.

**Não foi encontrada dependência direta dessa credencial nos disparos de
Growth**, nem chamada estática desses três workflows por `executeWorkflow`.
A busca também cobriu referência literal a `openai.com` nos workflows
ativos. Isso não é prova absoluta sobre integrações externas ou chamadas
montadas dinamicamente. A falha atual comprovada é na organização de arquivos,
com carga adicional no n8n. O risco para classificação de sentimento vem do
inventário e do handoff; seu alcance atual não foi comprovado. Não se comprovou
interrupção dos WhatsApps e e-mails do CRM por essa credencial.

O início em 27/08 e a fila de 2.146 comentários vêm do handoff; não foram
recontados como fatos atuais. O levantamento não comprou crédito, mudou
provedor, disparou classificação nem mexeu em CX/Orgânico.

HTTP 429 pode representar limites diferentes. Nas cinco execuções, a
evidência é `insufficient_quota`; retries não corrigem falta de crédito ou
limite financeiro. A regularização exige verificar saldo/limite no projeto
OpenAI correto, ou decidir outro provedor. [OpenAI — Error codes](https://developers.openai.com/api/docs/guides/error-codes).

## SQL util e outros segredos

A chave literal do SQL util `ygVyBPjJqGqt2V5E` foi confirmada por comparação
em memória com o arquivo privado. Também aparece no efeito protegido do
TikTok `LCODPC1y6kRPQ6hI` e na sonda inativa `oAg0Fv8K4XY6EylL`. O acesso
foi entregue ao dev de CX segundo o handoff. Por isso **não foi revogada**.
Na continuação desta tarefa o usuário confirmou que o dev ainda usa a chave ou
que sua descontinuação não foi confirmada. A rotação permanece pendente de
migração coordenada desse consumidor; não há autorização para interromper CX.

O [candidato de migração](../../n8n/growth/SQL-UTILITY-CREDENTIAL-MIGRATION.md)
troca a comparação literal por credencial nativa de cabeçalho. Está testado
localmente e exige migração comprovada dos consumidores antes de publicar.
O SQL util continua usando a autenticação anterior em produção.

### Proteção de novas execuções, publicada às 22h19 BRT

Como Growth depende desse utilitário, foi aplicada somente a retenção explícita
`saveDataSuccessExecution=none`, `saveDataErrorExecution=none`,
`saveManualExecutions=false` e `saveExecutionProgress=false`. O export fresco,
o candidato e a leitura posterior confirmaram igualdade de todos os nós,
conexões, chave, rota, credencial do banco e parâmetros SQL. Uma consulta sintética
com argumento nativo retornou o valor esperado; chave incorreta continuou recebendo
HTTP 401. O workflow permaneceu ativo, com a versão `bc0a979c-b3e6-4ae5-a9d0-a7b1eb99623d`.

Isso reduz a retenção futura de corpos que contêm a chave. A configuração foi
conferida para não salvar detalhes de sucesso, falha ou execução manual nem
checkpoints de progresso; não comprova ausência de snapshots temporários ou
dados em execuções que permaneçam abertas.
Não apaga histórico, não remove a chave literal do código/versões antigas e não
substitui a migração para credencial e a rotação coordenada. Nenhum consumidor
precisou mudar sua chamada. Recibos privados: `bloco2-sql-util-retention-receipt.json`
e `bloco2-sql-util-retention-auth.json`, junto dos exports anterior/posterior.

A varredura por padrões apontou dez workflows ativos fora de CX para
revisão de segredo embutido: o SQL util, sete de TikTok Shop, a captura de
TikTok Ads e o coletor legado de comentários. Os nove fora de Growth não
foram editados. Assinaturas TikTok exigem credencial/assinador que preserve
os controles existentes; mover uma chave para outro texto de código não
cumpre a migração. O app secret exposto no handoff continua pendente de
rotação no provedor e troca coordenada dos consumidores.

## Arquivo operacional privado

Removidas **cinco entradas** do arquivo operacional usado por esta tarefa:
`GROWTH_ACCESS_KEY`, `GQL_ARISTO_URL`, `GQL_ARISTO_KEY`,
`META_ONESHOT_URL`, `META_ONESHOT_KEY`. Conferência posterior confirmou
ausência dessas entradas e igualdade dos demais valores; backup privado
com permissão 0600 preservado. Pacotes históricos não foram reescritos.

A classificação dessas entradas como mortas e sua remoção local se basearam
na instrução do usuário e no handoff de 24/09; não houve confirmação de revogação
no provedor. Não houve novo teste dos endereços legados: a revisão automática
recusou transmitir credenciais a esses destinos. A limpeza local não
revogou credenciais nem alterou serviços. Um levantamento separado dos
erros na API vigente do n8n foi realizado com sucesso.

Evidências privadas: `growth-audit-20260924/inventory-safe.json`,
`openai-impact-safe.json`, `openai-execution-size-safe.json` e
`env-clean-receipt.json`, em `.private/runtime/`. Nenhum desses relatórios
substitui recibo de rotação: **nenhuma chave viva foi rotacionada nesta etapa**.
