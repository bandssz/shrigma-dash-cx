# PIX nativo e contrato de templates

Diretriz de produto e aprendizado oficial: [Meta API/MCP e Detalhes do pedido](meta-whatsapp-api-mcp.md). Em 18/09, Felipe reafirmou o card nativo como padrão e solicitou preservar esse conhecimento no projeto. O detalhamento foi ativado na Fishermans em 18/09 conforme registro ao final; Aristo ainda usa o item agregado, que não é uma lista de produtos.

O provedor das marcas é Appmax. O destino bancário é obtido do código original de cada cobrança; não existe banco fixo por marca. A consulta aceita apenas endereços bancários observados e explicitamente permitidos, via HTTPS com validação de certificado e sem redirecionamento. Um endereço novo exige revisão, nunca tentativa arbitrária de acesso.

`whatsapp-pix-card.js` confere TLV/CRC do código, moeda, valor em centavos, situação ativa e validade comparada com a fonte. O código de pagamento não é gerado nem reescrito. A chave exibida vem da cobrança, não do CNPJ da marca. Cobranças pagas, divergentes ou próximas do vencimento são recusadas. Quando não existe detalhamento monetário confiável de produtos, o cartão representa o total como um item identificado pelo pedido, sem inventar produtos ou preços.

O HTTP Request nativo do n8n faz a leitura. Com resposta de texto e resposta completa, o n8n retorna o conteúdo em `data`; a adaptação também aceita `body`. Os bancos podem devolver JSON ou JWS. O JWS vem exclusivamente do endereço autorizado obtido do código, através de HTTPS autenticado; não se afirma verificação criptográfica independente da assinatura, não se aceita JWS vindo do cliente e não se acessa o URL do cabeçalho. Celcoin observada com PS512 e BB com RS512. Nenhum módulo bloqueado do executor é habilitado ou contornado.

A mensagem usa um template UTILITY aprovado com `display_format: ORDER_DETAILS` na criação e botão `ORDER_DETAILS`. No envio, o componente é `button`, `sub_type: order_details`, parâmetro `action.order_details`. Não usar botão de cupom, URL de pagamento como substituto silencioso ou código no corpo. Cabeçalho e corpo têm parâmetros distintos.

`whatsapp-template-contract.js` é compartilhado pelo criador, validação remota e motor. O backend bloqueia formatos PIX incompatíveis. O motor consulta a identidade/aprovação/categoria/componentes atuais antes da reserva e verifica o payload completo. A jornada também exige o botão nativo, além de compatibilidade da assinatura. Trocas de template precisam ser publicadas junto com o adaptador de dados; alterar só o ID não transforma os componentes.

Aristo mantém toque de três minutos e ao menos 90 segundos restantes. Fishermans mantém toque de 15 minutos e ao menos dois minutos restantes. Opt-out, pagamento, cancelamento, telefone, cadência e deduplicação permanecem nas rotas. A versão histórica de PIX vencido não é reativada. Cobranças não verificáveis ficam sem envio e podem ser reconsultadas enquanto elegíveis; não existe fallback para o código no texto.

Validação inclui cenários sintéticos e reprodução local de respostas reais, sem enviar a clientes ou efetuar pagamentos. Aceite da Meta, entrega de WhatsApp e pagamento são evidências diferentes. Uma execução sem candidatos não comprova entrega.

Fontes: [template de cobrança Meta](https://developers.facebook.com/documentation/business-messaging/whatsapp/payments/payments-br/orderdetailstemplate/), [PIX externo Meta](https://developers.facebook.com/documentation/business-messaging/whatsapp/payments/payments-br/offsite-pix).

### Validação com destinatários em 17/09

A verificação Meta da Aristo ainda consultava o ID do cartão anterior; a guarda bloqueava corretamente a divergência, impedindo o novo envio. Corrigida a URL do nó `Confere template PIX v2 na Meta` para usar `$('Config').first().json.template_id`. ID, nome, idioma, categoria, aprovação e botão continuam conferidos. Depois da correção, o template compacto 1132506052775113 teve aceite e entrega reais confirmados. O compacto Fishermans 1378177134340410 também teve entrega real.

Instrumentação adicional: emissores preservam `_pix_expires_at` no payload interno e o motor registra impressão do código/valor/validade na mesma reserva, seguido de recibo de aceite. Campo interno não é enviado à Meta. Ver `pix-charge-evidence.sql`.

### Detalhamento de produtos — Fishermans ativada em 18/09

`makePixCard` agora aceita `shopify_order` opcional. `pixShopifyOrder` confere a identidade do pedido, moeda BRL, situação pendente, lista completa, quantidades atuais, preços originais, descontos alocados, frete e tributos. Só usa produtos reais quando `subtotal + frete + tributos - descontos` coincide, em centavos, com o total já conferido da cobrança. Campos requeridos em [whatsapp-pix-shopify.graphql](whatsapp-pix-shopify.graphql).

Lista parcial, mais de 30 linhas, nomes acima de 60 caracteres, itens removidos, dados monetários ausentes, tributos embutidos não alocados ou divergência preservam o card agregado. A função retorna o motivo técnico sem dados pessoais. Não ajustar valores para forçar conciliação. O código Appmax, validade, chave e guardas de pagamento continuam obrigatórios.

**Validação da fonte em 18/09:** depois de um timeout inicial no n8n, uma nova leitura autenticada Shopify retornou cinco pedidos pendentes; os cinco conciliaram os itens com seus totais. Os dois fluxos temporários foram excluídos (HTTP 200). A proposta Fishermans altera apenas duas consultas e a montagem final do card, mantendo conexões e reservas. A publicação operacional requer leitura posterior de `activeVersionId`, não apenas aceite de PUT. Aristo exige primeiro o vínculo seguro entre o evento Appmax e os itens Shopify: amostras anteriores da Appmax trazem produtos vazios ou genéricos a preço zero.

Validação local: 22 testes de card, evidência da cobrança e métricas PIX aprovados. Os três nós propostos da Fishermans compilam. Isso não comprova entrega de um card enriquecido a cliente.

Referências complementares: [Shopify LineItem](https://shopify.dev/docs/api/admin-graphql/latest/objects/LineItem), [Shopify Order](https://shopify.dev/docs/api/admin-graphql/latest/objects/Order), [contrato de pagamentos brasileiros da CM.com](https://developers.cm.com/messaging/docs/payments-brazil). A CM.com documenta seu transporte e a composição de valores do card; não substitui comprovação de elegibilidade das nossas WABAs. A leitura integral atual da referência Meta continuou limitada.

**Publicação operacional confirmada às 11h42 BRT:** workflow Fishermans `hUfSmwy6mfPguZFP`, versão `8eb4a96d-1ab1-47de-ad84-8708ba12bbc8`. GET posterior confirmou conteúdo, `active=true` e `activeVersionId` igual à versão publicada. Guardas, conexões, reservas, template e evidência da cobrança foram preservados. A primeira entrega natural com produtos ainda precisa ser comprovada; consultas de pedidos não são envios. Aristo continua com card agregado até vincular com segurança os itens Shopify à cobrança Appmax.

**Saúde operacional observada às 11h43 BRT:** a execução Fishermans `1282076`, anterior à publicação (início 10h55 BRT), falhou em `Seleciona candidatos PIX` com `Timeout waiting for lock SqliteWriteConnectionMutex to become available`. A listagem também trouxe execuções em estado `new`, ainda sem início. Isso exige diagnóstico da infraestrutura n8n/SQLite; não atribuir essa falha prévia ao novo card nem afirmar que a entrega está funcionando a partir de `active=true`. Não houve reinício ou alteração de infraestrutura nesta rodada.
