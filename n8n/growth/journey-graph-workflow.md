# Ponte HTTP de rascunhos — candidata

O gerador cria **outro workflow exclusivo Growth**, com caminho e referência PostgreSQL fornecidos pelo instalador. Não altera login, CX, workflows de jornadas atuais ou transportes. O payload não ativa o workflow. Gravações usam uma chamada PostgreSQL por transação; validação chama o mesmo `JourneyGraphContract` do editor, sem `require` no sandbox.

O anúncio futuro é `api.capabilities.journeys.graph_drafts = 'journey_graph_draft_api_v1'`, com endereço em `api.capabilities.endpoints.journey_graph`. Não anunciar antes da instalação e conferência. `GET capabilities` exige a mesma autenticação de leitura e responde `features:{drafts:true,simulation:true,publish:false,runtime:false}`, `simulation_mode:'local'`. Simular usa o contrato puro no navegador, sem persistência ou envio. Catálogo selecionável para planejamento não comprova fonte completa, ligação de variáveis ou release imutável de execução.

## Contrato

Somente um header `Authorization: Bearer …`; nunca chave em query/body. Marca obrigatória Fish/Aristo. CORS restrito à origem existente do painel; respostas `no-store`; retenção n8n de sucesso, erro e progresso desabilitada. Validação limita JSON a 196.608 bytes, profundidade24 e20mil valores após o parsing do webhook; não é uma configuração de limite anterior ao parser da infraestrutura.

| Método | action | Campos além de action/brand |
|---|---|---|
| GET | capabilities, catalog | nenhum |
| GET | list | after opcional vazio/null; limit opcional1–50, padrão25 |
| GET | get | journey_id |
| GET | operation | request_id |
| POST | create | request_id, definition |
| POST | save | request_id, journey_id, expected_version, definition |

Ator, catálogo, prova, publicação e ativação não são campos do operador. A função vigente `shrigma_panel_operator_v1(token,'growth')` fornece autoria e caps: `read_content` para leitura, `draft` para escrita. Ela não oferece ACL por marca/autor da jornada; gestores Growth colaboram em Fish/Aristo. Recibos só são recuperados por sua autoria e marca originais.

Criar/salvar retorna `{state:'succeeded',actor,request_id,request_payload,receipt}` com contrato `journey_graph_draft_api_v1`, `authorizes_publish:false` e `authorizes_send:false`. O banco gera journey_id/revisão e conserva o recibo `journey_graph_store_v1`. GET operation retorna a mesma identificação, ação, payload exato e recibo histórico, reconstruído da revisão imutável e conferido contra os hashes existentes. Ator é identidade interna de journal, não chave nem texto de UI. GET get traz server/definition e catálogo atual separado; list traz journeys/next_cursor.

## Atomicidade e resposta perdida

`workflow_commit_v1` reautentica após o advisory lock da operação, inclusive replay; confere actor, hash, marca e CAS. Catálogo validado no Code é comparado novamente dentro da transação; SQL deriva hashes da representação canônica produzida pelo servidor e confere seu conteúdo JSON. A função não é uma API SQL pública: permissões PUBLIC revogadas; `proof` só pode vir do módulo servidor confiável, nunca do request HTTP. Sem alteração das tabelas/ledger/core originais.

Sem confirmação de commit, retorna202/unconfirmed com a identidade original. GET operation ausente também retorna202, actor e `retry_same_request_only:true`. Cliente conserva endpoint/ator/payload/UUID antes do POST; consulta e eventual repetição explícita preservam todos eles. Nunca interpretar ausência como falha confirmada nem criar UUID novo. Versões posteriores não alteram recibos anteriores.

## Instalação e limites

Dependências: schema candidato original, helper gestor já existente e funções read-only `catalog_v1`/`catalog_ui_v1`. A extensão SQL é transacional/reaplicável e não concede acesso a papéis, instala fontes ou muda `control.enabled=false`. Instalador deve verificar objetos e referências antes de aplicar. Nenhum endpoint foi criado nem teste enviado nesta implementação.

Fixtures locais cobrem isolamento, CAS, replay, recuperação histórica/payload, catálogo/revogação entre etapas, compatibilidade com API Node original e reaplicação. CI PostgreSQL17.10 acrescenta sessões concorrentes, reautorização após espera e recuperação; resultado real depende de seu job. Publicar, ativar, consumir fontes/intenções, mapear variáveis e transportar mensagens continuam fora desta ponte.
