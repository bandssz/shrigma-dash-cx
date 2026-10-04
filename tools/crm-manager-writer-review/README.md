# Identidade individual de edição CRM — proposta inativa

Este componente prepara identidade separada para salvar, conferir, agendar e cancelar campanhas. Ele não instala, emite, publica ou ativa acessos. O provisionamento de leitura e suas três capacidades permanecem separados e intactos.

As fontes SQL propõem quatro tabelas, dois índices, sete funções e dois papéis NOLOGIN sem senha. O candidato de escrita permanece inativo até o commit. A promoção de uma renovação revoga somente sua geração anterior; a revogação registra o lifecycle e impede promoção posterior. Bearer não faz parte do protocolo SQL: são aceitos somente seu digest e o principal exclusivo `dcrmw-`.

A reversão é permitida somente no estado vazio, com fingerprint fixo, sem logins, senhas, dependências ou consumidores. Ela usa RESTRICT. A limpeza de dados sintéticos nos testes não é uma estratégia de reversão de produção.

Os testes locais usam apenas banco descartável. A pasta `native` prepara PostgreSQL17 em CI Linux, com destino, autenticação e recursos próprios da fixture. Um resultado verde não autoriza SQL real. A admissão final do banco atual, credencial privada, emissor, integração do portal e aprovação explícita continuam pendentes. Não há arquivo de ambiente, credencial ou plano preenchido neste pacote.
