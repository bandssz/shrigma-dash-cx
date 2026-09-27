# Candidatura pelo site (LP "Seja um Parceiro")

27/09/2026. O formulário próprio da LP substitui o do ClickUp. O que a pessoa envia vira um candidato `novo` na aba Parceiros.

## Peças

| peça | onde | estado |
|---|---|---|
| `partner-candidatura.sql` | termos versionados e imutáveis, candidatura, prints (bytea), recibos | em produção |
| `partner-candidatura-workflow.cjs` | webhook `FVJBhFsdlbhjW013` em n8n.shrigma.com.br (`parceiros-candidatura-bc82004eb9363032`) | ativo, sem guardar execução |
| `shopify/parceiros/shrigma-parceiros.liquid` | seção "Parceiros · LP", a mesma nas duas lojas | publicada nos temas principais |
| `shopify/parceiros/page.parceiros.*.json` | template `page.parceiros` com textos e cores de cada marca | publicado |
| `partner-candidaturas.js` | cartões "Candidaturas do site" na aba Parceiros | entra com o merge |
| `partner-comissao.sql` | comissão do programa em 5% | em produção |

## Estado

- **Prévias:** `/pages/parceiros-previa` nas duas lojas, publicadas e fora da busca (`seo.hidden`). As páginas `/pages/seja-um-influenciador` continuam como estavam.
- **Formulário fechado:** sem termo publicado, a seção mostra "inscrições abrem em breve" e o servidor recusa o envio.

## Para abrir

1. Gravar o contrato como termo (versão 1) em `crm_partner_terms_v1`:
   - `texto` com o contrato, e `sha256` = SHA-256 hexadecimal do texto em UTF-8;
   - `publicado_em = now()`.

   O texto não muda depois de gravado: versão nova é linha nova.
2. Trocar o template da página real para `parceiros` (`templateSuffix`), nas duas lojas.

## Regras do servidor

- **Termo:** aceite só vale para a versão publicada, com o hash exato. Gravam-se versão, data, IP e navegador.
- **Anti-spam:**
  - campo-isca e tempo mínimo de 3 s na página (no workflow);
  - até 5 envios por hora por IP;
  - a mesma pessoa (Instagram ou e-mail) na mesma marca em 30 dias não duplica.
- **Idempotência:** o `request_id` devolve o mesmo protocolo, sem gravar de novo.
- **Prints:** de 1 a 3, em JPEG, PNG ou WebP, até 3 MB cada, conferidos pelos primeiros bytes. A LP reduz para 1600 px em JPEG antes de enviar.
- **CPM:** preço declarado ÷ views declaradas × 1.000, calculado na leitura do painel.
