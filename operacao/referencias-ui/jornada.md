# Como montar e conferir uma jornada antes de pedir sua ativação?

**Klaviyo.** A criação parte da biblioteca ou do zero, passa por nome, gatilho/filtros e ações/esperas/ramificações. Draft, Manual e Live são estados por ação; Manual participa do fluxo e não equivale a um teste isolado. A prévia do desenho e o teste da mensagem são conferências diferentes. [Criar flows e estados](https://help.klaviyo.com/hc/en-us/articles/115002774932), [prévia/teste das mensagens](https://help.klaviyo.com/hc/en-us/articles/115002774972).

**HubSpot.** Gatilho, reinscrição/saída, ações, configurações e revisão/publicação aparecem separados. A simulação mostra caminhos e horários sem executar ações reais; a contagem da revisão de ativação é estimada. Permissão de editar não implica publicar. [Criar workflows](https://knowledge.hubspot.com/workflows/create-workflows), [simulação](https://knowledge.hubspot.com/workflows/test-your-workflow).

**Shopify / Polaris.** Salvar/descartar acompanha o estado de edição; falha de persistência conserva valores e erro. O indicador de alterações não desaparece antes da confirmação do servidor. Esse padrão orienta o editor, sem fornecer o motor da jornada ou autorizar ativação. [Save Bar](https://shopify.dev/docs/apps/build/app-home/migrate-from-polaris-react/contextual-save-bar).

**Aplicação no Shrigma.** Prévia somente: biblioteca/começar do zero, nome e entrada, sequência visual das etapas, prévia da peça e Teste interno na própria caixa. Preservar os campos e ações reais; um Salvar jornada. Pedido em Gestão permanece separado da ativação comercial bloqueada. Contagem/caminho sem contrato real é —, sem simulação apresentada como execução. MANUAL-UI prevalece.

**Limite documental.** A [prévia do gatilho](https://help.klaviyo.com/hc/en-us/articles/360028374111), o teste de mensagem e a [prévia do perfil](https://help.klaviyo.com/hc/en-us/articles/30325266432539) descrevem capacidades distintas e parcialmente divergentes. Nenhuma delas comprova consentimento nem equivale ao Teste interno do Shrigma.

**Anotação das capturas.** Biblioteca e sequência visual da Klaviyo; separação simulação/ativação da HubSpot; persistência/ação única do Polaris. Duas marcas × 1440/390, QA real, sem iniciar ou alterar jornadas existentes.
