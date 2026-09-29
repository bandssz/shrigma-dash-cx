# Tentativa regular vinculada — candidato privado

O SQL `segment-regular-delivery.sql` conecta a seleção real ao recibo existente
`public.shrigma_email_dispatch`. Não instala transporte, não fornece admissão
ou agenda e não altera o guard de produção que mantém campanhas vinculadas em
rascunho. Não há grants. `regular_delivery_campaign.enabled` nasce false; somente
as fixtures descartáveis inserem pins sintéticos e o habilitam para testar o
protocolo. Essa ativação de fixture não é autorização operacional.

O futuro admission precisa usar o parser e o leitor de material existentes
(`ab-audience-material.cjs` e `ab-audience-material-read.cjs`), confirmar bytes
dos anexos e configuração efetiva de renderização/SMTP, identidade do worker,
topologia e permissões. Não preencher pins com valores declarados pelo cliente
nem copiar de volta um hash do banco como se comprovasse o processo em execução.
`material` conserva o snapshot normalizado existente, excluindo apenas os sete
campos de progresso. A comparação JSONB durante claim confirma igualdade das
linhas sob locks; não substitui validação estrita ou completude do material.

## Tentativa e confirmação

`regular_delivery_claim(cid,sid,dispatch_uuid,worker_sha,runtime_sha,from,to,
payload_sha,subscriber_snapshot)` só pode ser chamado pelo store nativo dentro
do callback de `PushRegularGuarded`, depois da espera pela conexão e da montagem
dos bytes. `from` é o endereço SMTP parseado, sem nome de exibição; `to` é o único
destinatário parseado. O UUID de dispatch deve ser gerado pelo worker e colocado
nas tags antes da montagem dos bytes, nunca aceito de um pedido do painel.

O store mantém transação READ COMMITTED exclusiva, timeout positivo até30s,
lock timeout500ms e COMMIT confirmado antes de liberar MAIL. A função serializa
a campanha; reconfirma pins, fonte, material, estado, assinante e consentimento;
recusa saltar um destinatário elegível anterior. Uma exclusão por opt-out pode
avançar somente o checkpoint, sem criar dispatch ou incrementar envios. Fonte
indisponível/vencida é erro55000 e desfaz tudo.

O resultado positivo contém `should_send:true`, `reason:claimed`, `dispatch_id`,
`claim_token`, `checked_at` e `valid_until`. O store deve calcular a janela entre
os dois horários do banco e descontar, conservadoramente, toda a duração local da
transação antes de MAIL, usando relógio monotônico. Resultado vencido ou COMMIT
incerto não libera SMTP, mesmo que exista `in_flight` no banco. Nunca repetir o
claim com outra identidade para resolver a incerteza.

O catálogo do seletor usa tempo fixo do statement para consistência de contagem
e lote. Claim também confere `clock_timestamp()` depois das esperas e depois do
INSERT; isso impede que um lock atravesse a expiração e reserve uma tentativa
com a fonte já vencida.

O recibo usa flow `campaign`, piece `audience-regular-v1:<campaign_id>` e dedupe
`[campaign_id,binding_version,subscriber_id]`. Replays devolvem o estado original
sem token e sem autorizar envio. Outra tentativa `in_flight/outcome_unknown` da
mesma campanha impede avançar. A seleção nova não atualiza cursor nem `sent`;
o worker deve aguardar o resultado de um destinatário antes de enfileirar outro.

`regular_delivery_finish(cid,sid,dispatch_id,token,outcome)` aceita `accepted` ou
`outcome_unknown`. Confirmação grava recibo, contador e checkpoint juntos, uma
única vez. Resultado incerto suspende o controle e conserva o checkpoint. Não há
conversão automática de unknown para accepted nem reenvio; conciliação confiável
continua pendente. OFF/pausa posterior não apaga a história de uma tentativa já
reservada: finish pode registrar o que ocorreu.

## Provas e limites

Sete testes PGlite compõem seletor, consultas nativas e recibo; incluem duas
marcas, defaults OFF, opt-out depois da seleção, replay, resposta perdida, ordem,
deriva de material/runtime/assinante, finish depois de OFF e rollback do recibo quando a atualização de progresso falha. Três testes do
checkpoint provam que leitura/cleanup não confirmam envio e que o legado sem
vínculo mantém cursor/contadores nativos.

`segment-regular-delivery-postgres.cjs` passou em PostgreSQL17.10 descartável:
claims concorrentes têm um vencedor; finish concorrente incrementa uma vez;
resposta perdida não permite replay; opt-out e expiração de catálogo após espera
por lock impedem a tentativa. O cluster foi encerrado. As fixtures estruturais
não incluem autoridade de agenda nem removem o guard instalado em produção.

## Conciliação por evidência, ainda privada

`segment-regular-recovery.sql` compõe o mesmo recibo, contador e checkpoint com
os registros existentes de ingestão SES. A função `regular_delivery_recover`
nasce sem grants e em dry-run por padrão. Exige tentativa com pelo menos15min,
identidade da campanha/vínculo/destinatário, eventos Send e Delivery do mesmo
messageId, tags, conta/região/configuração e arquivo SNS com hash íntegro.
Não usa texto de erro SMTP nem ausência de evento para concluir sucesso.

O primeiro resultado confirmado grava auditoria, receipt accepted e avanço do
contador/cursor juntos. Replay reconfere a auditoria/arquivos e não incrementa
de novo. A campanha continua suspensa: conciliar não reenvia, não habilita o
controle e não autoriza retomada. Prova ausente, conflitante, corrompida ou sem
Delivery conserva a incerteza. Não há caminho de reenvio presumido como seguro.

Três testes PGlite cobrem dry-run, ambas as marcas, ausência/corrupção/conflito,
rollback e replay. O runner `segment-regular-recovery-postgres.cjs` passou em
PostgreSQL17.10 real com SHA256 do arquivo, duas conciliações simultâneas e um
único incremento, mantendo suspensão e impedindo novo claim. Os eventos são
sintéticos: isso testa o protocolo, não a autenticação da ingestão SES viva.

A integração manager/store Go compilou e seus testes focais passaram; a prova
do processo completo candidate6 passou com PostgreSQL17.10, schema oficial e
SMTP loopback: accepted, ACK perdido, reinício sem replay, caminho legado e
quarentena isolada. Correções preservam Unsafe de sqlx na transação e comparam
datas nativas do assinante por instante, mantendo microssegundos e campos
restantes exatos. Essa prova precede a integração de lease/guard abaixo.
Identidade efetiva da imagem, configuração externa, permissões,
admissão de agenda, recuperação operacional e janela coordenada de Felipe ainda
são necessárias. Nenhuma dessas funções foi instalada em produção.

## Processo aprovado e guard operacional em integração

`segment-regular-worker-lease.sql` acrescenta uma aprovação administrativa OFF,
com hashes de binário/configuração/query e papel de banco. O heartbeat não pode
aprovar a própria identidade. Um UUID por processo recebe lease de60s, renovado
somente com a identidade aprovada. Renova o catálogo nativo sem habilitar fontes
desligadas nem inventar cobertura Shopify. Uma marca inválida não impede o
refresh da outra. `regular_delivery_claim_live` valida lease antes e depois da
função de claim e limita a janela de transporte ao menor prazo disponível.

Um lease expirado sem suspensão pode ser adquirido por outro processo. Colisão
com processo ainda vivo, deriva da mesma identidade e deployment OFF suspendem
o caminho até revisão administrativa; expiração não apaga essa suspensão.
O store deve confirmar COMMIT também para respostas `ready:false`, pois podem
conter suspensão durável. A integração Go precisa renovar a cada20s, confirmar
o primeiro heartbeat antes do scan, bloquear somente bound quando indisponível
e encerrar a rotina com o manager. Nunca aceitar UUID/hashes de um cliente HTTP.

O controle conserva `acknowledged_sent` e `acknowledged_subscriber_id`. Somente
claim-ineligible, finish e recovery os avançam antes da atualização nativa, na
mesma transação. `segment-regular-operation-guard.sql` instala, com tudo OFF e
bound draft, uma substituição exata da função original. Conserva edição de
rascunho, pausa mesmo sem fonte/worker e gravação de histórico após OFF.
Transições operacionais exigem controle, material, pins, lease e checkpoint.
A consulta completa do worker antigo falha antes de retornar destinatários,
pois seu cursor antecipado não tem checkpoint privado correspondente.

Cinco testes de lease e quatro de guard passaram; PG17.10 confirmou colisão,
expiração durante espera com rollback do recibo, negação de EXECUTE público,
OID/proprietário/ACL do guard preservados e incremento concorrente recusado.
Essas fixtures aprovam pins sintéticos administrativamente. Ainda não são uma
API autenticada de agendamento e não substituem a próxima prova nativa composta.
