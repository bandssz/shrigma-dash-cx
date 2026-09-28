# Candidatura pelo site (LP "Seja um Parceiro")

27/09/2026. O formulário próprio da LP substitui o do ClickUp. O que a pessoa envia vira um candidato `novo` na aba Parceiros.

## Peças

| peça | onde | estado |
|---|---|---|
| `partner-candidatura.sql` | termos versionados e imutáveis, candidatura, prints (bytea), recibos | em produção |
| `partner-candidatura-workflow.cjs` | webhook `FVJBhFsdlbhjW013` (LP usa n8n.shrigma.com.br; o painel, n8n-n8n.tazdb8.easypanel.host, por causa da CSP) (`parceiros-candidatura-bc82004eb9363032`) | ativo, sem guardar execução |
| `shopify/parceiros/shrigma-parceiros.liquid` | seção "Parceiros · LP", a mesma nas duas lojas | publicada nos temas principais |
| `shopify/parceiros/page.parceiros.*.json` | template `page.parceiros` com textos e cores de cada marca | publicado |
| `partner-candidaturas.js` | cartões "Candidaturas do site" na aba Parceiros | entra com o merge |
| `partner-comissao.sql` | comissão do programa em 5% | em produção |

## Estado

- **Aberto desde 28/09/2026 (10:44 BRT).** Termo v1 publicado nas duas marcas. A LP em `/pages/seja-um-influenciador` mostra o formulário e esconde o link do ClickUp.
- **Termos v1:** textos exatos em `termos/termo-aristo-v1.txt` e `termos/termo-fish-v1.txt`. O `sha256` do arquivo é o mesmo gravado no banco.
  - Aristo: `e7e77cc088a9c7cbc1b64de435b491f100c89104835f0dd2c4cb070754d39dbd`
  - Fish: `5f5cf1e0f4eda729417e68609d9ed93e46963e7e5cf16fce88d6e78002f418bd`
- **Origem:** os contratos-base de creator das duas marcas, adaptados ao programa do site (5% por link ou cupom, sem frete, pagamento até o dia 5). O termo não leva dado pessoal de nenhum contratado.
- **Teste de ponta a ponta em 28/09:** uma candidatura por marca (protocolos `26C7008B` e `FAF32E84`, nome "TESTE Claude (ignorar)"). Os cartões aparecem em Parceiros com o print, o CPM e o aceite do termo v1. Marcar "Não aprovado" exige acesso `creators_edit`.

## Termo novo

Versão nova é linha nova em `crm_partner_terms_v1`:
- `texto` com o termo inteiro, e `sha256` = SHA-256 hexadecimal do texto em UTF-8;
- `publicado_em = now()`.

A LP passa a mostrar a versão mais alta publicada. Quem aceitou uma versão antiga fica com ela registrada. Guarde o texto em `termos/`.

## Regras do servidor

- **Termo:** aceite só vale para a versão publicada, com o hash exato. Gravam-se versão, data, IP e navegador.
- **Anti-spam:**
  - campo-isca e tempo mínimo de 3 s na página (no workflow);
  - até 5 envios por hora por IP;
  - a mesma pessoa (Instagram ou e-mail) na mesma marca em 30 dias não duplica.
- **Idempotência:** o `request_id` devolve o mesmo protocolo, sem gravar de novo.
- **Prints:** de 1 a 3, em JPEG, PNG ou WebP, até 3 MB cada, conferidos pelos primeiros bytes. A LP reduz para 1600 px em JPEG antes de enviar.
- **CPM:** preço declarado ÷ views declaradas × 1.000, calculado na leitura do painel.
