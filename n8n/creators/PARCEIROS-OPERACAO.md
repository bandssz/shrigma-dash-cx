# Parceiros do site — regras em operação (26/09/2026)

Estas regras foram decididas pelo Felipe. Estão em `partner-operacao.sql` (migração idempotente) e `partner-operacao.cjs` (ramo de pagamento aplicado sobre a função de escrita lida do banco).

| Regra | Onde fica |
|---|---|
| Comissão de 7% sobre produtos após descontos, sem frete, menos reembolso | `crm_partner_program_v1.rate` e `commission_payable = true` |
| Pedido com link de parceiro e cupom de influ: comissionam os dois | `crm_partner_program_v1.link_cupom = 'ambos'`. A leitura conta `pedidos_com_cupom` para mostrar a sobreposição. |
| Fechamento por competência (mês do pedido), pagamento até o dia 5 do mês seguinte | `fechamento` em `crm_partner_link_read_v1`: comissão, base fechada, mês encerrado e prazo |
| Link do Aristo em `oaristocrata.com` | `crm_partner_program_v1.link_base` |
| Só conta pedido de dia (Brasília) em que o link esteve ativo | gatilho → `crm_partner_link_evento_v1`, `crm_partner_link_ativo_no_dia_v1` |
| CPF e Pix no painel | `crm_partner_payment_v1` (detalhes abaixo) |

## Cadastro de pagamento

- **Onde grava:** `crm_partner_payment_v1`, uma linha por parceiro, com titular, CPF, tipo de chave Pix e chave Pix.
- **Quem pode gravar:** qualquer acesso com `creators_edit`. A gravação usa `kind='pagamento'` na mesma escrita do piloto, com recibo e versão.
- **Validação:**
  - CPF pelos dígitos verificadores;
  - chave Pix pelo tipo (CPF, CNPJ, e-mail, telefone com +55 ou chave aleatória).
- **Leitura:** só devolve dado mascarado (CPF `***.982.247-**`, final da chave). O número completo não volta para o navegador.
- **Registro da operação:** `crm_creator_pilot_operation_v1` guarda CPF e chave apenas como SHA-256.

## Fora do painel por ora

- **Pagamento:** marcar pago e comprovante continuam fora (`payout_active = false`).
- **Entrada de candidatos:** continua manual. O formulário próprio, com aceite dos termos e prints de views para CPM, é a fase seguinte.
- **Portal do parceiro:** mapeado para depois da reestruturação.

## Testes

- `tests/partner-operacao-postgres.cjs` (PGlite):
  - migração repetida;
  - domínio;
  - link inativo não conta;
  - sobreposição com cupom;
  - comissão só com base completa;
  - fechamento e prazo;
  - validação de CPF e Pix;
  - máscara;
  - log sem dado pessoal;
  - recibo idempotente.
- `tests/creators-pilot-ui.test.cjs`: comissão, fechamento, cadastro de Pix sem preencher o CPF de volta e sem nada no `localStorage`.
