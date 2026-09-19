# Conciliação de origem no Canal TikTok

O total vem de Shop Analytics; afiliado vem de pedidos elegíveis da API de afiliados. São fontes/modelos distintos. `total − afiliado` é um saldo calculado, não comprovação de venda própria atribuída. GMV Max é outra lente e não deve ser somado a afiliado/próprio. Lives, vídeos e vitrine formam outro corte.

A projeção da API acrescenta campos sem alterar os valores de `gmv`, `gmv_afiliado`, `gmv_proprio` ou os demais campos anteriores. Não muda a view, o coletor, o grão diário, as regras de elegibilidade nem os emissores. O campo antigo `gmv_proprio` continua disponível para auditoria; a interface deve usar o novo saldo e respeitar `null`.

| Campo novo em `canal` e `canal_total` | Significado |
|---|---|
| `gmv_saldo_nao_afiliado` | Total menos afiliado, apenas quando todos os componentes do dia são conhecidos, afiliado não excede total e a soma original coincide. No período, fica `null` se qualquer dia não concilia. |
| `gmv_ajuste_origem` | Diferença assinada `total − afiliado − próprio original`. É diferença de conciliação, não receita, reembolso ou distribuição de crédito. |
| `gmv_ajuste_origem_absoluto` | Valor absoluto da diferença diária; no período, soma dos absolutos. Evita esconder divergências opostas por compensação. |
| `origem_estado` | `saldo_calculado`, `divergente` ou `indisponivel`. `divergente` prevalece no período se existir dia divergente; a contagem de dias indisponíveis continua explícita. |
| `origem_modelo` | `analytics_total_menos_pedidos_afiliados`. |
| `origem_dias_divergentes` (só total) | Quantidade de dias incompatíveis, antes da soma. |
| `origem_dias_indisponiveis` (só total) | Quantidade de dias com componente necessário ausente. |

Se algum dia tiver ajuste desconhecido, ambos os ajustes do período ficam `null`: não apresentar uma soma parcial como diferença integral. As linhas diárias conhecidas continuam auditáveis. Ausência de linha não vira dia zero nem prova de cobertura completa. Um saldo calculado compatível também não prova que as duas fontes medem populações idênticas.

Exemplo sintético: total 100, afiliado 110 e próprio original 0 → saldo `null`, diferença −10, estado divergente. A interface deve mostrar total e afiliado como lentes da fonte e a divergência; não desenhar uma composição de origem que exceda 100 nem reduzir artificialmente o afiliado a 100.

## Patch pequeno e reversível

`canal-reconciliation-patch.cjs` exporta `patchCode` e `patchWorkflow`. O segundo recebe um export recém-obtido, exige `versionId`, permite `expectedVersion` e modifica exclusivamente `Monta SQL.parameters.jsCode`. A transformação substitui apenas as duas CTEs de Canal reconhecidas. É idempotente, suporta `{remove:true}` e recusa deriva do trecho. A função não faz I/O nem publica nada.

Aplicar sobre a versão fresca e conferir um único campo alterado. Não usar um export antigo para substituir o workflow inteiro. Eventuais patches separados da janela de datas podem ser compostos porque esse gerador não toca o prefixo de validação. Depois da publicação autorizada, conferir versão ativa, contrato e leitura da mesma janela. A cobrança permanece intocada.

## Verificação isolada

- `node --test tests/tts-canal-reconciliation.test.cjs`: reversibilidade, idempotência, preservação do workflow e recusa de deriva/versão trocada.
- `CAMPAIGN_PGLITE_MODULE=/caminho/@electric-sql/pglite node tests/tts-canal-reconciliation-postgres.cjs`: PostgreSQL com dados sintéticos, valores originais preservados, compatibilidade por dia, período, diferenças opostas, nulos/zeros, marca e janela.

Nenhum export privado ou métrica real é necessário para executar os testes.
