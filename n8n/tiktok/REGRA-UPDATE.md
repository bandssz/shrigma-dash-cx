# Edição atômica de regras TikTok

`regra-update.sql` adiciona somente `crm_tts_regra_patch_v1`. A instalação não altera regras, modos, reservas, logs nem coletores. O endpoint continua exigindo autenticação de escrita no servidor.

A função bloqueia a linha por marca, combina somente os campos recebidos com a regra vigente e valida o resultado completo antes de um único UPDATE. Assim, alterar apenas um limite também respeita `gmv_manual <= gmv_auto`. Tipos JSON são estritos; nulos, booleanos, números em texto, campos desconhecidos e frações em limites inteiros são recusados. O padrão de SKU e demais campos não editáveis permanecem intactos.

`esperado_atualizado_em` é a representação exata do timestamp devolvido pela leitura; não deve passar por `Date` nem perder microssegundos. É obrigatório quando o patch inclui um modo. Quando informado para qualquer patch, divergência recusa a operação e devolve a regra atual. Patches numéricos sem versão continuam sendo validados contra a linha atual sob lock.

Ativação (`modo` ou `cobranca_modo = ativo`) é recusada enquanto as guardas operacionais estiverem pendentes. Não há flag de liberação neste contrato. Um modo ativo já existente não é alterado por um patch que não o inclua. A UI envia apenas valores alterados, preserva a versão da leitura usada pelo formulário, explica a indisponibilidade de ativação e mostra a regra devolvida em recusas.

O resultado JSON contém `ok`, `codigo`, `mensagem`, `regra_atual`, `linhas` e, nas recusas, `erro`. Uma recusa lógica não faz UPDATE, inclusive dos campos de auditoria. A resposta HTTP é calculada a partir do resultado de PostgreSQL, nunca de um sucesso antecipado no node de preparação. Resultado ausente é erro; não é confirmação de gravação.

## Preparação e implantação

1. Exportar o workflow de ação atual para armazenamento privado. Nunca versionar export, segredo ou resposta com dados operacionais.
2. Conferir a credencial PostgreSQL do node `Grava` e a usada na instalação. A função é `SECURITY INVOKER`, com `search_path` fixo. `PUBLIC` não recebe EXECUTE. O owner mantém execução; se os papéis forem diferentes, conceder EXECUTE apenas ao papel de serviço conferido, preservando permissões das tabelas.
3. Instalar apenas esta migração incremental. Não executar seeds ou o DDL histórico inteiro.
4. Aplicar `patchWorkflow(fresh,{expectedVersion})` de `regra-action-patch.cjs` sobre o export fresco. O patch preserva autenticação, assinatura, aprovação manual, credenciais, ligações e demais nodes. Muda a validação de regra, a preparação de consulta parametrizada, os parâmetros nativos do PostgreSQL e a resposta. Conferir a versão novamente antes de publicar.
5. A UI só habilita edição após uma leitura viva com `regra_contrato=atomic_v1`; cache, falha de atualização ou contrato ausente mantém os botões indisponíveis. Publicar a descoberta com `regra-contract-patch.cjs` somente depois de conferir SQL, ação ativa e recusa inofensiva real. A leitura fornece a versão em `regra`, mesmo quando o subconjunto `cobranca_regra` não a contém.
6. Conferir o código ativo e a resposta sem ativar rotinas ou alterar limites operacionais apenas para produzir evidência.

A etapa de Token Manager continua no caminho antigo; este patch não modifica transporte. Falha de banco/rede sem recibo continua exigindo releitura e conciliação, sem retentativa automática. A função não promete entrega comercial nem torna a cobrança segura para ativação.

## Testes

- `node --test tests/tts-regra-action.test.cjs`: VM sem HTTP real; tipos, parâmetros, resultado recusado, compatibilidade da resposta de revisão, preservação do patch, estado da UI.
- `CAMPAIGN_PGLITE_MODULE=/caminho/@electric-sql/pglite node tests/tts-regra-postgres.cjs`: PostgreSQL isolado, instalação repetida sem mutação, regras parciais, tipos, versões, rejeição com linha atual, guardas de modo, rollback e permissões.
- `TEST_DATABASE_URL=... TTS_TEST_DATABASE_ISOLATED=1 node tests/tts-regra-concurrency-postgres.cjs`: duas conexões independentes. Exige banco descartável vazio com nome `tts_regra_test` (ou sufixo sintético). O teste observa espera real por lock, recusa patch incompatível após o primeiro commit, preserva atualizações válidas distintas e recusa modo baseado em versão antiga. Não usar banco de aplicação.

O job de CI usa serviço PostgreSQL descartável e dados sintéticos, sem credenciais de aplicação. PGlite não substitui a prova de disputa entre sessões.
