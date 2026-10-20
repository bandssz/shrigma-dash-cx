> **Contrato antigo, somente para a conta já autorizada que expõe listmonk_*.** A conta nova que expõe `crm_*` segue [operação pelo CRM](operacao-crm.md). Não use este contrato após uma recusa do CRM nem misture seus argumentos ou chaves com o fluxo novo.

# Contrato anterior: Listmonk pelo MCP individual

Este contrato pertence às contas antigas do conector **CRM Shrigma — Listmonk**. A identidade OAuth é individual; usuário API e chave Listmonk ficam no servidor. Não pedir chave nem senha no chat e não carregar credencial local. Acesso ao painel CRM é separado. O uso depende do provisionamento e autorização próprios da pessoa, catálogo e comprovação SMTP. Uma recusa de liberação também pode ocorrer em leitura: não representar como catálogo vazio. A conta nova usa o CRM e não recorre a este contrato após uma recusa.

Para conectar: o Owner cadastra o conector uma vez na organização. Cada pessoa abre **Customize → Connectors → CRM Shrigma — Listmonk → Connect**, entra com o próprio login e senha do conector e o habilita na conversa. A identidade é individual; nunca use a do Owner. Se uma ferramenta não aparecer, orientar essa conexão; não substituí-la por API, chave do proprietário ou Terminal.

## Contrato e resultado

Todos os objetos são estritos: não acrescentar campos de outro contrato. Use `structuredContent` quando existir; caso contrário, leia o JSON em `content[].text`. `refused:true` ou `error` é falha. `state:uncertain` continua incerto mesmo com HTTP200 ou MCP `isError:false`.

| Ferramenta | Argumentos |
|---|---|
| `listmonk_lists_get` | `brand` |
| `listmonk_templates_get` | `brand` |
| `listmonk_campaign_get` | `brand`, `campaign_id` |
| `listmonk_draft_create` | `brand`, `operation_id` UUID, `draft` |
| `listmonk_draft_update` | `brand`, `operation_id`, `campaign_id`, `revision` UUID, `patch` |
| `listmonk_campaign_test` | `brand`, `operation_id`, `campaign_id`, `revision`, `recipient` |
| `listmonk_campaign_schedule` | `brand`, `operation_id`, `campaign_id`, `revision`, `send_at` |
| `listmonk_campaign_to_draft` | `brand`, `operation_id`, `campaign_id`, `revision` |
| `listmonk_campaign_pause` | `brand`, `operation_id`, `campaign_id`, `revision` |
| `listmonk_operation_get` | somente `operation_id`, sem `brand` |

`draft` recebe somente `name`, `subject`, `from_email`, `reply_to`, `lists`, `template_id`, `body`, `altbody`. `patch` aceita esses campos parcialmente, mas exige **from_email e reply_to em toda edição**. HTML e texto têm limite de200.000 caracteres cada no MCP. Não passar `headers`, `tags`, `attribs`, `body_source`, `messenger`, `content_type`, JSON `crm-campaign-v1` completo ou metadados CRM. O servidor monta os headers e seus marcadores próprios; o preparo local conserva o contrato editorial sem transportar esses campos adicionais.

Uma escrita concluída devolve `state:succeeded`, `campaign_id`, `revision`, `before`, `after` e `diff:[{field,before,after}]`. Guarde ID, revisão e operation_id com a ação. Operação já registrada e `operation_get` não devolvem revisão: depois de uma reconciliação concluída, releia `campaign_get`. A revisão muda quando muda o conteúdo; testar, agendar, pausar ou voltar a draft não a renovam. `content_matches_saved_revision:false` exige reconciliação, sem sobrescrever.

## Percurso da campanha

1. **Consultar.** Identifique a marca e leia listas e templates pelo MCP. Use o body do wrapper efetivamente retornado. `subscriber_count` é a estatística da lista, com horário da consulta; não é contagem única/elegível da união de listas nem prova de supressão atual. `statistics_refresh_at:null` significa frescor desconhecido. Se a decisão depender do elegível ainda não disponível, mantenha a pendência e não invente SQL ou total.
2. **Preparar.** Mantenha o JSON `crm-campaign-v1`, HTML e texto locais conforme as regras da skill. Pedido de conteúdo não autoriza criar rascunho remoto. Depois de autorizada a criação, `mcp_campaign_cli.cjs draft` produz `mcp-draft.json` com campos exatos e operation_id único. Confira e use esse objeto uma vez em `listmonk_draft_create`. O rastreamento ainda está pendente do ID real; não testar nem agendar essa peça intermediária.
3. **Vincular tracking.** Após criação comprovada, consulte `campaign_get`, `lists_get` e `templates_get`. Registre os resultados reais sem alterá-los e o horário em que cada resposta foi recebida, no formato abaixo. `mcp_campaign_cli.cjs prepare` usa o ID e a revisão reais, gera `mcp-update.json`, HTML/texto e wrapper, sem HTTP ou escrita remota. Não inventa `started_at` ou `updated_at`, ausentes no retorno MCP. Alias/iniciativa não são publicados no CRM por esse preparo; o helper informa a lacuna.
4. **Revisar e salvar.** Rode o checklist com o wrapper retornado; revise desktop/mobile, marca, oferta e texto. Aplique `mcp-update.json` uma vez em `listmonk_draft_update`, com o operation_id gravado no arquivo. Confira `state`, revisão, diff e uma nova leitura da campanha. O helper não envia nem salva no Listmonk. Se o erro foi resultado incerto, não gere outra revisão local para tentar novamente.
5. **Testar.** Use a revisão salva final e um único destinatário interno exato previamente habilitado pelo responsável. O MCP confere existência, enabled, assinatura confirmed em lista ativa e pertencimento à marca. Domínios aceitos: `oaristocrata.com`, `fishermans.com.br`, `shrigma.com.br`. Não há testador externo, cadastro, reinscrição ou outro caminho. **Um teste por campanha/revisão, entre todos os operadores**; trocar endereço ou operation_id não libera outro. Assunto e wrapper são os salvos, sem prefixo de teste inserido por esta ferramenta. Aberturas/cliques de teste podem entrar nas métricas; não prometer isolamento. Aceite da API não prova recebimento/SMTP/entrega.
6. **Agendar.** Apresente o resumo previsto na skill: marca, ID/revisão, assunto, From, Reply-To, template, listas/estatísticas e lacunas, estado do teste, data/fuso e diff. Com a autorização correspondente, gere e conserve um novo operation_id para essa ação; chame `campaign_schedule` com data completa, segundos e offset, ao menos15min futuros no relógio do servidor. Releia `scheduled` e `send_at`; sem prova, não anunciar agendamento concluído.
7. **Acompanhar/conter.** `campaign_get` devolve enviados, a enviar, views, cliques e bounces quando disponíveis; ausência não é zero e enviados não são entregas SES. Para campanha própria `scheduled`, use `campaign_to_draft` e confirme `draft`/`send_at:null`. Para própria `running`, `campaign_pause` e confirme `paused`. A pausa não recolhe mensagens já aceitas. Não existe ferramenta de retomar, excluir ou enviar imediatamente.

Todas as campanhas preexistentes, inclusive188–191, estão fora deste conector. Não adotar uma campanha antiga, reescrever seus marcadores nem criar cópia para contornar uma recusa. Não há listagem geral de campanhas: conserve os IDs e recibos dos rascunhos criados. As sete jornadas, templates, listas, assinantes, supressões, SMTP, SES, credenciais e workflows ficam fora das mutações deste pacote. Conteúdo transacional pode ser estudado localmente, mas não operado por estas ferramentas.

## Helpers offline

```sh
node scripts/campaign_cli.cjs normalize campanha.json
node scripts/mcp_campaign_cli.cjs draft campanha.json --out-dir rascunho-LOCAL-NOVO
node scripts/mcp_campaign_cli.cjs prepare campanha.json --receipts recibos-mcp.json --out-dir revisao-LOCAL-NOVA
python3 scripts/checklist.py revisao-LOCAL-NOVA/body.html --template revisao-LOCAL-NOVA/wrapper-real.html --text revisao-LOCAL-NOVA/text.txt --brand aristo --campaign ALIAS --campaign-id ID_REAL --list-ids IDS_REAIS --json
```

Os comandos são executados pelo Claude em seu ambiente de arquivos; o analista não precisa abrir Terminal. `draft` e `prepare` recusam diretório existente para não sobrescrever uma intenção. O exemplo de marca/alias/IDs precisa dos valores reais da tarefa. Os JSONs de ação contêm o operation_id a conservar, sem segredo. `campaign_cli.cjs prepare` pertence ao formato legado: não preencher seus campos nativos ausentes com zeros ou datas inventadas para fazê-lo aceitar MCP.

`recibos-mcp.json`, com cada `result` substituído pelo objeto exato devolvido pela respectiva ferramenta e `received_at` pelo horário real da recepção:

```json
{
  "brand": "aristo",
  "campaign": {"received_at": "HORARIO_REAL_ISO_COM_FUSO", "result": {}},
  "lists": {"received_at": "HORARIO_REAL_ISO_COM_FUSO", "result": {}},
  "templates": {"received_at": "HORARIO_REAL_ISO_COM_FUSO", "result": {}}
}
```

Esse esqueleto vazio é inválido. Os recibos devem ter até5min; o helper também confere a marca, a revisão, rascunho com zero enviados explicitamente retornado, listas iguais, template e conteúdo sem divergência. Os horários de recepção são anotações do cliente, não timestamps nativos inventados. Validação local não autentica um arquivo fabricado; a escrita MCP ainda revalida identidade, revisão, conteúdo, catálogo e template no servidor.

## Timeout e recusa

Conserve o operation_id antes da escrita. Em timeout, erro de transporte ou `state:uncertain`, consulte **somente** `listmonk_operation_get` com o mesmo ID. `OPERATION_NOT_FOUND` não prova ausência de efeito; conserve o ID e peça a reconciliação ao responsável, sem POST automático. Não repetir a escrita, gerar outro UUID, destinatário, cópia ou mudança cosmética para destravar. Uma reconciliação de leitura não promove estado incerto nem libera lock.

Quando o servidor recusar, informe o motivo de forma clara e a pendência concreta. Liberação inicial, vínculo ausente, destinatário inativo, template alterado e campanha fora do escopo não se resolvem com chave alternativa. A rotina editorial pode continuar offline. Primeiro uso real e primeiro teste interno continuam condicionados à prova SMTP e ao ok do proprietário.
