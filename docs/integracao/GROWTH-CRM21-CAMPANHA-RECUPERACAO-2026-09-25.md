# CRM21 — validar antes de criar e recuperar o mesmo rascunho

Uma campanha contendo apenas a página inicial da loja passava pela normalização, criava um rascunho nativo e depois falhava em `NO_COMMERCIAL_LINK`. A conferência de rastreamento exige um destino de produto, página ou coleção. Como a falha acontecia depois da criação, o recibo era `outcome_unknown`, preservando o ID existente, mas a interface só oferecia consultar novamente.

O novo `preflight` usa a mesma transformação pura dos links, sem inventar uma identidade de disparo. Cliente e serviço conferem conteúdo, catálogo, destinos e UTMs antes de criar. A regra comercial e o descadastro permanecem obrigatórios. Uma recusa de conteúdo pode ser corrigida sem deixar outro rascunho nativo.

## Recuperação explícita

O GET `campanha_operacao` conserva o recibo original e pode oferecer `recovery`, com política `crm-campaign-recovery-v1`, UUID interno da operação de origem, campanha e revisão atual. Isso exige:

- a operação de origem da mesma autoria/marca, ação `salvar`, finalizada como `outcome_unknown`, com recibo e `provider_id` coerentes;
- exatamente uma campanha com `created_operation_id` igual à origem e ID igual ao `provider_id`;
- campanha CRM regular Fish/Aristo, ainda `draft`, zero enviados e sem início;
- ausência de recuperação já registrada para essa origem.

A prova do GET é provisória. Após confirmação HTML, `campanha_recuperar` recebe `id`, `expected_version`, `source_operation_id`, `confirm:'recuperar'` e **nova chave de idempotência**. O serviço exige capacidade `draft`. A transação trava a nova operação, a origem terminal e a campanha, confere novamente o vínculo/revisão e grava um recibo de recuperação único. Não chama Listmonk e não altera a campanha, a operação original, os públicos ou contatos.

A interface conserva a preparação original e a tentativa anterior antes do POST. O retorno vincula essa preparação ao ID existente; conteúdo ou data ainda não salvos continuam como alterações locais. O próximo salvamento atualiza esse ID. Aceitar a recuperação não agenda nem envia. Resposta perdida exige consultar a nova tentativa, sem reenvio automático. Estado `pending`, campanha já iniciada, fonte sem vínculo ou resposta divergente permanecem bloqueados.

## Instalação revisável

1. Guardar export fresco e publicado do workflow de campanhas, funções SQL anteriores, constraints e estado das operações/campanhas envolvidas. Confirmar que o papel real do workflow possui privilégios nas novas tabela/função; não inferir isso pelo papel do utilitário SQL.
2. Aplicar `campaign-recovery-install.sql` em transação, somente depois do CI/review. A migração recusa corpos inesperados das funções existentes; não altera os registros históricos. Reaplicação da mesma migração é idempotente.
3. Gerar o candidato com `campaign-recovery-patch.cjs` usando a versão publicada fresca. São cinco corpos de nós: `Iniciar`, `Retomar`, `Entrada`, `Despacha` e `Recibo erro PG`. Auth, referências de credenciais, rotas, retenção, CORS e conexões são preservados. Publicar e conferir a versão efetivamente ativa.
4. Só então anunciar `campaigns.recover=true` e `recovery_policy='crm-campaign-recovery-v1'` pelo helper de capabilities e publicar o bundle Growth. O cliente não oferece recuperação sem essa política.
5. Na UI, consultar a tentativa original, conferir o mesmo rascunho e confirmar a recuperação. Após o recibo e leitura atual, corrigir o conteúdo e salvar no mesmo ID. Conferência de público, agendamento e cancelamento continuam ações próprias; a recuperação não autoriza envio.

As provas e backups contendo dados reais ficam no diretório privado de aceite. O código e os ensaios usam fixtures sintéticas.

## Verificação e limites

Os testes cobrem preflight sem criação, identidade e autoria, histórico preservado, migração/recusa de drift, pacote n8n sem transportes na recuperação, perda de resposta, revisão alterada, confirmação cancelada e diário após recarregar. O ensaio CI com PostgreSQL 17.10 usa conexões independentes para CAS durante espera e duas recuperações concorrentes da mesma origem. PGlite comprova o contrato SQL local; não substitui essa prova de concorrência.

O vínculo se apoia nas operações duráveis e nos atributos CRM, nunca só no nome. As guardas protegem os escritores da aplicação; um administrador de banco que remova triggers ou altere registros diretamente está fora desse contrato. O GET não congela o estado. O POST recusa alterações intervenientes, e uma recusa de recuperação não libera criar outra campanha por conta própria.

Para reverter a disponibilização, desativar a capability e retirar o botão. Preservar a tabela e os recibos de recuperação. Depois de existir ação `recuperar`, não reaplicar uma constraint antiga nem apagar esses registros para permitir downgrade. Qualquer reversão de funções/runtime exige comparação das operações duráveis e revisão separada.
