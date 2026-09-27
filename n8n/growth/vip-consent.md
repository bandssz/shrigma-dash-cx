# Consentimento dos cadastros VIP do Aristo

As LPs de Alma da Roça e Desodorante usam a lista VIP 19 e a base Aristo 16. Os dois cadastros reconfirmavam a lista 19 no conflito, incluindo quem já havia se descadastrado. A montagem de boas-vindas ignorava o resultado do banco e voltava ao e-mail do nó anterior.

Esta correção preserva inscrições existentes. O banco só autoriza continuação para assinante `enabled`, sem descadastro ou confirmação pendente em 16/19. A decisão chega como booleano explícito a `Montar boas-vindas`; ausência, erro ou qualquer valor diferente de `true` encerra esse caminho. A regra de origem de Alma permanece: seu formulário normal cadastra e não dispara o e-mail de desodorante. Template, conteúdo, destinatário, transporte e ausência de retry permanecem iguais.

## Contrato

`public.shrigma_crm_vip_subscribe_v1(text,text,boolean,text)` recebe e-mail já normalizado, origem, indicador de correção do endereço e fonte fixa `alma` ou `desodorante`. Retorna uma linha com `eligible` e motivo controlado, sem expor contatos. Usa os vínculos fixos 16/19 e privilégios do chamador; não é `SECURITY DEFINER` e não concede execução a `PUBLIC`.

O SQL é transacional. Serializa por assinante e examina os vínculos na ordem 16,19. Os vínculos usam `NOWAIT`: se o descadastro nativo estiver usando um deles, VIP cede com decisão negativa e desfaz as escritas da tentativa. Isso evita disputar bloqueios em ordem inversa com o bloqueio global nativo. Leituras separadas observam o estado depois de espera ou conflito. Não sobrescreve estado de vínculo. Assinantes bloqueados/desativados e vínculos descadastrados/não confirmados não são reativados, e seus atributos não são modificados.

O patch aceita apenas `NAmTWZ7vddQ8LX1k` e `ywJDsgBDhZOBgoxb`, export publicados sem edição pendente, versão e hashes revisados. Altera somente a consulta do cadastro e o início do código de montagem; preserva conexões, configurações, credenciais e demais nós.

## Teste e implantação

Os testes usam dados sintéticos. PostgreSQL real verifica cadastro novo/existente, os estados de consentimento, preservação de atributos e disputas com descadastro. O teste do patch executa a montagem em VM sem transporte para conferir decisão ausente/falsa/inválida e a regra de origem de Alma.

Antes de instalar, obter export fresco dos dois workflows, metadados das duas tabelas, definição do normalizador de atributos existente e prova de mesma credencial de banco. A função deve estar ausente. No utilitário SQL, compilar a migração por `tools/vip-consent-install.cjs`: um único `DO` implícito executa guarda, DDL e revogação de permissões. Não enviar `BEGIN; ... COMMIT;` ao utilitário; ele não garante limpeza da sessão se uma instrução falhar. O `DO` falho desfaz a instalação e libera a sessão. Conferir definição, dono, permissões e ausência de `SECURITY DEFINER`.

Antes de cada PUT, conferir novamente versão, corpo publicado e função. Usar o serializer do n8n 2.0.2 que preserva `timeSavedMode` no servidor. O PUT pode publicar um workflow ativo; conferir a versão ativa e o corpo completo imediatamente depois. Registrar intent antes de cada escrita; uma resposta incerta exige conciliação por leitura, sem repetir PUT ou migração automaticamente. Não é necessário reiniciar serviço.

Se falhar antes dos PUTs, a função sem chamadores pode ser removida, após conferir sua definição. Após publicar a guarda, restaurar cegamente o SQL anterior reintroduz o defeito: não usar esse rollback. Uma falha no novo cadastro deve impedir o envio; reparar ou pausar especificamente a entrada afetada e preservar os registros. Nunca retirar a guarda de consentimento para recuperar disponibilidade.

## Limites

Esta entrega não adiciona identidade estável, recibo ou deduplicação aos formulários VIP; não altera o ACK antecipado nem o redirecionamento das LPs. Não é prova de ausência de envio repetido. A decisão de consentimento e o HTTP são operações separadas: descadastro posterior à decisão exige o mecanismo de reserva/última conferência do trabalho seguinte; esta correção não transforma a rede em transação de banco.

Também não abre boas-vindas de Alma, não altera Fish/CX/Orgânico/Influs, não instala A/B e não concede uma nova capacidade no painel. A conferência de produção deve separar publicação/readback de teste com destinatário: esta correção pode ser verificada sem criar contatos ou disparar mensagens.
