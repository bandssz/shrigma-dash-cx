# Editor de fluxos e templates

O Growth oferece edição operacional em **Automações → Fluxos**, com criação em **Criar templates**.

Escopo inicial: Fishermans e O Aristocrata. São 20 jornadas e 46 etapas, incluindo variantes de WhatsApp e e-mail. Polpa está em pausa; Olivas será replicada depois.

- Carrinho: duas posições de WhatsApp com variantes A/B e cinco de e-mail.
- Pedido: recebido, pagamento aprovado, preparação, em rota, entregue e cancelado.
- Rastreio: escolha condicional conforme transportadora e dados disponíveis.
- PIX ainda válido e resposta automática de atendimento.

O rascunho fica separado da versão publicada. Salvar não muda envios. Publicar afeta os próximos eventos elegíveis. Pausar também é uma ação explícita, com chave de publicação. Versão esperada e idempotência impedem sobrescrita concorrente e repetição de uma solicitação incerta.

O editor permite adicionar/remover as etapas conectadas a cada gatilho, escolher templates compatíveis, editar a mensagem de atendimento e ajustar esperas dentro das janelas suportadas. As variantes A/B compartilham a espera. O canvas tem navegação livre, zoom de 15% a 200%, blocos arrastáveis, conexões, minimapa, enquadramento, organização automática e tela cheia. Clique em um bloco para editar no painel lateral. O desenho é salvo no rascunho e publicado junto com a definição; mover um bloco não altera horário nem roteamento. Variantes e transportadoras aparecem como alternativas. As conexões são derivadas das rotas executáveis existentes.

Templates WhatsApp são submetidos à Meta. Templates de e-mail são criados no Listmonk como transacionais, sem disparo. O corpo aceita texto ou HTML e variáveis `{{ .Tx.Data.campo }}` dos dados disponíveis na etapa. A prévia HTML usa iframe sem permissões e CSP restritiva.

Ainda fora deste editor: NPS, popups, campanhas, novos tipos de gatilho e ramificações arbitrárias. Os controles existentes de compra, expiração de PIX, descadastro, janela WhatsApp e deduplicação continuam na execução. O convite VIP desodorante após NPS permanece desativado.

Validação: testes de interface/contratos, fixtures SQL com rollback e publicação via API do mesmo conteúdo de uma jornada existente. Sem mensagens artificiais a clientes. Em 14/09, a revisão visual em Chromium foi concluída em desktop e celular. A navegação, zoom, arraste, minimapa, tela cheia, edição, remoção/adição, atualização e persistência foram exercitados com API isolada. A API real confirmou salvar, recarregar e publicar metadados de posição em uma jornada existente, sem modificar suas etapas nem disparar mensagens.
