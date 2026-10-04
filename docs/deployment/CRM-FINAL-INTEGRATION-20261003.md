# Integração CRM e migração — estado em 03/10/2026

## Instalação preservada

O V24 segue `f58dfa7333c9e2b66d0e39023eb3ea39bc5802ea`, imagem `ghcr.io/bandssz/shrigma-dash-operational-canary@sha256:9d25e5d9d78ba5734f9b7a008f6d512becc95d91402d92eaddc62c5ebc669705`, saudável na última consulta MCP e com configuração preservada. A identidade copiada do V23 mantém senha mestre, SQLite e dados cifrados. Verificações HTTPS anônimas não comprovam login humano, usuários individuais ou CRUD real.

READ/provisionamento/interface individual, WRITER e CREATE permanecem OFF; somente o upstream crm-read está configurado. Hosts de teste: [gerencial](https://dashboard-v24-gerencial.tazdb8.easypanel.host), [CRM](https://dashboard-v24-crm.tazdb8.easypanel.host), [Orgânico](https://dashboard-v24-organico.tazdb8.easypanel.host) e [Influs](https://dashboard-v24-influs.tazdb8.easypanel.host). Os quatro domínios finais, V22/V23, oito serviços comunicacao e131 mapeamentos anteriores estão preservados.

READ V3 vazio/inativo já foi instalado no escopo expressamente aprovado: perfil `4f5b8bdec729d2924c043da6bd3c0f8f2ce01a82af614187cefa1322ecef11c9`, quatro tabelas vazias, sete funções, dois índices e dois papéis NOLOGIN. O provisioner NOLOGIN recebe schema USAGE/quatro RPCs; permissões nas tabelas pertencem ao owner NOLOGIN das funções. O instalador está parado/desabilitado com ambiente vazio observado. Isso não autoriza LOGIN, issuer, gestores, WRITER ou flags. O orçamento PostgreSQL500ms não limita a duração física da interrupção/limpeza.

## Fonte exclusiva e trabalho dividido

Produção conferida: `565ab590ecbbaf021a05fdaa31bb570246ad52b3`. A pasta principal repo continua na branch `codex/growth-reliability-20260924`, commit `552541830cf0c910725625c9f7fb76a2547d006f`. Somente o worktree/branch `codex/dashboard-candidate-crm-fix-20261002` recebe esta preparação. Não houve stash/reset/merge/push de produção nem mudança do CX.

A [PR214](https://github.com/bandssz/shrigma-dash-cx/pull/214) prepara login por e-mail/senha, permissões por área, identidades READ e FULL separadas, CREATE durável, edição de rascunho, conferência e agendamento/cancelamento. A intenção precede POST; timeout/404/reload consultam a tentativa original por GET, sem repetir POST. Consultar STATUS com WRITER ainda válido após expiração READ não abre catálogo nem novos POSTs. Um GET recusado não apaga recibo terminal confirmado.

CREATE tem gate próprio, OFF e dependente do WRITER FULL/caps4. READ conserva caps3/can_edit0. Gestor READ pode solicitar edição sem trocar senha/sessão; aprovação administrativa e atestação precedem a concessão efetiva. Renovação é manual14d, preserva reservas/diários e é bloqueada por tentativas abertas. Revogação WRITER precede troca READ; nenhuma chave mestre é compartilhada nem renovação automática é criada.

| Entrega | Fonte incorporada/pendência |
| --- | --- |
| #216/#217 | Correções CRM consolidadas; PR217/Pages aguarda autorização específica de merge/publicação |
| #218 `7662fce` | Segurança R1–R5, duas abas e trilha OFF incorporadas |
| #219 `51d610b`/`82875be` | Pontes próprias READ de público/listas/mídia/templates; delta do validador já incorporado |
| #220 `3f8d805` | Recuperação restrita de agendar/cancelar com lápide/lease incorporada, sem SQL/ativação reais |
| #221 `060b013` | Frontend por marca incorporado e bundle reproduzido; contrato crm-template-read-v1 OFF |
| #222 `ecc511e4251f74158d40b4f1e5fc9e1bb21d0714` | Listener não incorporado; dois bloqueadores abertos |

Audience tem ponte READ própria; o GET legado com refresh/locks não vale como READ ONLY. Mídia recusa outra marca e eco de credencial; arquivos explicitamente legados são rotulados/contados sem atribuição falsa. O servidor de campanhas com filtro por marca exige imagem nova: a candidata23e472ab ainda não substituiu o backend instalado.

Na #222, a revisão reproduziu liberação da vaga HTTP enquanto a transação/conexão continua ativa, e aceitação de eco codificado da credencial. O [direcionamento](https://github.com/bandssz/shrigma-dash-cx/pull/222#issuecomment-5974202110) pede correções/regressões, revisão OCI e admissão PostgreSQL/SCRAM. Claude mantém listener/docs/testes; Codex mantém BFF, identidade, CI e Easypanel. Sem edições concorrentes desses arquivos. Compradores e melhorias Orgânico/Influs ficam após o aceite CRM.

## Validação da candidata

A última CI terminal registrada antes deste lote é [37166846830](https://github.com/bandssz/shrigma-dash-cx/actions/runs/37166846830), head `1fcc8572309d54f65ad2838884ca2abdf8104a9b`:12 validações aprovadas, três publicadores ignorados. Inclui pacote/build, OCI, PostgreSQL16/17, instalação/reversão V3, READ, WRITER, cinco fixtures Claude e broker WRITER. As instâncias PostgreSQL são descartáveis; não houve acesso ao banco instalado.

O broker WRITER novo vem OFF sem pg/pool/segredo. A imagem própria foi exercitada com CMD real OFF; a prova composta com fontes fechadas/PostgreSQL17.10 admite SCRAM/catálogo/quatro RPCs em isolamento. Isso não admite a imagem ON no servidor. A prova OCI pública READ confirmou nove fontes RO, UID1000, rede none, limites, transferência dos volumes, dois GET separados por stop/start público e limpeza própria, com postgresConnected/applicationStarted false.

Pacote operacional:56 arquivos,30 públicos/26 runtime,794024 bytes (teto950000), seed806389 (teto960000), expansão2570229 (teto16MiB), SHA `f32a9fee8774eef86f33457251e869a93cd573ee13c36613b05efbc23380010c`. Famílias completas anteriores48/53 continuam admitidas e conjuntos parciais recusados. Nenhum teto ampliado.

O lote atual é somente ferramentas OFF, fora desse pacote: acrescenta o driver de processo/bootstrap privado e a opção literal de projeto fixo novo, mantendo defaults e recursos. Quatorze arquivos passaram121/121 com Node22/ambiente limpo/guard de rede e processo. Revisões independentes não encontraram bloqueador de fonte. Um TTY real com credenciais fictícias chegou a uma QUERY simulada e recusou a admissão, sem MCP/mutação/PG. A CI deste novo head só será afirmada após resultado terminal; este lote não pede imagem/publicação/deploy.

## Caminho MCP preparado e seus limites

A cápsula RSA4096/AES-GCM é retida/fsync/reaberta antes de qualquer RPC. Plano/adapter usam alvo/domínio novo exatos, recusa de colisão e intenção durável anterior ao efeito. Create MCP pode auto-deploy: o bootstrap é público, sem banco/credencial. Duas barreiras públicas conferem fontes/montagens/UID/ledger e stop/start aplica somente ao observador. Depois ocorre um único deploy privado. ACK incerto conserva cápsula/IDs/fences e exige reconcile original, sem nova intenção ou repetição automática.

A ponte Node↔functions admite somente kind:mcp, scopes/argumentos literais e envelopes correlatos. O DTO MCP privado é materializado apenas na fronteira interna; projeção pública não serve para configurar env. Houve uma única consulta nativa listDomains V24 por essa ponte: quatro domínios,seq1/responded,Nodeexit0,mutações0/PGfalse; prova externa SHA `aed3ef368f49fa75d4ded25210a3708442c8963f6f308258d75c267920922309`. Ela comprova essa QUERY, não o processo StageRunner privado.

Readbacks públicos78093/7903/1937 bytes chegaram completos com reader/hash/exit0 no contexto da ferramenta, sem MCP/PG. Não foi necessário dividir conteúdo; truncamento futuro continua recusa/unknown. Isso não comprova aceitação de mutação MCP com esses frames.

O StageRunner injeta callbacks fechados de admissão, senha administrativa e observação. O reader HTTPS só aceita os dois contratos GET/status vinculados ao plano e projeta saída validada; seus testes não fazem TLS/GET real. O driver reconstrói o plano, recebe o bootstrap privado e exige scopes exatos antes de ACK0; sua prova de processo usa somente credenciais fictícias. Ainda faltam providers reais de binding/admissão/GET e prova específica desse transporte antes de apresentar o stage crítico.

A opção isolada seleciona apenas `crm-manager-stage-20261004`; não cria esse projeto e mantém a rede externa compartilhada easypanel do gateway. O MCP confirmou que esse nome ainda não existe na consulta registrada, mas não forneceu inventário limitado de serviços. `inspectComposeService`404 não é ausência de alvo: um App existente devolveu a mesma resposta. Projeto presente em listProjects não é prova de vazio. Nenhum gate verdadeiro é inferido desses erros. Reconcile herda o projeto original e não permite converter plano/cápsula legados para o projeto novo.

O catálogo MCP consultado não forneceu inventário global de volumes. V1 exige ausência observada; a nova V2 somente execute registra existência unobserved/ausência false e exige namespace128 derivado dos IDs, nomes próprios e demais gates. Nomes fortes reduzem colisão, sem provar ausência: volume estrangeiro vazio root0755 ainda pode ser preenchido. Não reutilizar IDs, importar/reinterpretar plano48 ou regenerar intenção após ACK incerto. Reconcile usa somente V1/volumes originais/fonte-ledger-quiescência previamente observados. Não há inventário global nem registro global de intenções.

Quiescência MCP comprova apenas disabled/envempty/zero containers RUNNING/domínio próprio ausente, preservando volumes. Não prova exit0 do initializer remoto, ausência de containers parados ou limpeza forense de task-env. PostgreSQL17.10 instalado segue SSLoff e rede compartilhada, com PUBLIC/HBA herdados; não afirmar firewall ou privilégio exclusivo. Segredos podem constar em registros privados internos de ferramentas. Custódia da chave de recuperação fora deste Mac não foi provada.

## Prioridades e aceite

1. **CRM publicado hoje:** PR217/Pages ainda requer aprovação específica pendente. Após a liberação, conferir listas/públicos, troca de marcas, conferência/agenda e templates no frontend real, preservando campanhas existentes. O backend de mídia tem liberação separada.
2. **Stage individual READ inativo:** fechar processo/admissão/transporte e apresentar LOGIN/SCRAM/issuer com escopo e reversão concretos. READ V3 instalado não autoriza essa próxima alteração.
3. **Aceite no portal:** ativação separada; provar mestre e um gestor real, área/marca, revogação, renovação, isolamento e edição controlada FULL/CREATE. Templates/upload/edição geral de mídia seguem pendentes. IAM comum existe em Orgânico/Influs, mas issuerCRM não cria seus principals; edição bloqueada e revogação do portal não revoga a origem.
4. **Corte e reversão:** backup cifrado/restore, aceite por área e aprovação explícita dos quatro domínios finais. Guardar digests/mapeamentos/identidades anteriores.

Nenhum merge/main, publicação, SQL novo, usuário, campanha/envio ou tráfego real pertence a este lote. Em falha, restaurar mapeamentos/digests anteriores sem sobrescrever identidades. Reconciliar/revogar lifecycles novos antes de desativar issuer/LOGIN. Reversão SQL vazia exige estrutura comprovadamente vazia/inativa; não executar DROP automático após uso ou resultado incerto.
