# Issues do CRM

- **Data:** 19/10/2026.
- **Tela:** Campanhas → 2. O quê.
- **Relato:** O aviso de links impedia salvar “Email Captação 01 - Black 30/10”.
- **Causa:** Uma identificação diferente nos links era tratada como erro.
- **Correção + hash:** Salvar com aviso e ajustar os links pelo botão. `5e8fbe50e08b88cc5f413732cd6f46a1c60eba65`.

- **Data:** 20/10/2026.
- **Tela:** Fish → Campanhas → Agendar.
- **Relato:** A fatia Contato não aparece para agendar; só Avisos.
- **Causa:** Felipe definiu Contato reservado; falta confirmar a indisponibilidade na conta do editor.
- **Correção + hash:** Avisos padrão e Contato com aviso/confirmar em branch; instalação não confirmada. `209c87ae6d223238f194baac411b14ca6ceea7de`.

- **Data:** 20/10/2026.
- **Tela:** Fish → Modelos → Teste interno.
- **Relato:** O sistema impede personalizar a peça com o nome do cliente.
- **Causa:** O importador recusa os campos nativos de primeiro nome e sobrenome.
- **Correção + hash:** Campos aceitos em branch; instalação e teste pelo editor ainda pendentes. `209c87ae6d223238f194baac411b14ca6ceea7de`.
