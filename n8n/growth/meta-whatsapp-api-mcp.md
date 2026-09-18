# Meta: API, MCP e Detalhes do pedido

Revisão: 18/09/2026. Decisão de produto de Felipe registrada nesta data.

Atualização de execução: documentação incorporada à main pelo PR #12 (`de3fc99`). Enriquecimento opcional por itens Shopify implementado e testado no código; [estado da implantação](whatsapp-pix.md#detalhamento-de-produtos-preparado-em-1809). Não confundir código preparado com alteração dos envios em produção.

## Decisão para a operação

Usar **Detalhes do pedido (`ORDER_DETAILS`) como padrão de cobrança PIX** das marcas. A experiência desejada é um card nativo, com identificação do pedido, produtos/quantidades quando confiáveis, total, texto curto e ação nativa para copiar o PIX. Appmax é o provedor de pagamento de todas as marcas. MCP é uma ferramenta de operação da Meta; não altera o provedor da cobrança.

Para pagamento aprovado, expedição e entrega, priorizar a ação útil daquela etapa: consultar o pedido específico ou abrir o rastreamento preenchido. Não presumir que um template de cobrança pendente serve para qualquer evento pós-pagamento. A adoção de `ORDER_STATUS`/`RICH_ORDER_STATUS` requer comprovação de suporte brasileiro e elegibilidade das contas; a presença desses nomes no SDK não basta.

## MCP oficial: conhecimento confirmado e acesso real

Há dois recursos oficiais relevantes:

| Recurso | Aplicação neste projeto | Evidência consultada |
|---|---|---|
| WhatsApp Business Tools MCP | Operar configuração de WhatsApp, contas, números e templates, incluindo testes suportados pelas ferramentas conectadas. | Anúncio oficial de 15/09/2026 e documentação oficial indexada. |
| Meta Social Technologies MCP | Descobrir endpoints Graph, consultar documentação e diagnosticar erros da integração. | Anúncio oficial e documentação oficial indexada; nome anterior: Developer Tools MCP. |

A documentação do **WhatsApp Business Tools MCP** identifica o servidor remoto `https://mcp.facebook.com/whatsapp_business_tools` e autenticação **OAuth** com a conta de desenvolvedor Meta. Não armazenar tokens ou App Secret nesta documentação ou em configurações versionadas.

**Estado em 18/09:** existência e endereço confirmados; conector não conectado nesta sessão. A busca no diretório disponível por WhatsApp não retornou o conector oficial. Isso não significa que o serviço não exista. Não houve autenticação, enumeração de ferramentas ou execução via esse MCP. Não substituir por plugin de terceiros com nome semelhante.

Procedimento quando o cliente disponibilizar conexão ao servidor oficial:

1. Concluir o OAuth da Meta e conferir os ativos e permissões concedidos.
2. Enumerar as ferramentas reais, seus esquemas e limites. Não inventar nomes de ferramentas a partir do material de lançamento.
3. Confirmar app, portfólio, WABA e número de cada marca com consultas de leitura antes de alterar recursos.
4. Usar consultas e gestão de templates compatíveis com as ferramentas expostas. Preservar a autorização operacional já recebida, as reservas e a auditoria do projeto.
5. Conferir o resultado por leitura após uma escrita. Resposta HTTP de sucesso não prova que o estado desejado foi aplicado.

**Decisão de arquitetura do projeto:** manter Cloud API + n8n + banco como motor de produção, com idempotência, opt-out, guardas de pagamento e recibos. Usar MCP para assistência técnica e operações suportadas. O anúncio de um conector não demonstra paridade com todas as operações da API nem capacidade de substituir nosso motor.

## O que já existe no código e na operação

Esta revisão leu o código em `d89cc07`; não executou novo disparo ou leitura de entrega em produção. A entrega real dos cards Aristo e Fishermans foi comprovada na revisão de 17/09, registrada em [whatsapp-pix.md](whatsapp-pix.md).

| Camada | Contrato atual |
|---|---|
| Criação na Meta | Categoria UTILITY, `display_format: ORDER_DETAILS`, botão `ORDER_DETAILS`. |
| Envio | Componente `button`, `sub_type: order_details`, parâmetro `action.order_details`. |
| PIX brasileiro | `payment_type: br`, moeda BRL e `payment_settings` com `pix_dynamic_code`. |
| Fonte da cobrança | Código original Appmax; valor, validade e chave conferidos com a cobrança. Banco não é fixo por marca. |
| Conteúdo do card | Hoje existe **um item agregado pelo total do pedido**, com quantidade 1. Não representa a quantidade real de produtos. |
| Proteção do editor e motor | `whatsapp-template-contract.js` compartilhado; PIX exige botão nativo e assinatura compatível. |

O modelo escolhido já é a base do PIX. A melhoria pendente é enriquecer os detalhes, sem tratar o item agregado como lista real de produtos. Não reintroduzir código PIX no corpo nem usar botão de cupom `COPY_CODE` como equivalente ao pagamento.

Arquivos de implementação:

- [whatsapp-pix-card.js](whatsapp-pix-card.js): cobrança, valores e montagem do componente.
- [whatsapp-pix.md](whatsapp-pix.md): fontes bancárias, validade, envio e evidência histórica.
- [whatsapp-template-contract.js](../../whatsapp-template-contract.js): contrato compartilhado com o criador e o motor.

## Evolução concreta e critérios de aceite

### Card com produtos reais

Pendência de implementação: obter itens, quantidades, preços e ajustes da fonte confiável do pedido, vinculada à cobrança Appmax correta. Conciliar em centavos o total de produtos, descontos, frete, tributos e demais ajustes com o total da cobrança, conforme o contrato brasileiro documentado. Não adivinhar alocação de descontos nem inventar campos da API.

Enquanto não houver detalhamento conciliado, manter o item agregado identificado pelo pedido. Na prévia do editor, rotular dados ilustrativos e distinguir o resumo agregado dos produtos reais. A prévia deve vir do mesmo contrato de componentes usado no envio; o WhatsApp controla a renderização final.

Ponto de auditoria identificado: o adaptador atual usa `type: digital-goods`, embora a operação venda produtos físicos. Confirmar os valores aceitos e a semântica exigida pela API brasileira antes de mudar esse campo; não assumir que o literal indica erro nem alterá-lo sem contrato verificado.

Aceite da evolução: totais conciliados, PIX original preservado, cobrança ativa, template aprovado, prévia coerente, payload aceito e entrega comprovada. Cobrança paga/cancelada/vencida e divergência monetária continuam bloqueadas. Alterar template e adaptador de forma coordenada.

### Pedido e rastreio após pagamento

Prioridade de jornada: `Acompanhar pedido` deve chegar ao pedido específico quando a Shopify disponibilizar `Order.statusPageUrl`; rastreio deve abrir a transportadora com código preenchido quando disponível. Preservar autenticação exigida pelo destino. Não construir links de pedido por adivinhação.

Estado anterior registrado: links gerais ainda abrem as contas das marcas; templates de transportadora usam URL dinâmica. Esta rodada documenta a evolução, não publica novos destinos. Não oferecer ação de pagamento para pedido já pago.

### Cliques e atribuição

MCP não cria telemetria inexistente. Não declarar clique individual no botão nativo de copiar PIX sem documentação e prova de cobertura desse evento. `CLICKED` genérico e clique em cupom não comprovam cópia de PIX.

Na revisão operacional anterior, `is_enabled_for_insights` permaneceu falso nas duas WABAs após tentativas com resposta HTTP 200, e analytics continuou indisponível. Portanto, Insights e medição de cópia permanecem pendentes; não registrar como habilitados.

Separar no dashboard: aceite, entrega, leitura, clique URL, eventual cópia nativa comprovada, pagamento posterior, pagamento da cobrança original e efeito incremental. Pagamento depois do aviso é associação temporal, não prova causal. Links de rastreio e suporte após pagamento não devem receber crédito de recuperação dessa mesma compra. A/B exige variantes atribuídas de forma estável e grupo de controle para medir incremento.

## Fontes oficiais e limites desta revisão

| Fonte | O que sustenta / limite |
|---|---|
| [Anúncio WhatsApp Business Tools MCP](https://developers.facebook.com/blog/post/2026/09/15/whatsapp-business-messaging-mcp-ai-agent/) e [índice oficial](https://developers.meta.com/blog/) | Existência do MCP e exemplos de contas, números, templates e testes. Índice lido; artigo integral indisponível nesta consulta. |
| [Documentação WhatsApp Business Tools MCP](https://developers.facebook.com/documentation/mcp/whatsapp-business-tools-mcp) | Trechos oficiais indexados confirmam servidor remoto, URL e OAuth. Página integral indisponível nesta consulta. |
| [Meta Social Technologies MCP](https://developers.facebook.com/documentation/mcp/devtools-mcp) e [anúncio](https://developers.facebook.com/blog/post/2026/06/30/developer-tools-mcp/) | Descoberta de APIs, documentação e diagnóstico. Trechos oficiais indexados; não foi inspecionado o esquema vivo das ferramentas. |
| [Detalhes do pedido — Brasil](https://developers.facebook.com/documentation/business-messaging/whatsapp/payments/payments-br/orderdetailstemplate/) | Referência brasileira existente no projeto; índice indica atualização em 02/09/2026. A leitura integral atual retornou erro/limitação. Não se afirma revisão completa do novo contrato. |
| [PIX externo — Brasil](https://developers.facebook.com/documentation/business-messaging/whatsapp/payments/payments-br/offsite-pix) | Referência já utilizada na implementação; leitura integral atual indisponível. Não transpor documentação indiana para o Brasil. |
| [SDK oficial — WhatsAppBusinessAccount](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/whatsappbusinessaccount.py) | Campos/enums, incluindo Insights e formatos. Existência de enum não prova elegibilidade da conta nem aplicação efetiva de escrita. |
| [Shopify Order.statusPageUrl](https://shopify.dev/docs/api/admin-graphql/latest/objects/Order#field-Order.fields.statusPageUrl) | Destino específico de status do pedido; permissão e URL devem ser confirmadas por loja/pedido. |

Este registro distingue decisão do usuário, observação do código, evidência histórica e documentação recuperada. Não é uma cópia integral das docs. Antes de ampliar o payload ou ativar capacidades novas, consultar o contrato oficial vigente e registrar a prova operacional correspondente.
