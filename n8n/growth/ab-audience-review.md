# Revisão do público A/B preparado — candidato em sombra

Este recorte revê somente os membros e braços fixados pelo preparo de público v2. Não escolhe novos membros, recompõe braços, revoga consentimento, muda o denominador original ou escreve nas tabelas de experimento, campanha, listas e membros. `ENABLED=false` e todas as respostas de revisão mantêm `authorizes_selection=false`, `authorizes_send=false`, `execution_blocked=true` e `snapshot_only=true`. Uma revisão confirmada continua sendo uma fotografia; não é autorização de agendamento, seleção, envio ou conclusão estatística.

## Contrato do serviço

`ab-audience-review.cjs` exporta `VERSION='crm-ab-audience-review-v1'`, `ACTIONS`, `FLAGS`, `ERROR_STATUS`, `UNAVAILABLE_REASONS`, `request`, `publicReview` e `createAudienceReview({transaction, timeoutMs})`. O serviço expõe `execute({key, request, signal})`; não cria servidor, pool, conexão, credencial ou endpoint ativo.

| Ação | Campos além de `acao` e `brand` | Permissão |
| --- | --- | --- |
| `ab_publico_revisar` | `test_id`, `expected_version`, `expected_scope_hash`, `operation_id` UUID | `validate` e `read_content` |
| `ab_publico_revisao_operacao` | `operation_id` UUID | `read_content` |
| `ab_publico_revisao_obter` | `test_id` | `read_content` |

IDs e hashes precisam ser strings, sem coerção de arrays. Campos extras, IDs de membros e escolha de regra enviados pelo cliente são recusados. O actor vem do helper autenticado combinado com a confirmação da chave e de sua expiração usando `clock_timestamp()`.

POST retorna 201 com `{review,...FLAGS}`. GET de última revisão retorna 200 com `{review:null|publicReview,...FLAGS}`; `null` significa que ainda não há revisão registrada para aquele preparo. GET de operação retorna exatamente o recibo original de sucesso ou de recusa. Ambos continuam legíveis para um leitor autorizado quando a fonte está OFF. A consulta de operação também confere a revisão imutável referida pelo recibo, sem reavaliar a população nem mudar a última revisão.

A revisão pública tem exatamente 14 campos: `review_id`, `test_id`, `brand`, `experiment_version`, `scope_hash`, `cohort_hash`, `status`, `reason`, `checked_at`, `expires_at`, `arms`, `minimum_reached`, `eligible_fingerprint`, `snapshot_only`. Cada um dos dois braços ordenados A/B tem `arm`, `campaign_id`, `allocated`, `eligible`, `excluded`, `revoked`, `missing`. Nenhum ID de assinante, definição completa, chave, seed ou motivo pessoal é projetado.

## População fixa e fontes incertas

O serviço revalida protocolo, seed, escopo, ambos os vínculos e seus históricos, versão MD5 das campanhas e base nativa exclusiva. O recibo imutável do preparo fornece os denominadores originais. Os membros precisam manter o mesmo hash de IDs, contagens e divisão determinística por seed. Incoerência conhecida de alocação gera revisão `unavailable`, conservando esses denominadores.

A definição e o contexto vêm da revisão imutável do público fixada no escopo. A cabeça desse público pode ter sido editada: sua nova definição não substitui a regra do experimento, e sua nova versão não invalida por si só a revisão. Arquivar a cabeça ou a revisão fixada torna a revisão indisponível.

`segment-audience-allocated.cjs` avalia somente essa população fixa, com consentimento na base e nas folhas, operadores E/OU e status global `enabled`. Revogação permanente prevalece sobre assinante ausente, que prevalece sobre status global, consentimento da base e regra. `excluded=allocated−eligible`; `revoked` e `missing` são subconjuntos exclusivos de `excluded`. Um assinante ausente não reduz o denominador nem é substituído. Campos externos sem fonte operacional confirmada permanecem desconhecidos, mesmo dentro de OU.

Uma indisponibilidade conhecida cria uma nova revisão durável com `status='unavailable'`, motivo enumerado, contagens `eligible/excluded/revoked/missing=null`, `minimum_reached=null` e `eligible_fingerprint=null`. Ela passa a ser a última revisão, em vez de deixar a confirmação antiga parecendo atual. Os motivos aceitos estão em `UNAVAILABLE_REASONS`: fonte indisponível/expirada, público arquivado, contexto alterado, listas/fonte externa indisponíveis e alocação indisponível/alterada/malformada.

A revisão confirmada vence no menor instante entre a validade da fonte e cinco minutos após sua conferência. A indisponível tem `expires_at=checked_at`. Expiração conhecida antes da primeira inserção pode ser registrada como `source_expired`; expiração ou falha depois das gravações exige rollback integral, sem reescrever uma revisão append-only. Uma revisão histórica expirada continua uma fotografia legível e nunca ganha autorização.

## Atomicidade, ordem e incerteza

O adaptador fornecido pelo host precisa de uma transação exclusiva READ COMMITTED e `statement_timeout` efetivo positivo de até 30 segundos. O serviço limita `lock_timeout` a 500 ms e confere o timeout já existente; não usa uma configuração local para fingir uma fronteira independente. O callback deve retornar somente depois do COMMIT confirmado e respeitar cancelamento. O timer JS sozinho não prova que SQL parou ou fez rollback.

A ordem é operação global → marca → experimento → campanhas em ordem numérica → dependências → vínculos → configuração/público → braços/membros. O resolvedor permanece na mesma transação e trava os dados de consentimento consultados. Permissões são conferidas depois das esperas e no final; material, catálogo, revisão fixada, vínculos, membro/seed e validade são relidos antes e depois da escrita. O relógio `read_at` é excluído da comparação de catálogo; `checked_at` e `expires_at` da fonte permanecem fixados. Edição da cabeça não é incluída indevidamente no hash da revisão fixa.

Revisão e recibo são gravados na mesma transação. Recusas de estado, versão, escopo, vínculo ou campanha têm recibo de erro com código estático. Falha SQL, timeout, cancelamento ou ACK incerto não são convertidos em contagem zero ou em revisão indisponível supostamente persistida. O serviço retorna 202 para escrita incerta, com o mesmo `operation_id`, `state='unconfirmed'` e `automatic_retry=false`; a conciliação é consultar esse recibo. Uma nova revisão pode superar uma anterior, mas replay nunca realoca, cria outra revisão ou reponta a cabeça.

## Persistência privada e limites

`ab-audience-review.sql` instala em um único DO, somente em estado novo e com as dependências presentes:

- `crm_audience_v2.ab_review`: sequência automática `GENERATED ALWAYS AS IDENTITY`, `review_id` PK, FK do preparo, marca, actor e `evidence/evidence_hash`; índice da última sequência por experimento/marca.
- `crm_audience_v2.ab_review_request`: ledger imutável por `(actor, operation_key UUID)`, com pedido/hash e resposta original.

A evidência privada fixa `{contract,review,protocol_hash,scope,source_snapshot_hash,allocation_fingerprint}`. Os hashes públicos, do protocolo, do escopo e da evidência usam a canonicalização JS existente. `source_snapshot_hash` é um contrato privado diferente: SHA-256 da serialização JSON das linhas devolvidas pelo PostgreSQL, normalizando datas e removendo somente `read_at`. Isso permite registrar catálogo inválido sem fingir que ele passou pela canonicalização limitada da interface. O fingerprint de elegíveis inclui o experimento/escopo e IDs por braço, mas só o hash é persistido/projetado.

Os triggers protegem a forma, o vínculo do escopo, a fase `prepared`, `source_complete=false`, ausência de transporte e imutabilidade das duas tabelas. Não substituem o validador JS, a autenticação ou uma futura revisão de privilégios mínimos. Não há concessões a aplicações, funções RPC, alteração do core/guardas anteriores ou integração com a revisão legada. O maior `review_sequence` é sempre a última revisão, inclusive indisponível; recibos antigos permanecem históricos.

A validação local usa o core, o preparo, os vínculos, a revisão fixa e o resolvedor reais em fixtures sintéticas. Não constitui implantação, aceite nas lojas ou prova de entrega. Continuam faltando admissão futura de seleção/transporte, conciliação operacional e publicação coordenada do sistema completo; remover uma flag não completa esse trabalho.
