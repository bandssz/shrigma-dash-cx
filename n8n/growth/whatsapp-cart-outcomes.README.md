# Fonte de resultados WhatsApp — instalada; holdout desabilitado

Fonte instalada em 24/09/2026 para eliminar a dependência de UTM e dos logs de mensagens
na medição do carrinho. **Workflow `GLq3bWhggmVFlH1X` ativo, com primeira ingestão real de
82 pedidos e agendamentos habilitados às 22h54 BRT.** A execução automática dos agendamentos
ainda não foi observada. O holdout continua **não instalado e não ativado**.

O gerador mantém `active:false` e a configuração SQL nasce `enabled=false`; a publicação
e a habilitação da fonte ocorreram em etapas conferidas. Não toca CX, atribuição,
coletores de parceiros, login, cache ou entrada WhatsApp.

## O que coleta e o que mede

O coletor lê todos os pedidos Fish/Aristo no intervalo solicitado, inclusive pendentes,
cancelados, reembolsados e sem UTM. Não seleciona apenas pedidos atribuídos a marketing.
A API `orders` fornece filtros por criação/atualização, ordenação e paginação; a consulta
usa o sort correspondente ao filtro. [Documentação Shopify](https://shopify.dev/docs/api/admin-graphql/2026-07/queries/orders).

**O estimando do relatório é mais estreito que “todo pagamento no período”:** conta
pedidos criados **e com a última captura/venda positiva concluída** dentro da janela
após a primeira elegibilidade da pessoa/marca. Pedido criado antes e pago depois fica
fora. Essa definição e a duração da janela precisam ser fixadas no protocolo antes do
lançamento. O código não escolhe nem ativa uma duração de experimento.

A receita usa `netPaymentSet`: recebido menos reembolsado, na moeda da loja. Os valores
são armazenados em centavos inteiros. Reembolsos conhecidos até a coleta mais recente
reduzem a receita, inclusive se chegaram após o fim da janela; não é um saldo congelado
no momento do fechamento da janela. [Campos do pedido](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/Order).

`first_payment_at` e `paid_at` preservam a primeira e a última SALE/CAPTURE positiva
bem-sucedida. A soma das capturas precisa bater com recebido. Quando as capturas cruzam
o fim da janela, o resultado fica desconhecido: não é possível distinguir com esse
snapshot um parcelamento concluído tarde de um pedido já pago que recebeu cobrança
adicional. Isso impede transformar uma compra anterior em “zero” por edição posterior.

`confirmed_paid_orders` conta pedidos; `confirmed_buyers` e `complete_buyers` contam
pessoas com pelo menos um pedido. O denominador inclui todos os alocados. Uma pessoa
com vários carrinhos/pedidos aparece uma vez no denominador. Nenhuma conclusão causal,
lift ou taxa pronta é emitida. Valores confirmados são parciais quando `unknown>0`;
`complete_net_cents=null` não deve ser convertido em zero.

## Identidade e privacidade

O telefone normalizado usa a mesma chave do holdout:
`md5(allocation_salt + '|' + brand + '|' + telefone_brasileiro_normalizado)`.
Um número local só ganha prefixo55 quando o endereço confirma Brasil. Telefone do pedido,
entrega e cobrança, quando fornecidos, precisam convergir; ausência, formato inválido ou
conflito geram identidade desconhecida. Não se escolhe silenciosamente um destinatário.

O runtime não permite `require('crypto')`. O gerador usa três nós Crypto nativos:
SHA256 da consulta, MD5 da identidade e SHA256 da revisão. Uma prova sintética autenticada
confirmou os dois algoritmos e preservação de campos no runtime, sem mudar configuração
global. Os valores transitórios com telefone são removidos após MD5; após SHA256 sobram
apenas campos permitidos e pseudônimos. SQL rejeita campos extras como telefone/e-mail.
Credenciais permanecem no cofre n8n, com destinos fixos `*.myshopify.com`; redirects são
desativados. Sucesso, erro e execução manual não salvam dados de execução.

O telefone ainda existe transitoriamente na resposta HTTP e no nó anterior ao hash;
os hashes não eliminam essa leitura necessária. Não salvar exports de execução real
com clientes. Logs, recibos e provas finais devem conter somente agregados.

## Completude, revisões e reconciliação

Cada janela executa contagem exata inicial, todas as páginas e contagem exata final.
Só aceita `EXACT` e total único igual às duas contagens; limite atingido, cursor parado,
pedido alterado durante a varredura, erro/escopo negado ou mudança de contagem interrompem
a prova de cobertura. A contagem usa `limit:null`; limites locais continuam obrigatórios.
[Documentação de ordersCount](https://shopify.dev/docs/api/admin-graphql/2026-07/queries/ordersCount).

- Incremental: `updated_at`, watermark de execução completa e sobreposição de10min.
- Reconciliação: `created_at`, incluindo novamente os pedidos da janela e seus
  estados financeiros atuais. Isso recupera lacunas da ordenação mutável e reembolsos.
- O banco mantém revisão normalizada e snapshot por `(brand,order_id)`. Revisão antiga
  não sobrescreve nova; mesma data da fonte com conteúdo diferente gera conflito.
- Uma reconciliação completa que deixa de encontrar pedido anteriormente salvo marca
  `source_missing`; o valor antigo não sustenta uma receita “medida”. Reaparecimento
  confirmado por reconciliação posterior limpa essa marca. Não se apaga histórico.
- Ingestão é idempotente por `run_id`/payload, com transação e serialização por marca.
  Scans incompletos registram o motivo, mas não substituem os snapshots de pedidos.

O relatório exige janela madura e união **sem lacunas** de reconciliações completas,
posteriores ao fim da janela, com o mesmo sal e coleta recente. A validade padrão da
fonte é24h, configurável na função. Pedidos com identidade/financeiro desconhecidos,
moeda diferente deBRL, revisão de identidade ou desaparecimento mantêm o resultado
desconhecido. Não conhecer uma compra não comprova ausência de compra.

`report_v1` recusa mais de1.000 linhas de coorte por chamada. Para lotes maiores, dividir
por pessoas/marca distintas, mantendo os mesmos `as_of`, janela e sal em todas as páginas;
não truncar a coorte nem duplicar pessoas entre páginas. A função não faz paginação ou
conclusão por conta própria.

## Capacidade e progresso

O planejamento fraciona em2h por padrão, configurável para15/30/60/120min. Retorna no
máximo4 jobs, no máximo2 de cada marca, priorizando nunca coletados e a conclusão mais
antiga. Reconciliações completas há menos de12h são omitidas. Assim o limite não prende
o fluxo nos primeiros dias da Aristo nem impede o progresso da Fish.

Cada job limita500 pedidos,6 páginas,512.000 caracteres de estado e1.024.000 caracteres
da resposta processada. Mais que500 na contagem exige reduzir a janela; não produz
cobertura falsa. Uma resposta grande é barrada antes de se propagar aos nós de hash,
embora o cliente HTTP já tenha recebido seu buffer inicial.

O runtime agenda incremental no minuto 17 de cada hora e reconciliação nos minutos
07/22/37/52, com timezone `America/Sao_Paulo`. Os dois agendamentos estão habilitados;
o gerador, por segurança, continua produzindo um workflow inicialmente inativo.
Com9dias×12janelas×2marcas, são216 janelas; quatro a cada15min percorrem um ciclo em13,5h
sem falhas. `initial_since='2026-09-24T00:00:00Z'` significa **23/09 às 21h BRT**:
a coleta não solicita história anterior a esse instante, mas inclui as três últimas
horas de 23/09 no horário brasileiro. A cobertura efetivamente gravada ainda é parcial.
Fish não tem `read_all_orders`; não ampliar retrospectiva para além dos60dias permitidos
sem verificar acesso. A prova real abaixo confirmou os campos de telefone/endereço e
financeiros solicitados nas duas marcas, dentro da janela pequena consultada.

Simulação do grafo de500 pedidos/5 páginas, contando outputs serializados de HTTP,
Code, Crypto e IF: **7.826.285bytes por job;31.305.140bytes para4 jobs**. É uma medição
da fixture, não RSS do processo ou garantia para qualquer payload. A suíte impõe teto
de48MiB para essa fixture de4 jobs e evita copiar o estado cumulativo para cada pedido.
A leitura real pequena foi comprovada; carga de execução agendada e RSS continuam sem
prova, especialmente enquanto o incidente de execuções longas está em investigação.

## Arquivos e validação

- `whatsapp-cart-outcomes.cjs`: consultas, normalização, fases e limite de memória.
- `whatsapp-cart-outcomes.sql`: configuração, planejamento, fonte, revisões e relatório.
- `whatsapp-cart-outcomes-workflow.cjs`: gerador isolado; caminho de prova retorna apenas
  agregados com `dry_run:true` e zero escrita na fonte.
- `tests/whatsapp-cart-outcomes*.test.cjs`:14 testes aprovados, incluindo pipeline nativo
  sem require, linking explícito de páginas, reembolsos, membro ausente,
  pagamento que cruza janela,12intervalos sem lacunas, fairness, retomada e coorte limitada.

As duas consultas foram validadas no schema oficial2026-07 (artefato
`16d317d7-6050-4e01-9eb4-087c58575731`, revisão2), além da revisão independente.
Uma primeira prova integrada de leitura falhou HTTP500 e foi removida. Uma fixture
sintética posterior, sem Shopify/SQL, identificou a causa no runtime: `structuredClone`
não existe no Code (`ReferenceError` no primeiro `accept`), enquanto `BigInt` existe.
A biblioteca passou a clonar seu estado JSON com `JSON.parse(JSON.stringify(...))`.
A suíte agora não injeta `structuredClone` nem `Date` do host, evitando mascarar novamente
essa incompatibilidade; os14 testes específicos passaram após a correção.

Após a correção, a segunda prova integrada passou no n8n em24/09/2026 às22:38BRT.
Usou o grafo gerado, sem agendamentos ou SQL, com dois jobs fixos `dry_run:true` e
janela de criação **24/09,20:15–22:15BRT**. Cada marca tinha teto de100 pedidos e uma
página; contagem antes/depois, HTTP, três nós Crypto nativos, remoção dos transitórios,
linking por `$items`/`$runIndex` e avanço entre consultas/marcas executaram no runtime.
Essa primeira prova bem-sucedida leu **63 pedidos e não gravou a fonte**. O resumo
continha somente agregados:

| Marca | Pedidos / contagem inicial e final | Identidade válida | Inválida | Ausente / conflitante | Financeiro desconhecido |
|---|---:|---:|---:|---:|---:|
| Aristo |56 /56 /56|55|1|0 /0|0|
| Fish |7 /7 /7|7|0|0 /0|0|

A prova confirmou acesso às consultas `ordersCount` e `orders`, incluindo os campos
de telefone/endereço e `transactions` pedidos pelo candidato. Nenhum pedido, telefone,
hash de identidade ou valor financeiro individual foi salvo nos recibos. A chamada
sem autenticação recebeu403; versão ativa, nós e conexões foram conferidos antes da
execução. O temporário foi desativado/removido com leitura posterior404, e o coletor
financeiro de parceiros permaneceu idêntico antes/depois.

Essa prova usou uma página por marca: paginação maior, casos ausentes/conflitantes e
outros estados financeiros continuam cobertos pelas fixtures, sem comprovação real
nesta amostra. Isoladamente, não prova ingestão SQL, cobertura histórica, reconciliação
agendada ou consumo máximo de memória. Fish continua sem acesso comprovado a pedidos com mais de
60dias. O harness alterou apenas as entradas, os resumos de sucesso/falha e uma guarda
para impedir segunda página; preservou as etapas de coleta, hash e linking.

Recibos privados em `.private/runtime/growth-audit-20260924/bloco2-shopify/`:
`outcomes-probe-v2-result.json`, `outcomes-probe-v2-lifecycle.json` e
`outcomes-probe-v2-diff.json`. A primeira falha e a fixture de diagnóstico também foram
preservadas, sem reutilizar os arquivos da primeira execução.

## Instalação e primeira ingestão em produção

O SQL foi instalado às 22h43 BRT de 24/09: quatro tabelas exclusivas da fonte e três
corpos de função conferidos, inicialmente com tabelas de dados vazias e flags das
duas marcas desligadas. O workflow `GLq3bWhggmVFlH1X` foi criado inativo e publicado
com **apenas os dois ScheduleTrigger pausados**, mantendo o restante do gerador.

Um caller temporário autenticado chamou a fonte pelo nó nativo ExecuteWorkflow,
aguardando a conclusão e enviando somente `{probe:false,mode:'reconcile'}`. Com as
flags desligadas, a chamada das 22h50 devolveu `jobs:0` e manteve os dados vazios:
comprovou ligação, entrada e acesso ao banco sem consultar pedidos Shopify.

Após habilitar somente as flags da fonte, a chamada controlada das 22h53 concluiu
**quatro janelas, 82 pedidos e 82 gravações**, ainda com os agendamentos pausados.
O readback do banco confirmou quatro runs completos, 82 pedidos e 82 revisões,
sem identidade ausente/inválida/conflitante, financeiro desconhecido ou campos
normalizados inesperados:

| Marca | Janelas completas | Pedidos gravados | Identidades válidas | Financeiro desconhecido |
|---|---:|---:|---:|---:|
| Aristo |2|61|61|0|
| Fish |2|21|21|0|

As duas marcas cobriram **24/09, 00h–04h UTC**, equivalente a **23/09, 21h–24/09, 01h BRT**.
São duas janelas contíguas de 2h por marca. Esses 82 pedidos pertencem à ingestão inicial;
os 63 da prova anterior eram de outra janela e não foram gravados por aquela prova.
Isso ainda não representa toda a história desde `initial_since` até o presente.

O caller `nVUa5pwABE2fTBUr` foi desativado e removido, com confirmação 404. Às 22h54,
somente os dois nós de agendamento foram reabilitados, com versão ativa e diff
conferidos: `b663804f-9e36-4cec-b8d4-116b60135ccc`. A fonte e as flags permanecem
habilitadas; não houve instalação ou habilitação do holdout.

Recibos privados em `.private/runtime/growth-audit-20260924/outcomes-install/`:
`smoke-disabled-result.json`, `smoke-enabled-result.json`, `source-data-readback.json`,
`cleanup-phase.json` e `enable-schedules-result.json`. O readback da instalação SQL
está em `.private/runtime/growth-audit-20260924/bloco2-outcomes-install-readback.json`.
Esses recibos contêm estado e agregados, sem dados de contato ou valores individuais.

Ainda falta observar uma execução real dos agendamentos, completar e conferir a
cobertura histórica necessária e fixar janela, datas e demais decisões do protocolo.
A primeira ingestão não comprova cobertura madura para medir o experimento. O holdout
continua desligado até essas condições serem atendidas.

Fontes estabilizadas usadas nas provas e na instalação (SHA256):

| Arquivo | SHA256 |
|---|---|
| Biblioteca | `236cabd6b2f603db27ad1d19f37abc586c8bf9f0aad0a794fb731ef111cf633c` |
| Gerador | `293a44abfe502eaa05239945a0b4e277aa88dbb921dbfe03b93e23691a10b0f1` |
