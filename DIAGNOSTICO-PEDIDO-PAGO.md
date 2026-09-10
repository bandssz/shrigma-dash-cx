# Diagnóstico de pedido pago — Growth

Página auxiliar: `growth-diagnostico.html`. Mantém o painel principal e as automações existentes intactos.

Usa somente o GET Growth já configurado em `config.js`, com a mesma chave de leitura salva no navegador. Não contém chave no código, não publica template, não muda modo e não envia nem reenvia mensagem. O ambiente de testes usa apenas fixtures sintéticas.

## O que distingue

A configuração de pedido pago da marca, o motor compartilhado e o template Utility são avaliados separadamente. O modo de rastreio não substitui o de pagamento. Ausência de dados, duplicatas, coleta vencida, falha de atualização ou alterações não publicadas não comprovam modo real em execução. Um estado `new`/`stopped` da última execução retida não é usado para afirmar estado atual da fila.

O histórico filtra `flow=transacional`, `piece=pedido-pago`, marca e período em Brasília. Registros, aceites, entregas, leituras, falhas, rejeições e pendências permanecem distintos; leituras já estão contidas em entregas. Campo ou cobertura ausente vira `null`/“—”, não zero. Entrega no intervalo não comprova o envio de um pedido específico nem que ocorreu após o corte de outro fornecedor.

O modelo aceita a extensão opcional `config_collection` de R1 quando presente e válida. Isso não afirma que a extensão foi implantada no backend; na ausência dela, usa o contrato atual. Nenhum campo proposto é simulado no ambiente real.

## Exportação

“Exportar diagnóstico” produz um JSON com whitelist de contagens, estados derivados e datas. Não exporta a resposta bruta, chave, telefone, e-mail, número de pedido, nome/corpo de template nem IDs internos de workflow. O relatório preserva a data da resposta, a data do inventário, o período e a indicação de falha na última consulta.

## Limite operacional

O GET agregado não identifica por que um pedido individual deixou de enviar. Para corrigir esse caso, ainda é necessário acesso autorizado ao evento da origem, à versão executada, à elegibilidade/opt-out/deduplicação e ao resultado do motor. Esta página não fecha esse diagnóstico nem autoriza reenvio.

## Testes

Regras puras: `node --test tests/growth-diagnostic.test.cjs`.

Suíte completa, incluindo os testes DOM existentes:

```sh
npm install --prefix ../growth-test-tools --no-save --ignore-scripts --no-audit --no-fund linkedom@0.18.12
node --test tests/*.test.cjs
```

A rotina GitHub Actions `Growth regression` executa a suíte em pull requests com acesso somente de leitura ao repositório. Não recebe credenciais operacionais nem chama produção.
