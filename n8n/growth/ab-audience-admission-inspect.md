# Conferência da admissão A/B — candidato em sombra

`ab-audience-admission-inspect.cjs` compõe a última revisão do público salvo, a elegibilidade atual dos contatos alocados e o material SQL das duas campanhas. `ab-audience-admission-api.cjs` oferece a fronteira HTTP em memória; não cria servidor, endpoint publicado ou workflow. Ambos ficam desligados. O [contrato público](ab-audience-admission-contract.md) descreve pedido e resposta.

É uma **inspeção sem escrita de dados**, anterior à futura admissão de agendamento. Não cria outro histórico/recibo, altera campanha/experimento, chama o agendador legado ou remove guardas. A conexão precisa de transação com locks: `readOnly:false` no adaptador não significa que o serviço tenha uma operação de escrita. Não existem `operation_id`, POST, confirmação de envio ou resposta 202 nesse percurso.

## Pedido e autenticação

GET autenticado com exatamente `acao=ab_publico_admissao_inspecionar`, `brand`, `test_id`, `expected_version`, `expected_scope_hash` e `review_id`. Marca limitada a Fish/Aristo. O pedido não recebe atores, capacidades, contatos, consultas, contagens ou snapshots do cliente. HTTP recusa credenciais ambíguas, origem diferente da autorizada, corpo com dados e campos extras.

O banco deriva a identidade e exige `validate` e `read_content`; isso permite conferir e não concede `submit`. A revisão deve ser a mais recente, confirmada, ainda válida e do mesmo operador. Uma revisão nova indisponível impede usar a anterior. Autenticação é refeita após esperas e, no último acesso ao banco, junto da hora atual e da identidade de conexão/transação. Perda de permissão retorna 403; chave inválida/expirada retorna 401.

## Condição de integração: UTC/ISO em todas as etapas

O adaptador confiável deve manter uma conexão exclusiva `READ COMMITTED`, `statement_timeout` positivo de até 30 s e `lock_timeout` de até 500 ms. **Todos os percursos que criam os pins — vínculo, preparo, revisão e inspeção — precisam usar UTC/ISO antes das leituras de versão.** Configure isso na inicialização da sessão/transação compartilhada. A inspeção também configura/verifica UTC/ISO localmente, como exige o leitor de material.

O MD5 legado inclui timestamps serializados pelo PostgreSQL; uma preparação produzida numa sessão `America/Sao_Paulo` pode ter MD5 diferente da leitura UTC sem alteração das linhas. Essa diferença é recusada, sem rehash automático, exceção ou substituição pelo hash material. Artefatos antigos de sessão incompatível exigem nova preparação/revisão pelas operações apropriadas; este serviço não os modifica. O código de produção ainda não conecta um adaptador que assegure essa condição em todas as rotas, portanto as provas locais **não atestam compatibilidade operacional ou implantação**.

## Conferência composta

1. Marca, experimento preparado, protocolo, versão e escopo imutável devem coincidir. A evidência da revisão e o recibo original do preparo são validados por hash e identidade.
2. As duas campanhas são bloqueadas em ordem crescente. Precisam permanecer rascunhos HTML/e-mail, sem envio iniciado, com o mesmo horário nativo e antecedência mínima de 15 minutos. O texto UTC de `send_at` é comparado antes da projeção JavaScript: diferenças em microssegundos não desaparecem. O `send_at` público é uma projeção em milissegundos; o material privado retém a precisão nativa.
3. O leitor [material-read](ab-audience-material-read.md) confere linhas completas, FKs, relações e dependências. Os MD5 originais dos braços/vínculos continuam obrigatórios, mesmo quando o hash material não muda com um timestamp operacional.
4. Histórico e cabeça de cada vínculo devem corresponder ao mesmo público/revisão/base/contexto fixado. Editar a cabeça do público não substitui sua revisão original; arquivar invalida a inspeção.
5. A fonte atual precisa estar disponível e interpretar as mesmas regras. Uma atualização equivalente de catálogo pode mudar revisão e timestamps internos; isso não invalida automaticamente a revisão anterior. `source_snapshot_hash` histórico registra o que a revisão viu. A inspeção valida novamente os pins semânticos, a alocação, os elegíveis e as contagens; compara o fingerprint bruto entre suas próprias leituras para detectar deriva. Usa o mesmo codec bruto da revisão, sem exigir igualdade com o snapshot histórico. A validade antiga nunca é renovada por um refresh equivalente.
6. A alocação é conferida contra seed, braços, recibo original, coorte e denominadores. O resolvedor compartilhado reavalia **somente os alocados**, com estado global, base, folhas e revogações. Inscritos externos não entram. Mudança de elegíveis/contagens exige nova revisão; zero real ou perda do mínimo não se confunde com fonte desconhecida.
7. Material, vínculos, revisão atual, escopo e fonte são conferidos novamente; há uma segunda resolução do público. A consulta final verifica autenticação, sessão e prazo antes de produzir o DTO.

Expiração é o menor instante entre revisão existente, fonte atual e cinco minutos após a inspeção. A consulta final não concede mais tempo à revisão. Falha de banco, resposta perdida, timeout ou aborto retorna **503 sem inspeção**, sem fingir que houve escrita. O adaptador deve concluir cancelamento/rollback antes de reutilizar a conexão; encerrar o resultado JavaScript não comprova que o SQL parou.

## Snapshot e limites de concorrência

`audience.checked_at` identifica o início da última consulta do resolvedor; `audience.snapshot_only=true` é fixo. `checked_at` externo identifica a conferência final de autenticação/hora. Os dois instantes têm funções diferentes e nenhum promete um corte serializável de todo o banco.

Locks protegem as linhas existentes lidas. Uma associação antes ausente pode ser inserida depois do snapshot da consulta, inclusive antes do retorno. Ela não é incorporada retroativamente às contagens já retornadas. A próxima inspeção detecta mudança de elegibilidade e exige nova revisão. Atualizações de consentimento em linhas existentes são vistas após espera ou aguardam a transação leitora. A inspeção não concede autorização de selecionar ou enviar com esse snapshot; o futuro emissor terá de revalidar por lote e lidar com indisponibilidade explicitamente.

## Projeção e bloqueios preservados

A resposta contém somente identidades, versões, horários, contagens por braço, hashes do material e dois bloqueios fixos:

- `external_material_unconfirmed`: material SQL não fixa bytes de anexos, personalização, configuração global, relógio/Sprig ou campos operacionais usados pelo template.
- `execution_path_not_installed`: admissão/transição/seleção próprias para público v2 ainda não estão compostas e instaladas.

Flags fixas: `authorizes_selection=false`, `authorizes_send=false`, `execution_blocked=true`, `external_dependencies_complete=false`. Snapshots completos, HTML, remetentes, headers privados, contatos e credenciais não atravessam a projeção HTTP. O hash de inspeção inclui os horários e identifica o resultado; não é uma assinatura nem token de agendamento reutilizável.

O coordenador legado ainda usa a revisão de união de listas. As guardas atuais impedem campanhas vinculadas e experimentos v2 de entrar em execução. O seletor precisa compor regras do público com braço e consentimento; os campos de conclusão/interrupção dos braços também exigem uma transição própria. Ligar `source_complete`, fornecer GUC ou chamar diretamente o scheduler antigo não resolve essas dependências e não faz parte deste módulo.

## Provas executáveis

Testes do contrato, HTTP e serviço cobrem as duas marcas, último review, consentimento, membro externo, público editado/arquivado, permissão/ownership, fonte, mínimo, material, horário inclusive microssegundos, expiração no último acesso, ACK de leitura perdido e ausência de mutações. Também comprovam refresh equivalente sem renovação de prazo e recusa de pins legados criados em fuso diferente.

`tests/ab-audience-admission-postgres.cjs` exige PostgreSQL 17.10 vazio e descartável, loopback, porta diferente de 5432 e flag de isolamento. O pool configura UTC/ISO em **todas** as conexões. Três clientes independentes mais observação demonstram: inspeção das duas marcas sem alterações; descadastro durante espera recusado; inserções externas não ampliam a alocação; associação tardia fica fora do snapshot declarado; nova revisão antes de aceitar nova elegibilidade; perda de permissão durante espera; revisão/fonte e chave vencidas na última consulta. Runtime permanece OFF, campanhas rascunho/sent=0 e transporte ausente. Registros finais da execução ficam no checkpoint privado, sem implicar aceite de produção.
