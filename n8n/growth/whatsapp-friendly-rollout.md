# Revisão de WhatsApp — 17/09/2026

Os 22 templates selecionados pelas jornadas Aristo/Fishermans foram substituídos pelas versões revisadas e aprovadas: oito carrinhos, dois pedidos pagos, dez rastreios e dois PIX. Autorespostas das duas marcas também receberam texto mais claro. Appmax é o provedor de pagamento de todas as marcas.

Carrinho, pedido pago e rastreio apresentam dois botões URL: ação principal e atendimento. PIX usa ORDER_DETAILS com código original validado, sem código EMV extenso no texto. O catálogo histórico foi preservado. A revisão não torna templates legados fora de uso automaticamente elegíveis.

Criador e runtime compartilham validações de formato, aprovação, identidade, variáveis e botões. URL de ação é obrigatória; HTTPS válido e placeholders de URL são verificados. Cabeçalho de texto recusa formatação/emoji/quebra de linha. Orientações de clareza e afirmações comerciais aparecem como avisos.

A migração de cabeçalhos de imagem para texto restringe-se aos dois pares Fish explicitamente revisados, preservando os parâmetros de corpo e botões. Os demais templates seguem validação estrita.

Dez versões inicialmente pendentes foram ativadas pela função whatsapp-approved-rollout.sql após aprovação real. A função bloqueia edição concorrente da jornada ou divergência do conteúdo aprovado, preserva histórico e evita reativação. A fila contém somente IDs autorizados nesta revisão. O worker 2NCSYhGmP3kEQUPd completou os dez itens; foi desativado ao terminar. Não é um aprovador genérico para templates futuros.

Validação: 285 testes locais aprovados no PR #7; 20 contratos reais de produtores compatíveis; teste SQL de pendência, aprovação e repetição com rollback. Os estados de aprovação, seleção e habilitação foram relidos. Aceitação e entrega ao destinatário permanecem provas distintas; nenhum teste enviou mensagem a cliente.
