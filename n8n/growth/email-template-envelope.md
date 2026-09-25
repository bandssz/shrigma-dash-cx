# Campos completos de templates de e-mail

CRM-04. O editor oferece remetente, responder para, assunto, pré-header e conteúdo
para Fishermans e O Aristocrata. A prévia e o corpo enviado ao cadastro de templates
usam o mesmo contrato `growth-email-contract.js`. O pré-header é escapado e inserido
no corpo de documentos completos ou no layout de marca usado para fragmentos.

Remetente e resposta precisam pertencer ao domínio da marca; quebras de linha e
injeção de cabeçalho são recusadas. E-mails legados sem os campos novos continuam
legíveis e seus recibos mantêm o payload original. Abrir um e-mail legado no editor
inicia o preenchimento desses campos; a nova versão exige pré-header antes de ser
validada. Metadados de remetente/resposta ficam no rascunho versionado: o objeto de
cadastro do Listmonk continua apenas name/type/subject/body.

Importação, exportação e o journal preservam os campos completos. Rascunhos de
WhatsApp não incorporam campos de e-mail. Esta entrega não envia mensagens: o teste
para Felipe é a próxima capacidade, separada e com confirmação própria.

## Implantação

Após CI verde, exportar de novo o workflow Growth `y6qJRcWcSfEZzwgZ` e passar a versão
observada para `email-template-envelope-patch.cjs`. O patch verifica âncoras únicas,
preserva os handlers existentes e modifica apenas o render/validação de e-mail em
Prepara e Decide escrita e a lista de campos de recibo em Formata leitura. Export,
backup, diff e leitura posterior precisam confirmar essa mesma abrangência. Não
altera credenciais, conexões, settings, login, fluxos ou envio.

Depois publicar o painel Growth e conferir novo rascunho, prévia, save/validate e
round-trip dos campos nas duas marcas. Publicação de um template não ativa fluxos
nem envia mensagens.
