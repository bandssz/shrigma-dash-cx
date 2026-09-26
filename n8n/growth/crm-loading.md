# CRM-27 — consultas de jornadas somente ao abrir a seção

O CRM consultava jornadas e seus templates durante a abertura do Início. Agora a primeira consulta ocorre ao abrir Automações → Jornadas, inclusive por link direto. A atualização visual de 30 segundos acompanha somente a seção ativa. A leitura geral dos dados a cada 60 segundos permanece igual.

O editor mantém o mesmo estado, contexto, rascunho e registro de tentativas. Sair e voltar durante uma leitura não cria outra consulta; depois de carregado, reabrir reutiliza a leitura existente. Atualizar continua disponível. Pendências continuam impedindo troca de marca e novas ações incompatíveis, mesmo antes de abrir Jornadas.

Prova local com requisições interceptadas: Início = zero consultas de jornadas/templates; primeira abertura = uma consulta de jornadas; reentrada durante e depois da resposta = zero consultas adicionais. Testes cobrem links diretos, troca Fish/Aristo, edição não salva, pendência durável e atualização de seções visíveis.

Na investigação por API de 26/09/2026, o login respondeu em 0,32 s e o cache com gzip em 0,80 s. Essas medições ocorreram depois da demora relatada. O ajuste elimina trabalho desnecessário comprovado, mas não demonstra a causa daquele episódio nem promete um tempo fixo de abertura. O restante da montagem de seções ainda pode ser otimizado após medição específica.

Sem migração, mudança de autenticação, backend, envio ou intervenção em outros painéis. Publicação por PR/CI; reversão pela PR anterior. A conferência da publicação usa arquivos públicos e APIs, conforme preferência do dono.
