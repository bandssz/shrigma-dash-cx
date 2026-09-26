# Catálogo de planejamento de jornadas

Este candidato permite escolher uma entrada e e-mails reais de Fish ou Aristo para preparar rascunhos. Não inscreve participantes, publica jornadas nem envia mensagens. Não foi instalado em produção.

## Contrato da ponte

- `crm_graph_candidate.catalog_v1(brand)` retorna apenas o objeto estrito `journey_graph_v1`: `version`, `brand`, `triggers`, `fields` e `messages`. É `STABLE`; não inclui horário, rótulos nem prontidão. A ponte deve conferir o mesmo objeto antes da validação e dentro da trava de criação/edição.
- `crm_graph_candidate.catalog_ui_v1(brand)` retorna `{catalog,labels,readiness,unsupported,checked_at}`. Rótulos são dados de apresentação e devem ser escapados pela UI. O horário pertence somente a esse envelope.
- `catalogFor({brand,query})` e `catalogUIFor({brand,query})`, no módulo `.cjs`, fazem uma consulta parametrizada usando a conexão confiável recebida. Não autenticam um cliente público nem concedem permissões.

As duas funções são `SECURITY INVOKER`, sem execução concedida a `PUBLIC`. A instalação é uma única transação implícita, recusa colisões e exige o schema do candidato e as tabelas nativas existentes. Credencial e concessões da ponte são uma etapa separada; este arquivo não as escolhe.

## Fontes e limites

`cart.abandoned` pode ser escolhido quando há uma jornada de carrinho publicada e pronta no cadastro legado da mesma marca. Essa evidência comprova a configuração existente, não a completude ou o frescor dos eventos. `purchase.confirmed` e `contact.email_allowed` permanecem indisponíveis para condições até terem fonte confiável ligada ao executor.

Os e-mails vêm de `templates` com tipo `tx` e associação exclusiva à marca em `shrigma_template_email_registry`. Templates sem associação, associados a outra marca, wrappers de campanha e clones reservados são excluídos. Acima de 64 opções a leitura falha, sem truncamento silencioso. A fonte nativa é somente lida; conteúdo, destinatários e contatos não entram no catálogo.

`snapshot_<hash>` identifica o conteúdo consultado (`type`, `subject`, `body` e `body_source`), independentemente do nome e do relógio. Não é uma versão imutável instalada no emissor nem prova de cache. `required_fields: []` significa que este recorte ainda não vinculou as variáveis do template à fonte; não comprova ausência de requisitos. O envelope declara `template_variables_bound: false` e `immutable_release: false` explicitamente.

`available` significa **selecionável para planejamento**. A ponte deve continuar restrita a rascunhos: `draft_only: true`; `publish`, `runtime`, `transport` e `source_complete` são sempre `false`. Antes de qualquer ativação serão necessários fonte completa, consentimento atual, versão imutável da mensagem, vínculo das variáveis e participação no mecanismo de exclusão/recibo legado para impedir envios duplicados. Nenhuma dessas etapas é contornada por este catálogo.

## Provas locais

`tests/journey-graph-catalog.test.cjs`: seis testes em PGlite cobrem duas marcas, registro ambíguo, exclusão de templates indevidos, estabilidade do catálogo, mudança do conteúdo, fonte ausente, condições indisponíveis, limite sem truncamento, instalação/colisão/privilégios e rejeição de respostas incompatíveis pelo adaptador. Não são prova de instalação, concorrência da ponte ou envio real.
