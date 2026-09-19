# Guardas da cobrança: candidato v2

**Código e SQL para revisão; ainda não integrados ao workflow.** O sender legado não é alterado por importar estes arquivos. A instalação só pode ocorrer com todas as regras de cobrança pausadas. Publicar o código não autoriza ativação nem comprova execução/entrega.

## Componentes

- `cobranca-safety.sql`: quatro tabelas novas e funções, em transação. Não altera tabelas/PKs antigas e não apaga logs, simulações ou reservas. Repetição da instalação exige pausa novamente.
- `cobranca-safety.cjs`: orquestração com adaptadores explícitos de SQL parametrizado e transporte. Não contém rede, endpoint, credencial ou retentativa automática.
- `tests/tts-cobranca-safety.test.cjs`: VM sem rede ou módulos externos, com transporte em memória.
- `tests/tts-cobranca-safety-postgres.cjs`: PostgreSQL isolado via PGlite, DDL real e dados sintéticos. Chamadas concorrentes são enfileiradas pela conexão embarcada; disputa entre sessões independentes de PostgreSQL permanece no aceite de implantação.

## Identidade e revisão

A tentativa mantém o grão existente **marca × etapa × username × tentativa**, com unicidade adicional **marca × etapa × creator_open_id × tentativa**. A referência exata de convite/amostra é auditada, mas não cria outra sequência. Trocar referência, dono da execução ou etapa não permite contornar uma reserva pendente/incerta da pessoa.

Uma revisão contém o texto final aprovado, modelo original vigente, referência, identidade, tentativa, timestamp exato do snapshot, revisor e validade. O claim conserva uma cópia integral da revisão. Revisão alterada/revogada/expirada, identidade contraditória, referência ausente, mudança da fonte, produção de conteúdo, estado inelegível, modelo mudado ou supressão bloqueiam. A mesma conferência ocorre antes de iniciar o transporte da mensagem.

O gate preserva os estados elegíveis da fonte existente (`SHIPPED`/`CONTENT_PENDING` para amostra; vitrine presente sem conteúdo para convite). **Isso não transforma SHIPPED em recebimento comprovado.** Não há novo cálculo de prazo de entrega ou idade desde recebimento. A aprovação de copy e elegibilidade operacional da amostra continua necessária; a função não inventa esse dado.

Qualquer registro legado real da pessoa, inclusive erro, exige conciliação específica antes do v2. Não se presume que o erro antigo impediu envio. Simulações legadas não bloqueiam o ledger novo e permanecem intactas.

## Reserva e estados

O claim trava a regra da marca no PostgreSQL, confere o teto e reserva atomicamente. O teto considera todas as reservas do dia e registros legados reais do dia, incluindo falhas. Esse cálculo conservador não devolve automaticamente vagas de operações bloqueadas. A trava por pessoa vale entre etapas; o intervalo também vale entre etapas.

`reservado → em_transporte → aceito | incerto`

Antes de transporte, a reserva pode terminar `bloqueado`. Falha ou resultado ambíguo no preflight também pode terminar `incerto`. Nenhum estado terminal é reaberto automaticamente. `aceito` significa apenas aceite da API; não significa entrega. Só tentativas aceitas permitem avançar a sequência, respeitando intervalo e nova revisão. Uma tentativa bloqueada fica congelada até existir um procedimento explícito de revisão; não se apaga sua reserva para fazê-la renascer.

Timeout/crash após o começo do transporte mantém `em_transporte` ou `incerto`, ambos impeditivos de repetição. Falha ao persistir o resultado não dispara nova chamada. Não há troca de chave para tentar contornar incerteza. A resolução auditável de reservas bloqueadas/incertas não faz parte deste primeiro candidato e é requisito de operação antes de ativar.

As funções rodam como invocador, com `search_path` fixo. O acesso público às novas tabelas, sequência e funções é revogado. Conceder acesso somente ao papel de serviço conferido, sem permissões anônimas e sem colocar SQL genérico à disposição do navegador.

## Conversa: falha bloqueia

A abertura precisa retornar identidade, username correspondente, `is_new` booleano e contagem conhecida de não lidas. Não lidas bloqueiam mesmo sem mensagens na lista. A leitura precisa de código de sucesso e array válido; conversa existente vazia é desconhecida, não “sem resposta”. Mensagem de tipo/sender/timestamp desconhecido bloqueia. Timestamp aceita número finito positivo ou sua representação decimal estrita; booleano, objeto, array, vazio e texto com coerção não viram uma mensagem antiga.

Qualquer resposta do criador no histórico retornado exige tratamento humano, inclusive antiga. A idade da resposta não prova consentimento nem ausência de opt-out. Mensagem recente da loja também bloqueia. O guardião não faz NLP para presumir consentimento; a supressão permanente deve ser registrada pelo fluxo autorizado de operação. O adaptador de leitura deve esgotar a paginação e devolver `coverage: {complete: true, conversation_id}` vinculado à conversa exata. Ausência, falso, identidade diferente ou indicação nativa contraditória de mais páginas bloqueiam antes de dispatch. O adaptador real e a evidência dessa cobertura ainda precisam de implementação/validação; a flag não pode vir do navegador nem ser inferida de lista vazia. Ingestão de opt-out continua necessária.

## Contrato de integração

`createPostgresStore(query)` recebe `query(sql, params)` e usa somente parâmetros separados. **Cada método deve concluir e confirmar uma transação autônoma antes de resolver a Promise**. Não envolver transporte externo na mesma transação ainda aberta; retorno da função dentro de um `BEGIN` pendente não é reserva durável.

`executeIntent({reviewId, owner, simulate}, {store, transport, now})` usa dono UUID estável da execução. Adaptadores de transporte expõem `openConversation`, `readMessages` e `sendMessage`; devem retornar respostas estruturadas sem normalizar ausência para zero. Antes de liberar `sendMessage`, o recibo do dispatch deve confirmar `state=em_transporte`, `review_id` e `owner` idênticos aos da operação. Recibo ausente, incompleto ou contraditório preserva a reserva e retorna incerto sem transporte nem escrita terminal presumida. Somente texto/identidade aprovados vindos do claim são enviados. Simulação chama exclusivamente a função/tabela separada e nunca consulta transporte nem reserva vaga real.

Antes de implantação: export fresco; impedir que o sender legado possa executar quando a regra for ativada; ligar revisão/autenticação/supressão/UI e SQL parametrizado; verificar commit anterior ao transporte; testar disputa entre sessões e crash em cada fronteira; verificar telemetria e resolução operacional de bloqueio/incerto. A API e UI precisam exibir os novos estados; o log antigo não é automaticamente atualizado nem renomeado.

## Execução dos testes

```sh
node --test tests/tts-cobranca-safety.test.cjs
CAMPAIGN_PGLITE_MODULE=/caminho/@electric-sql/pglite node tests/tts-cobranca-safety-postgres.cjs
```

Os testes não dependem de acesso TikTok, dados de clientes ou snapshots privados.
