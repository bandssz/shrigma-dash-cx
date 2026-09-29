# Público salvo → agendamento regular — candidato OFF

O serviço `crm-audience` mantém `/campaign-audience` e a autenticação Gestor
existentes. `campanha_publico_preparar_envio` usa a validação real de conteúdo,
binding, fonte e consentimento dentro da mesma conexão dedicada. Captura o
material completo por texto, com parser numérico estrito e locks das dependências;
fixa a versão de campanha, revisão do público, contador agregado e identidade
aprovada do worker/remetente em revisão privada de até60s.

`campanha_publico_agendar` exige essa revisão, confirmação `agendar`, chave de
idempotência e permissões atuais `validate`, `read_content` e `submit`. Reconfere
conteúdo, público, quantidade, material, data futura (15 minutos), lease e política
da marca; grava controle de entrega, status scheduled e recibo na mesma transação.
Não recebe hashes de worker, permissões, ator ou material do navegador. O MD5 do
provider existente conserva o fuso da sessão; somente o snapshot completo usa UTC.

O painel registra a tentativa antes do POST e exige confirmação humana. Resposta
incerta não autoriza outro POST; a consulta autenticada
`campanha_publico_agendamento_operacao` recupera o comprovante original. O recibo
confirma agendamento, nunca entrega. Revogação antes do COMMIT causa rollback;
perda da resposta de COMMIT permanece incerta até consulta. Repetição do mesmo
pedido retorna o recibo, enquanto outra carga para a mesma chave é recusada.

O worker9 aplica exatamente um X-SES-Configuration-Set obtido do controle privado,
sem pedir cabeçalhos ao analista. `regular_delivery_claim_live` recebe11 parâmetros,
o último com esse valor real usado no MIME; divergência desfaz recibo/progresso.
Cabeçalhos opcionais já presentes precisam coincidir com a política. Cc/Bcc,
Return-Path e cabeçalhos fora do contrato são recusados antes do agendamento.
A primeira versão não aceita anexos ou funções de template com relógio, idioma
mutável ou aleatoriedade. A política compilada do worker é a validação final;
TrackLink e personalização por assinante continuam suportados. Mudanças na tabela
nativa de links exigem preservar as permissões existentes de integridade.

`CRM_AUDIENCE_REGULAR_ENABLED=false` é independente da gestão de públicos e requer
que binding também esteja habilitado. Consulta de recibo continua acessível quando
o gate regular está OFF. A instalação SQL não aprova worker/remetente e não concede
acesso automaticamente. `segment-regular-admission-access.sql` concede somente
SELECT/INSERT em revisões/recibos e EXECUTE nas três funções delimitadas para o papel
já existente; não concede UPDATE em campanhas, assinantes, policy, deployment ou
controle de entrega. Instalar com deployment/controles OFF.

Provas locais: DOM real do editor nas duas marcas com escolha/vínculo/conferência,
confirmação cancelável, agendamento e consulta após reload/ACK perdido; PGlite de
revogação/opt-out/drift; PostgreSQL17.10 com HTTP, papel crm_audience_api e duas
chamadas simultâneas para uma única agenda. O processo nativo separado usa schema
oficial e SMTP loopback com aceite, ACK perdido, no replay e preservação do legado.
Nenhuma dessas provas envia a clientes ou altera produção.

Ainda exigidos para ativação: CI Linux e OCI conferida, revisão da configuração
SES real por marca, permissões do worker, identidade efetiva do processo no servidor,
prova de todos os emissores e janela coordenada com Felipe para troca de serviços
existentes. Gestão de públicos já publicada não equivale à ativação deste percurso.
