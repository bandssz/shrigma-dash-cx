# Inscrição registrada no formulário — candidato prospectivo

Candidato local, desligado e sem publicação. A instalação não configura nenhuma
fonte nem inventa uma data de cobertura. Não fazer backfill por listas, flags,
atributo `origem`, segmento Shopify, template ou recibos de envio.

`signup.recorded_origin is vip_alma|vip_desodorante` é um fato diferente de
`signup.origin`. A pergunta exata é se o UUID nativo atual tem um recibo de
inscrição aceita no formulário, no escopo/revisão fixados e desde o início da
cobertura. Ausência de recibo nesse conjunto vale false; não significa que a
pessoa nunca usou o formulário nem identifica sua primeira origem histórica.
O campo histórico mantém seu contrato e permanece indisponível.

A função VIP v2 chama o consentimento v1 revisado e grava o recibo na mesma
transação. Conserva UUID/e-mail existentes, bloqueio global, confirmação e
opt-out das listas 16/19. Replay exato retorna o recibo com `eligible=false`;
mesma chave com conteúdo diferente falha. Resposta incerta exige consulta por
produtor/evento, nunca repetição automática da mutação. O resultado público não
expõe contato nem UUID. O recibo de inscrição não autoriza mensagem.

A identidade vem do produtor fixo do formulário, não do campo livre `origem`:
Alma `NAmTWZ7vddQ8LX1k`; Desodorante `ywJDsgBDhZOBgoxb`. Isso comprova uma
solicitação aceita por essa rota, não uma pessoa autenticada pela Shopify.
A versão do produtor, o escopo UUID e a data de cobertura são imutáveis após o
primeiro recibo. Troca de versão ou escopo requer migração explícita revisada;
a versão inicial não combina silenciosamente histórico de produtores distintos.

O catálogo opcional `recorded_origins` fixa escopo, produtor, revisão e início
com hash canônico JS/SQL. O campo novo tem somente o operador `is`. Catálogos
antigos continuam válidos; definições antigas não são reinterpretadas. O painel
apresenta o começo da cobertura e preserva o rascunho quando a fonte é desligada.
A função privada `recorded_origin_match` é compartilhada pela contagem e pela
seleção regular. Compara id **e** UUID atuais; alteração/remoção da identidade
nativa não reaproveita recibos de outra identidade e não é impedida pelo ledger.
A seleção continua passando por todos os gates e pelo consentimento nativo.

Ordem candidata: consentimento v1 já revisado → `vip-recorded-origin.sql` →
`segment-recorded-origin.sql`, após a extensão Shopify de produtos. Aplicar
atomicamente e com fontes/seleção desligadas; os corpos SQL anteriores são
fixados por hash. Só a consulta de disponibilidade e o predicado agregado são
concedidos à API de públicos. Tabelas, ingestão e consultas de recibo ficam
privadas. O futuro produtor recebe apenas suas funções necessárias, por concessão
explícita; esta entrega não concede acesso de produção.

A habilitação depende também do formulário com evento persistido, ACK depois do
commit, GET de conciliação e revisão real do workflow. Código/testes locais não
provam instalação ou cobertura. Não habilitar a fonte somente porque o SQL existe.

O navegador grava o protocolo antes do POST, serializa abas concorrentes e
mantém a mesma tentativa depois de timeout ou resposta inválida. Reabrir a página
permite apenas consultar o protocolo por GET; `not_found` não prova ausência de
efeito e não permite repetir a inscrição. Um protocolo de revisão anterior
continua consultável. As recusas públicas não revelam o estado de consentimento.
Falha de inicialização (armazenamento, Web Locks ou protocolo corrompido) bloqueia
também o envio HTML padrão e apresenta indisponibilidade visível. Não limpar um
protocolo incerto nem sugerir ao visitante apagar o armazenamento para repetir.

Compatibilidade de implantação: os novos POST/GET devem usar rotas próprias
terminadas em `-recorded-v2`. O webhook e a cadeia legados permanecem intactos;
páginas antigas ou já abertas não precisam de `event_id` e não criam evidência
prospectiva. Não se pode substituir a rota antiga por uma que exija o protocolo.
O envio Shopify `/contact` mantém sua função própria, sem contar como ACK do CRM.

Na futura janela, instalar SQL com gates OFF, configurar produtor/escopo/cobertura
e suas permissões, publicar e reler a rota v2, e só então publicar o formulário.
Não escolher cobertura anterior à habilitação real do produtor. Ativar o campo
no painel exige o catálogo e a versão da API compatíveis, além da conferência
das fontes reais. Nenhuma dessas etapas foi executada em produção nesta rodada.

Provas locais: percurso pelo DOM/API/store, count/save/reopen/binding/selection,
paridade JS/SQL dos pins, fontes inválidas/desligadas, E/OU, UUID trocado,
consentimento e ACL. PostgreSQL 17 usa logins reais e pools de quatro conexões,
replay concorrente, conflito com opt-out e recuperação por SELECT após commit
simulado sem ACK. Nenhum envio ou alteração de produção.
