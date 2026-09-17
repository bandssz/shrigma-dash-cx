# NPS Olivas do Campo — 17/09/2026

Implantados: templates Listmonk 108 (pesquisa) e 109 (lembrete), lista ClickUp 901329094236, jornada `olivas:nps-d0` habilitada, workflow inicial `BMaW3HkeCfksFyNg` e lembrete `hDUseQgvC6BrbH8h` ativos. A criação/ativação do Shopify Flow na loja ainda depende de acesso ao admin; houve bloqueio de verificação de conexão. Não houve disparo a clientes nem carga retroativa nesta implantação.

O Shopify Flow deve avisar o endpoint `/webhook/olivas-nps-send` sete dias após a entrega confirmada. O corpo exige chave privada, brand=olivas, email, order_number e first_name opcional. Configuração privada é fornecida fora do repositório. Não confundir pedido atendido/expedido com entrega ao cliente.

A landing publicada na Shopify é `https://olivasdocampo.com.br/pages/avaliar` (página 137844293721); a configuração LP usada pela pesquisa e pelo lembrete aponta para ela. A rota `/webhook/olivas-nps` continua disponível para links antigos; votos e comentários usam endpoints próprios com assinatura da marca. A nota é salva antes do ClickUp. Comentários aguardando a sincronização da nota são processados a cada minuto; resultados externos incertos não são repetidos automaticamente. O lembrete verifica elegíveis diariamente às 19h de Brasília, após 3 dias sem resposta, 1 contato por vez. Só envia a assinantes habilitados e confirmados nas listas 40–43, com reserva por pedido/etapa, pausa da jornada e intervalo de 45 dias.

Atributos `nps_olivas` e `nps_sent_olivas` preservam as outras marcas. A view `shrigma_nps_reporting` agrega ambos os contratos; a consulta NPS e as categorias na API de CX foram conectadas à view. O editor permite listar os templates Olivas e controlar a jornada; criação livre de novos templates Olivas continua fora deste incremento.

A aceitação do Listmonk é registrada no outbox. SES por marca ainda não está instrumentado para Olivas: aceitação não comprova entrega. Não foram inseridos cabeçalhos de Configuration Set sem configuração confirmada.

Validação: testes SQL de Olivas e regressão NPS Fish/Aristo em transação com rollback; 272 testes locais aprovados; endpoints nativos verificaram pausa, assinante inexistente, rejeição de assinatura inválida e HTML da landing. Nenhum teste disparou a clientes. Falta conferir um pedido real após a ativação do Flow.

Página conferida em navegador: estado de link ausente sem registrar voto, endpoints absolutos mantidos, popup comercial oculto apenas nesta página e rolagem preservada. Escopos read_content/write_content confirmados no app Shrigma CX - Olivas. Flow D+7 ainda depende de acesso ao admin, preso em verificação de conexão.
