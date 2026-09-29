# Preparo de A/B com público v2 — candidato em sombra

O recorte prepara uma coorte imutável do público confirmado e só então divide seus membros entre A e B. É código local: `ENABLED=false`, sem host HTTP, interface publicada, transporte, agendamento ou seleção autorizada. Não altera campanhas nativas, listas nem consentimento. Os IDs da coorte ficam dentro do adaptador privado e das tabelas; não aparecem na inspeção ou no recibo público.

## Serviço e fronteira

`ab-audience-prepare.cjs` exporta `createAudiencePrepare({transaction, timeoutMs})`, cujo `execute({key, request, signal})` aceita:

- `ab_publico_conferir`: marca e `protocol` validado pelo contrato existente `crm-ab-email-v2`.
- `ab_publico_preparar`: os mesmos campos, UUID `operation_id` e o `intent` completo recebido na inspeção.
- `ab_publico_operacao`: marca e o mesmo UUID, para releitura autenticada do recibo.

O contrato externo é `crm-ab-audience-prepare-v1`. O `intent` contém `contract`, `protocol_hash`, `scope_hash`, `cohort_hash`, `eligible_count` e `expires_at`. A inspeção informa contagem, hashes e se o mínimo por braço foi atingido; não oferece IDs nem reserva a coorte. O preparo resolve novamente o público e recusa qualquer mudança de população, versão, catálogo ou validade. Condições cuja fonte não foi comprovada continuam indisponíveis, inclusive dentro de um OU.

O host fornece transação exclusiva em READ COMMITTED, sessão com `statement_timeout` efetivo positivo de até 30 segundos e retorno somente depois do COMMIT confirmado. A autenticação de gestor exige `draft` e `read_content`; o actor é resolvido no banco. As permissões e a expiração pelo relógio real são verificadas novamente após esperas e antes/depois das gravações e do recibo. Depois da primeira inserção aplicada, falha ou expiração aborta a transação inteira. Um ACK incerto responde 202, sem retry automático; a consulta do mesmo UUID relê o recibo sem realocar membros. Essa consulta depende da autorização atual, mas não de reabrir a capacidade da fonte.

## Persistência e hashes

`ab-audience-prepare.sql` instala somente os objetos novos, em um DO atômico que recusa dependências ausentes ou colisão. Nenhuma concessão de privilégio ou RPC pública é criada.

- `crm_audience_v2.ab_scope`: PK/FK `test_id`, `brand`, `scope`, `scope_hash`, `cohort_hash`, `actor`, `created_at` e `created_xid` atribuído pelo banco. O escopo fixa `crm-ab-audience-scope-v1`, o experimento, a revisão do público, definição/contexto e hashes, base e catálogo fresco, além dos dois vínculos ordenados A/B com versão, hash e versão nativa de campanha.
- `crm_audience_v2.ab_request`: PK `(actor, operation_key UUID)`, marca, pedido/hash e resposta original. Os recibos anteriores do core A/B não são reutilizados ou reescritos.

Escopo e recibo são append-only. Cada vínculo deve coincidir tanto com a cabeça atual quanto com seu histórico imutável. O catálogo fresco do preparo pode diferir do catálogo histórico do vínculo; o vínculo preserva seu próprio catálogo dentro de seu hash, e o serviço revalida os mesmos predicados semânticos e a base exclusiva.

Hashes de protocolo, escopo, pedido, definição e contexto usam a canonicalização JS existente (chaves ordenadas recursivamente, SHA-256). SQL verifica a forma, os pins e a igualdade dos materiais, sem fingir que `jsonb::text` produz esse hash canônico. A validação diferida da coorte calcula SHA-256 do array numérico crescente sem espaços (`[1,2,...]`), que coincide com o contrato JS para IDs inteiros positivos. Não há e-mails nem credenciais nesses materiais.

A única montagem aceita é `experiment → scope → arms → members → counts → receipt`, na mesma transação. A linha do experimento deve ter sido criada/tocada nessa transação; `created_xid` não pode ser escolhido pelo cliente. A restrição diferida no COMMIT exige dois braços, 2–100.000 membros, hash correto, contagens exatas e a atribuição determinística existente por SHA-256 de `seed:id`, com metade inteira para A e o restante para B. Um resultado intermediário dentro da transação não constitui aceite de COMMIT.

## Bloqueios preservados

Depois da montagem, braços, campanhas atribuídas, contagens, seed, protocolo e membros não podem ser trocados. O membro pode ganhar uma revogação irreversível sem mudar o denominador original; não pode ser restaurado ou ter a revogação reescrita. Não existe endpoint novo de revogação.

Um vínculo usado por experimento preparado/agendado não pode ser substituído. A checagem exige READ COMMITTED antes de qualquer retorno que pudesse tratar um snapshot antigo como legado. Escritas de braços/membros também exigem READ COMMITTED, incluindo o percurso legado; seu funcionamento comum em RC continua intacto. Uma campanha com vínculo não pode ser alocada pelo preparador legado sem o escopo correspondente.

Todo experimento com esse escopo recusa `state='scheduled'` e `transport_bound=true`. Cancelamento/fechamento não são reinterpretados como envio nem ganham uma nova API. O guard de campanhas vinculadas permanece instalado; o guard A/B existente pode recusar primeiro, dependendo da operação. Nenhum GUC libera o novo bloqueio. `source_complete=false` mantém indisponível uma conclusão estatística afirmativa até uma futura integração e revisão completas.

Essas guardas pressupõem o host confiável e privilégios mínimos futuros: não conferem acesso direto às tabelas, não substituem autenticação e não tornam um superusuário incapaz de alterar o esquema. Publicação futura exige resolver seleção/contagem/transporte e reconciliação; não basta retirar uma flag.

## Provas locais

`tests/ab-audience-prepare-schema.test.cjs` cobre oito grupos com core, bindings e SQL reais em PGlite: Fish/Aristo, pins recusados, montagem incompleta, hash/contagens/atribuição errados, rollback, imutabilidade, revogação, legado com/sem vínculo, READ COMMITTED obrigatório e instalação sem concessões/ativação. As inserções do teste de esquema são diretas para exercitar os triggers independentemente do serviço.

`tests/ab-audience-prepare.test.cjs` cobre dez grupos compostos do serviço: público antes da divisão, mínimos, consentimento, ACK perdido, replay, mudança de escopo/fonte, autorização, rollback integral, vínculos incompatíveis e ordem explícita dos braços. A prova PostgreSQL 17.10 isolada também passou com sessões independentes para replay concorrente, recibo relido após COMMIT em nova transação, snapshot antigo, bloqueios e reautenticação após espera. O cluster de teste foi encerrado; essa evidência não é implantação ou aceite de produção.
