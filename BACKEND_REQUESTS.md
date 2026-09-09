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

## R5 — Gestão de templates e workflows pelo painel (Entrega 3 · proposta de contrato)

Especificação completa para o Codex revisar e implementar. **Nada abaixo existe hoje.** O front atual
(Entrega 2) só tem rascunhos locais e não exibe nenhum destes botões; ele passará a exibi-los
**apenas** quando a API declarar a capacidade correspondente em `capabilities` (R5.1). Fixture
sintética do contrato inteiro: `tests/fixtures/growth-templates-contract.synthetic.json`.

### Princípios

1. **Quatro estados distintos, sempre nomeados:** `rascunho` (só no painel/servidor, nada externo),
   `validado` (checagem do backend passou, nada externo), `submetido` (enviado à Meta/Listmonk,
   aguardando), `publicado` (Meta `APPROVED` / campanha Listmonk criada), e, separado, **`ativo`**
   (workflow n8n em modo real usando a versão). Publicado ≠ ativo; a UI nunca funde os dois.
2. **Chave de escrita própria**, como o A/B (`shrigma_ab_key` é o precedente): a chave de leitura Growth
   não escreve. Toda escrita leva `k` no corpo e recebe 401 se a chave não tiver a capacidade.
3. **Idempotência** em toda escrita: header `Idempotency-Key` (UUID gerado pelo painel) ou campo
   `idempotency_key` no corpo; repetir a mesma chave devolve a mesma resposta sem repetir efeito.
4. **Versão esperada** em toda alteração: `expected_version` (do template) ou `expected_version_id`
   (do workflow). Divergência → `409 version_conflict` com a versão atual no corpo; o painel mostra
   "alguém alterou antes de você" e recarrega.
5. **Auditoria** gravada pelo backend: `quem` (rótulo da chave, não a chave), `quando`, `ação`,
   `versão anterior → nova`, `resultado`. Exposta por GET.
6. **Sem corpo de template = sem prévia.** O painel só mostra prévia de template publicado quando
   `GET /templates/{key}` devolver `components`.

### R5.1 — Capacidades da chave (aditivo ao GET Growth atual)

| Campo | Conteúdo |
|---|---|
| Problema do usuário | O front não sabe se pode mostrar "Salvar no servidor", "Submeter à Meta" ou "Ativar". Sem isso, ou esconde tudo (hoje) ou mostra botão que não funciona (proibido). |
| Contrato proposto | Top-level opcional na resposta do GET Growth: `"capabilities": {"templates":{"read_content":true,"draft":true,"validate":true,"submit":false,"list_history":true},"workflows":{"set_mode":false,"activate":false},"write_key_required":true,"api_version":"2026-09-1"}`. Ausente → front trata tudo como `false` (comportamento atual). |
| Comportamento sem integração | Igual a hoje: rascunho local, sem botões de escrita. |
| Critério de aceite | GET com `capabilities` presente; front em fixture mostra os botões só das capacidades `true`. |

### R5.2 — Conteúdo e histórico de templates (leitura)

**`GET /webhook/crm-template-api-<id>?k=<leitura>&acao=listar&marca=fish`**
Resposta (sintética):
```json
{"api_version":"2026-09-1","templates":[{"key":"fish_rastreio","brand":"fish","channel":"whatsapp","name":"fishermans_rastreio_v2","id":"1063000000000001","language":"pt_BR","category":"UTILITY","status":"APPROVED","version":3,"published_at":"2026-09-07T14:00:00Z","components":[{"type":"HEADER","format":"TEXT","text":"Seu pedido saiu"},{"type":"BODY","text":"Olá {{1}}, o pedido {{2}} está a caminho. Código: {{3}}","example":{"body_text":[["Ana","#48213","JT0000123BR"]]}},{"type":"FOOTER","text":"Fishermans"},{"type":"BUTTONS","buttons":[{"type":"URL","text":"Acompanhar pedido","url":"https://conta.fishermans.com.br"}]}],"mapped_in":[{"workflow_key":"fish_tx","piece":"rastreio-criado","mode_key":"modo_rastreio"}],"quality_score":null,"rejected_reason":null}]}
```
- `components` segue o formato da Graph API da Meta (sem tradução própria) para o painel poder
  montar prévia fiel e reenviar sem conversão.
- `quality_score`/`rejected_reason` só quando a Meta fornecer; `null` não é "sem problema".
- Para e-mail (Listmonk): `channel:"email"`, `components` vira `{"subject":"…","body_html":"…","altbody":"…"}`,
  `status` ∈ {`draft`,`scheduled`,`running`,`finished`,`cancelled`}.

**`…&acao=historico&key=fish_rastreio`** → `{"events":[{"at":"…","who":"chave-felipe","action":"submit","from_version":2,"to_version":3,"result":"ok","detail":null}]}`.
`who` é o rótulo cadastrado para a chave, nunca a chave.

### R5.3 — Rascunho no servidor e validação (escrita, sem efeito externo)

**`POST …` corpo `{"k":"<escrita>","acao":"rascunho","idempotency_key":"…","rascunho":{…}}`**
`rascunho` = exatamente o objeto que o painel exporta hoje (`tipo: shrigma-growth-rascunho`, `versao: 1`):
`canal, marca, idioma, categoria, nome, peca, cabecalho, corpo, rodape, assunto, exemplos, botoes`.
O backend converte para `components` da Meta; o painel não faz essa tradução.
Resposta `201 {"draft_id":"d_01J…","version":1,"estado":"rascunho","salvo_em":"…"}`.

**`…"acao":"validar","draft_id":"d_01J…"`** → `200 {"estado":"validado","erros":[],"avisos":[{"codigo":"UTILITY_OFFER_WORDING","mensagem":"…"}],"components_preview":[…]}`
ou `422 {"erros":[{"codigo":"BODY_TOO_LONG","campo":"corpo","mensagem":"…"}]}`. Validar nunca chama a Meta.

Erros comuns (todas as escritas): `401 invalid_key`, `403 capability_missing`, `409 version_conflict`,
`409 idempotency_replay_mismatch` (mesma chave, corpo diferente), `422 validation`, `429 rate_limited`,
`502 upstream_error` (Meta/Listmonk indisponível, com `retry_after`).

### R5.4 — Submissão e acompanhamento (escrita com efeito externo)

**`…"acao":"submeter","draft_id":"d_01J…","expected_version":1,"confirm":"submeter"`**
- `confirm` textual obrigatório: o painel exige que a pessoa digite a palavra; evita clique acidental.
- Resposta `202 {"submission_id":"s_…","estado":"submetido","provider":"meta","provider_id":"1063…","submitted_at":"…"}`.
- **`…&acao=submissao&submission_id=s_…`** (GET) → `{"estado":"submetido"|"publicado"|"rejeitado","provider_status":"PENDING"|"APPROVED"|"REJECTED","rejected_reason":null|"…","checked_at":"…"}`.
  Painel consulta a cada 60 s enquanto `submetido`; o backend é quem fala com a Meta.
- Submeter **não** altera workflow nenhum. Template `APPROVED` fica "publicado, não ativo" até R5.5.
- E-mail: `provider:"listmonk"`, cria campanha em `draft` no Listmonk; agendamento continua sendo
  feito no Listmonk (fora deste contrato) até decisão contrária.

### R5.5 — Controles de workflow (escrita com efeito operacional)

**`…"acao":"workflow_modo","workflow_key":"aristo_tx","mode_key":"modo_rastreio","value":"real","expected_version_id":"6ba7…","confirm":"real"}`**
**`…"acao":"workflow_ativar"|"workflow_desativar","workflow_key":"aristo_pix","expected_version_id":"7416…","confirm":"ativar"}`**
- Resposta `200 {"workflow_key":"aristo_tx","version_id":"<nova>","active":true,"modes":[…],"applied_at":"…"}`.
- Só valores `real|sombra|interno`. Trocar para `real` exige `confirm:"real"`.
- Backend registra na auditoria e o coletor do inventário deve refletir na coleta seguinte (`crm_operacao`).
- **Guarda do lado do backend**, não do painel: recusar `real` se o template mapeado não estiver `APPROVED`
  (`422 template_not_approved`) ou se a WABA estiver com faturamento bloqueado (`422 waba_blocked`,
  regra do incidente 131042 de 04/09).

### R5.6 — Papéis e permissões (capabilities por chave)

| Capacidade | Quem (proposta) | Efeito |
|---|---|---|
| `read_content`, `list_history` | chave Growth (leitura) | vê corpo e histórico |
| `draft`, `validate` | chave de escrita "conteúdo" (Felipe, Jorge) | salva rascunho no servidor, valida |
| `submit` | chave de escrita "publicação" (Felipe) | submete à Meta/Listmonk |
| `set_mode`, `activate` | chave de escrita "operação" (Felipe; Codex durante a migração) | muda modo/ativa workflow |

Uma chave pode ter várias capacidades; o rótulo (`who`) é o que aparece na auditoria.

### R5.7 — Comportamento do painel em cada situação

| Situação | O que o painel mostra |
|---|---|
| Sem `capabilities` (hoje) | Só rascunho local, aviso "salvo só neste dispositivo" |
| `draft:true`, `submit:false` | Botão "Salvar no servidor" e "Validar"; badge "rascunho no servidor · não submetido"; sem botão submeter |
| `submit:true` | Botão "Submeter à Meta" com confirmação textual; após 202, badge "submetido · aguardando Meta" com hora; nunca "aprovado" antes do GET dizer `APPROVED` |
| Template `APPROVED` sem workflow em `real` | Badge "publicado · não ativo" |
| `set_mode:false` | Modo exibido como hoje, sem controle |
| `409 version_conflict` | "Alterado por <who> às <hora>. Recarregar e refazer." — nunca sobrescreve |
| `502 upstream_error` | "Meta/Listmonk indisponível; nada foi alterado" quando o backend garantir isso; senão "estado incerto, consulte o histórico" |

### R5.8 — Critérios de aceite (por etapa)

1. **R5.1+R5.2:** GET com `capabilities` e `acao=listar` devolvendo `components` reais de um template
   existente; painel em fixture renderiza prévia fiel; `historico` com pelo menos um evento real.
2. **R5.3:** rascunho exportado pelo painel hoje aceito sem alteração pelo `POST rascunho`; `validar`
   devolve `422` para corpo de 1025 caracteres e `200` para o rascunho de exemplo da fixture; repetir o
   mesmo `idempotency_key` não cria segundo rascunho.
3. **R5.4:** submissão de um template de teste em WABA de teste (não produção) com acompanhamento até
   `APPROVED`/`REJECTED`; auditoria com `who`.
4. **R5.5:** troca `sombra→real` de um workflow com `expected_version_id` errado devolve `409`; com o
   certo altera e o inventário reflete na coleta seguinte; tentativa de `real` com template não aprovado
   devolve `422 template_not_approved`.
5. Em todas: zero credencial na resposta; nenhuma rota aceita a chave de leitura para escrita.

## Nota da frente Claude

- Nenhuma alteração de produção (n8n, SQL, Meta, Listmonk, SES) foi feita por esta frente.
- Consulta real: GET Growth às 17h03 BRT de 09/09/2026 (HTTP 200, escopo `growth`, snapshot 17h00,
  15 workflows/24 templates, `fish_pix` e `receiver` em `invalid_execution_metadata`). Payload
  guardado fora do repositório e não versionado.
