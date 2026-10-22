# Operação individual pelo CRM

Estas ferramentas chamam `crm.shrigma.com.br` com a sessão individual autenticada no OAuth. Não chamam o Listmonk diretamente nem usam a conta do proprietário. Se `crm_status` não retornar `operator: "crm"`, e-mail da pessoa e marca admitida, a conexão nova não está pronta. Oriente reconectar no conector; não peça senha no chat. Uma sessão CRM expirada exige novo login OAuth.

Em 20/10, a liberação nova é QA. O “passou” de Felipe abre o rollout geral; não equivale a autorizar envio comercial. Não alterar 281/282 nem adotar campanhas históricas para testar.

## Consultar antes de agir

| Ferramenta | Uso |
|---|---|
| `crm_status` | Identidade e permissões atuais; argumentos vazios. |
| `crm_audience_list` / `crm_audience_get` | Públicos da própria marca; `brand`, e `id` no GET individual. |
| `crm_campaign_catalog` | Listas e layouts nativos admitidos; `brand`. |
| `crm_campaign_list` / `crm_campaign_get` | Campanhas da marca; `brand`, `page` opcional ou `id` no GET. |
| `crm_models_list` / `crm_model_get` | Peças do CRM; `brand`, `offset` opcional ou `id` no GET. |

Indisponível não é zero. Não materialize público com condições numa lista nem troque seu público pela base inteira. Esta versão do conector consulta públicos; não cria nem altera suas definições. A campanha só recebe IDs de listas nativas que correspondam ao público pedido e sejam admitidas pelo CRM. Se isso não estiver provado, salve a peça e informe a lacuna.

## Salvar e reabrir a peça

1. Confira marca, assunto, HTML e texto; faça o pré-voo editorial. `{{ .Subscriber.FirstName }}` e `{{ .Subscriber.LastName }}` são expressões nativas, preservadas no HTML.
2. Com o pedido de salvar, gere uma única UUID para `idempotency_key` e chame `crm_model_save` com `brand`, `name`, `subject`, `html` e essa chave. Texto continua no arquivo editorial e na definição da campanha.
3. Confira `operation.state: completed` e obtenha o `draft_id` em `operation.response.body`. Reabra com `crm_model_get` e compare o HTML.
4. Em timeout, consulte somente `crm_model_operation` com a mesma `brand` e `idempotency_key`. Não gere outra chave para tentar de novo.

O ID de peça `d_piece_...` é do CRM. `template_id` numérico é o layout nativo Listmonk; não troque um pelo outro.

## Campanha

`crm_campaign_create` recebe `brand`, `definition`, e opcionalmente `audience_id` / `audience_name`. A definição usa o contrato `crm-campaign-v1`: `schema_version`, `brand`, `channel: email`, `name`, `subject`, `from_email`, `reply_to`, `list_ids`, `template_id`, `html`, `text`, `tags`, `initiative`, `utm_campaign`, `send_at`. Use valores efetivamente lidos e a marca atual. Na criação, `send_at: null`; criar rascunho não envia.

O CRM mantém remetente Avisos da marca e Contato em Reply-To; Contato como remetente é reservado e não deve ser escolhido por conveniência. Remetente e resposta nunca vêm da outra marca.

Após o ACK com `campaign.id`, releia `crm_campaign_get`. Para `crm_campaign_save`, passe `brand`, `id`, `definition`, `attribs`, `media` e `headers` da leitura atual; altere só o conteúdo pedido. Preserve os demais metadados. O CRM aplica a identificação UTM com o ID nativo; confira HTML e texto reabertos. Não invente `operation_id`, `claim`, hash de revisão ou journal para estas ações.

## TEST interno

Com autorização explícita, use `crm_campaign_test` com `brand`, `id`, `definition`, `attribs`, `media`, `headers` atuais e `recipient` interno informado. O CRM prefixa `[TESTE] `. Faça uma chamada; não repita TEST aceito ou incerto, nem troque campanha/endereço para contornar a proteção. `accepted: true` comprova aceite da API; recebimento físico depende da caixa interna. Não anuncie entrega a partir do ACK.

## Horário e cancelamento

Apresente marca, ID, assunto, público/listas e lacunas da contagem, remetente, resposta, estado do TEST e horário de Brasília antes de agendar. Esta liberação permite apenas campanha QA; envio comercial precisa da autorização própria do responsável.

1. Salve `definition.send_at` pela ferramenta de salvar, usando a data ISO com fuso; releia o mesmo instante. As contas QA liberadas têm janela de 20 minutos a 7 dias. Não aplique essa janela a uma conta antiga que mantém limite de 2 horas.
2. Com a confirmação correspondente, chame `crm_campaign_schedule` com `brand`, `id`, `send_at` já salvo e `confirm: agendar`. O Listmonk agenda. Releia `status: scheduled` e o horário; `13:00:00Z` e `13:00:00.000Z` representam o mesmo instante.
3. `crm_campaign_cancel` usa `brand`, `id`, `list_ids`, `attribs`, `media` da leitura atual e `confirm: cancelar`. Releia `draft`, `send_at: null` e `sent`. O cancelamento não recolhe mensagens que já tenham sido enviadas; não invente zero.

Em resultado incerto, consulte o ID nativo antes de qualquer decisão. Criação sem ID confirmado exige listagem e revisão; não repita automaticamente. Não há ferramenta nova para pausar, enviar agora, alterar inscritos/listas, ativar jornada comercial, mexer em SES/DNS, supressões ou credenciais. Informe a função ausente e continue somente o trabalho independente.
