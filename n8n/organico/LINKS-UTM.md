# Links UTM do Orgânico (26/09/2026)

O registro fica no painel, na aba **Links UTM**. A ideia é que ele conviva com a planilha "Controle de Links Parametrizados" da Júlia e, com o tempo, tome o lugar dela.

## Como funciona

- **Montagem:** é a mesma fórmula da planilha, refeita no servidor: `destino + ?/& + utm_source + utm_medium + utm_campaign`. Com data, `utm_campaign = AAAAMMDD_campanha`. Sem data (link fixo, como o da bio), fica só a campanha.
- **Onde fica:** tabela `organico_link_utm_v1`, uma linha por link final (`url` é única). Um link com endereço já existente não é duplicado: a resposta devolve o que já está gravado. Arquivar tira da lista, mas a linha continua na tabela.
- **Validação no servidor:**
  - destino https do site da própria marca, sem UTM;
  - origem e superfície de listas fechadas;
  - campanha sem espaço.
- **Quem grava:** qualquer chave de painel do Orgânico, ou a chave mestre (`organico_operador_v1`, pelo hash da chave). O nome desse acesso vai para `criado_por`.
- **Vendas por link:** saem da atribuição por último clique (mesma fonte da aba Venda). Marca, origem, superfície e campanha precisam bater exatamente.
- **Histórico:** os 7 links da planilha auditados em 20/09 foram importados com `origem = 'planilha'`. O de 09/09 (destino Alma da Roça × campanha Frescor da Mata) ficou marcado como produto divergente, sem crédito definido.

## Peças

- **SQL:** `links-utm.sql` (idempotente).
- **Workflow:** `links-utm-workflow.cjs` → "Orgânico — Links UTM (POST, chave do painel)". O corpo da requisição vai como parâmetro nativo do PostgreSQL, e o histórico de execuções bem-sucedidas fica desligado.
- **Tela:** `organico-links.js`.
- **Teste:** `tests/organico-links-utm.test.cjs`.
