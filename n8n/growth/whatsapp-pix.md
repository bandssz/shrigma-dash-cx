# PIX nativo e contrato de templates

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
