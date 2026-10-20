# Issues do CRM

- **Data:** 19/10/2026.
- **Tela:** Campanhas → 2. O quê.
- **Relato:** O aviso de links impedia salvar “Email Captação 01 - Black 30/10”.
- **Causa:** Uma identificação diferente nos links era tratada como erro.
- **Correção + hash:** Salvar com aviso e ajustar os links pelo botão. `5e8fbe50e08b88cc5f413732cd6f46a1c60eba65`.

- **Data:** 20/10/2026.
- **Tela:** Fish → Campanhas → Agendar.
- **Relato:** A fatia Contato não aparece para agendar; só Avisos.
- **Causa:** Felipe confirmou Contato reservado; falta reproduzir a indisponibilidade como editor.
- **Correção + hash:** Regra com aviso e confirmação em branch, não instalada; teto intocado. `084805fb57aa00782a75c20d8fbe5e976ff6ef7e`.

- **Data:** 20/10/2026.
- **Tela:** Fish → Modelos → Teste interno.
- **Relato:** O sistema impede personalizar a peça com o nome do cliente.
- **Causa:** O importador recusa os campos nativos de primeiro nome e sobrenome.
- **Correção + hash:** Campos aceitos em branch; não instalado porque o CI recusou o pacote anterior. `084805fb57aa00782a75c20d8fbe5e976ff6ef7e`.
