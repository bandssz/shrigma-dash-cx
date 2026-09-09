# BACKEND_REQUESTS — frente Dashboard Growth (Claude → Codex)

Revisado em 09/09/2026. Nenhum destes itens está implementado no backend; o front atual mostra
a lacuna como indisponível e não simula o dado. Rotas e campos abaixo são **propostas**, aditivas a
`crm_operacao.schema_version=1` e ao contrato GET Growth, sem segredo e sem payload real.
Ordem = prioridade sugerida pela frente de UI. Prazos da migração operacional têm precedência.

## R1 — Separar consulta de configuração e consulta de execução no inventário

| Campo | Conteúdo |
|---|---|
| Problema do usuário | `fish_pix` e `receiver` aparecem como "Falha na consulta / Ativação desconhecida" desde 08/09 porque uma execução retida com `status=new` e `startedAt=null` faz o sanitizador descartar também `active`, `published`, versões e modos. O painel perde configuração válida por causa de um metadado de execução. Não dá para responder "o PIX Fish está ligado?" olhando o painel. |
| Dados/ação necessários | Manter `active`, `published`, `has_unpublished_changes`, `version_id`, `active_version_id`, `modes` quando a leitura de configuração deu certo, mesmo que a leitura de execução falhe; reportar cada leitura separadamente. |
| Contrato atual | `collection_status` (ok/error) e `collection_error_code` únicos por workflow; `clearWorkflow` zera tudo em qualquer erro (`nota-sanitizador-execucoes.md`). |
| Contrato proposto | Aditivo, por workflow: `"config_collection": {"status":"ok"\|"error","error_code":null\|"...","checked_at":"…","last_good_at":"…"}` e `"execution_collection": {"status":"ok"\|"error","error_code":null\|"invalid_execution_metadata","checked_at":"…"}`. `collection_status` continua existindo com o pior dos dois (compatibilidade). `last_retained_execution` aceita `started_at:null` somente quando `status` ∈ {`new`,`waiting`} e mantém `id`. Exemplo sintético: `{"key":"fish_pix","active":true,"published":true,"modes":[{"key":"modo","value":"real"}],"collection_status":"error","collection_error_code":"invalid_execution_metadata","config_collection":{"status":"ok","error_code":null,"checked_at":"2026-09-09T20:00:30Z","last_good_at":"2026-09-09T20:00:30Z"},"execution_collection":{"status":"ok","error_code":null,"checked_at":"2026-09-09T20:00:30Z"},"last_retained_execution":{"id":"854177","status":"new","started_at":null,"stopped_at":null}}` |
| Permissões e capacidades | Leitura, mesmo escopo Growth. Sem ação. |
| Consistência | `schema_version` permanece 1 (campos novos opcionais). Front trata ausência dos campos novos como hoje. Adicionar teste no coletor para execução `new` sem início e manter rejeição de timestamp inválido em estados que exigem início. |
| Comportamento sem integração | Como hoje: badge "Falha na consulta", ativação/publicação "desconhecida", modo "não confirmado". Filtro "A conferir" agrupa esses casos. |
| Critério de aceite | Payload autenticado com `fish_pix` mostrando `active/published` verdadeiros e `execution_collection` explicando o `new`; teste do coletor cobrindo o caso; fixture sintética atualizada devolvida à frente de UI. |

## R2 — Horário de coleta por fonte no topo do payload

| Campo | Conteúdo |
|---|---|
| Problema do usuário | A faixa de fontes do painel deriva "venda coletada até" do maior `coletado_em` de `crm_conversao` e "e-mail coletado até" de `crm_diario`. `crm_campanha` e `crm_wa_envios` não trazem `coletado_em`; para WhatsApp o front usa `crm_wa_cobertura.ultimo_status_em`, que é o último evento recebido, não a hora da coleta. Se uma fonte parar, o painel pode mostrar hora antiga sem saber que é coleta parada ou ausência de evento. |
| Dados/ação necessários | Hora da última coleta bem-sucedida e status, por fonte. |
| Contrato atual | `gerado_em` (hora da API), `coletado_em` em algumas linhas, `crm_operacao.generated_at`. |
| Contrato proposto | Campo top-level opcional `"crm_fontes": [{"fonte":"shopify_conversao","coletado_em":"…","status":"ok","cadencia_seg":900},{"fonte":"listmonk_campanhas","coletado_em":"…","status":"ok","cadencia_seg":1800},{"fonte":"wa_status_meta","coletado_em":"…","status":"ok","cadencia_seg":300},{"fonte":"ses_transacional","coletado_em":"…","status":"error","erro":"timeout","cadencia_seg":900}]`. `cadencia_seg` permite ao front pintar "velho" com regra da própria fonte em vez de inventar limiar. |
| Permissões e capacidades | Leitura. |
| Consistência | Aditivo; front continua com o fallback atual quando ausente. |
| Comportamento sem integração | Faixa mostra o horário derivado e etiqueta neutra (sem cor), exceto inventário (regra de 15 min já contratada). |
| Critério de aceite | Payload com `crm_fontes` para as quatro fontes; uma coleta forçada a falhar aparece como `status:"error"` no payload seguinte. |

## R3 — Mapeamento template → workflow e métricas por template

| Campo | Conteúdo |
|---|---|
| Problema do usuário | Na aba Templates não dá para saber em qual automação cada template está mapeado nem quantos aceites/entregas ele gerou. O front não adivinha pelo nome (regra do handoff). |
| Dados/ação necessários | Para cada template: lista de `workflow_key` e `piece` que o referenciam; opcionalmente, agregados diários por `template_name` em `crm_wa_envios` (ou coluna `template` nas linhas existentes). |
| Contrato atual | `crm_operacao.templates[].piece` (texto livre) e `usage` (`current`/`native_pending`); `crm_wa_envios` sem template. |
| Contrato proposto | Aditivo em `templates[]`: `"mapped_in":[{"workflow_key":"fish_tx","piece":"pedido-pago","mode_key":"modo_pedido_pago"}]`. Em `crm_wa_envios`, coluna opcional `template_name` mantendo o grão atual (uma linha extra por template quando a peça usar mais de um). |
| Permissões e capacidades | Leitura. |
| Consistência | `mapped_in` vem do manifesto do coletor, não de heurística. Linhas de `crm_wa_envios` com `template_name` ausente continuam válidas. |
| Comportamento sem integração | Coluna "Uso" segue genérica ("Mapeado no fluxo · envio depende da ativação"). |
| Critério de aceite | Template com `mapped_in` apontando para workflow existente no mesmo payload; soma de `aceitos` por `template_name` bate com o total da peça. |

## R4 — Entrega individual das automações de e-mail (SES)

| Campo | Conteúdo |
|---|---|
| Problema do usuário | Card de e-mail e tabela de automações mostram "—" em entregues/falhas para automações via SES. O card declara a lacuna; não dá para saber se a régua está chegando. |
| Dados/ação necessários | Por dia × marca × flow × piece: entregues, bounces (hard/soft), reclamações, via SES event publishing (SNS/Firehose) reconciliados por `messageId`. |
| Contrato atual | `crm_fluxo.enviados` = aceite da API Listmonk. |
| Contrato proposto | Colunas opcionais em `crm_fluxo` para canal `email`: `entregues`, `hard`, `soft`, `complaints`, `ultimo_status_em`. Mesma semântica do WhatsApp: ausência = não medido, não zero. |
| Permissões e capacidades | Leitura no painel; a configuração de event publishing é operação AWS (Codex/Felipe). |
| Consistência | Preencher só a partir da data em que o event publishing estiver ativo; antes disso, `null`. |
| Comportamento sem integração | "—" e etiqueta "entrega individual não medida" (já no card). |
| Critério de aceite | Um dia com `enviados` e `entregues` para uma peça de e-mail, mais um bounce sintético registrado e visível. |

## R5 — Editor de templates (P1/P2, para depois do P0)

Sem backend hoje. Quando a frente Claude entregar o editor de **rascunhos locais**, a integração
precisará de: `GET` de conteúdo e versões por template (corpo, componentes, variáveis, mídia,
status da submissão Meta), `POST` de validação de rascunho (sem submeter), `POST` de submissão
com `Idempotency-Key`, `GET` de acompanhamento da revisão Meta/Listmonk, e ações de workflow
(`ativar/desativar`, `modo real/sombra`) com chave de escrita própria, auditoria (quem, quando,
versão anterior) e distinção explícita entre **rascunho salvo**, **publicado** e **ativo**.
Especificação completa virá na Entrega 3, com exemplos sintéticos; nada disso deve ser aplicado
antes de acordo de contrato.

## Nota da frente Claude

- Nenhuma alteração de produção (n8n, SQL, Meta, Listmonk, SES) foi feita por esta frente.
- Consulta real: GET Growth às 17h03 BRT de 09/09/2026 (HTTP 200, escopo `growth`, snapshot 17h00,
  15 workflows/24 templates, `fish_pix` e `receiver` em `invalid_execution_metadata`). Payload
  guardado fora do repositório e não versionado.
