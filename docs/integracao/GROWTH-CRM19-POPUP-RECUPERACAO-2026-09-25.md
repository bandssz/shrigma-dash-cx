# CRM19 — conciliação de popup por evidência SES

Proposta restrita a uma pendência antiga com entrega comprovada, sem reenvio. Não altera as outras 53 pendências sem dupla prova, o incidente de 20h de 24/09, workflows, assinantes ou outros painéis.

## Evidência observada, somente leitura

Em 25/09, a pendência de `aristo / popup / cupom-boas-vindas` iniciada em 18/09 às 20:49:27.622Z tinha `in_flight`, nenhum `send_log` e nenhum registro permanente de resposta HTTP. Os eventos SES Send (20:49:30.226Z) e Delivery (20:49:30.957Z) estavam conciliados com a mesma reserva, mensagem, conta, região, destinatário e configuração. A identidade HMAC do destinatário foi recalculada pela função instalada e coincidiu com a reserva. Os dois envelopes SNS arquivados passaram pela comparação SHA-256 e pelo confronto com o payload ingerido. Dados pessoais e identificadores ficam nos arquivos privados da auditoria CRM19.

A referência persistida identifica a execução n8n original; sua consulta pontual retornou 404. O workflow Growth que processa o popup está com retenção de sucesso/erro desabilitada na consulta atual. Isso não prova qual retenção existia na data do envio. Não foi baixado conteúdo de outra execução.

A função instalada `shrigma_email_recover_finalizations` exige aceite HTTP e contexto capturados. Não temos essa prova. `shrigma_email_recover_tx_delivery` trata apenas `flow=transacional`. Nenhuma dessas funções deve ser adaptada no momento da chamada para aceitar o popup.

## Efeito proposto

`n8n/growth/ses-popup-recovery.sql` acrescenta uma função específica e uma tabela de auditoria. Aceita apenas Fish/Aristo, `flow=popup`, `piece=cupom-boas-vindas`, não teste, reserva antiga em `in_flight` ou `outcome_unknown`, referência canônica `popup-execution:<id>` e ausência de log/HTTP capturado. Recalcula a identidade do destinatário pela função HMAC instalada. Exige exatamente Send + Delivery, mesmo message ID e horário de envio, envelopes íntegros, tags e destinatário exatos e vínculo da mensagem.

O aceite no registro de transporte passa a ser documentado por SES, com `error_code=RECONCILED_SES_DELIVERY_HTTP_NOT_CAPTURED`. O log recebe `template_id=NULL`: template, corpo, resposta e código HTTP continuam desconhecidos. `sent_at` e `accepted_at` usam o instante do envio SES; `outcome_at` indica a conciliação. A auditoria guarda a reserva anterior e as referências/hashes das provas. As métricas históricas passam a incluir o registro no dia do envio original.

A finalização original de popup apenas cria o log e finaliza a reserva. A escrita em `subscribers.attribs` pertence exclusivamente ao ramo NPS D3. Portanto a recuperação não escreve atributos, não marca novo envio, não chama o finalizador antigo nem reprocessa webhook.

Locks seguem a reserva: advisory por marca/popup/e-mail → advisory por referência → linha de dispatch. O vínculo da mensagem e as provas existentes são bloqueados para leitura com `NOWAIT` durante a verificação. Se ingestão ou arquivamento estiverem usando uma prova, a chamada aborta sem efeito; não espera segurando o dispatch nem tenta novamente sozinha. Uma repetição reconhece a mesma auditoria/log e verifica novamente os envelopes e fingerprints das duas provas auditadas. Eventos posteriores e rotação da chave HMAC não exigem reconstruir as provas; divergência no material auditado bloqueia o replay. Reserva concorrente continua impedida de emitir novo envio. Se a finalização antiga vencer, a recuperação recusa sobrescrevê-la.

## Revisão e aplicação

Não há instalação ou aplicação automática. Antes de instalar, conferir schema/funções, exportar a reserva/provas/logs relacionados para armazenamento privado, revisar este diff e exigir CI PostgreSQL verde. A migração cria objetos novos e falha se já existirem; não substitui funções antigas.

A chamada `SELECT * FROM public.shrigma_email_recover_popup_delivery_v1($1::uuid)` usa `dry_run=true`. Ela testa as escritas em subtransação e desfaz todas as linhas: resultado `would_reconcile`, sem ID de log persistido. Sequências PostgreSQL podem avançar mesmo com rollback. Confirmar que reserva, logs e auditoria continuam iguais ao backup. Só então o responsável pela aplicação pode chamar a mesma função com segundo argumento `false`, para a única reserva conferida, e validar o resultado e o replay. Nenhum destino HTTP existe nessa função.

Validação local: testes PGlite de rollback, replay, estados/marcas, identidades, arquivos adulterados, provas faltantes e preservação de atributos. PGlite usa um substituto determinístico de digest no fixture; não é prova criptográfica. O job separado `popup-recovery-concurrency` usa PostgreSQL 16, SHA-256/HMAC reais com segredo sintético e sessões independentes para testar disputas de recuperação, reserva e finalização nativa. O CI não usa credenciais, destinatários ou dados de produção.
