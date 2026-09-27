# Foto e nome curto dos produtos da TikTok no painel

27/09/2026. A fila de amostras, as aprovadas não enviadas e a Open collab mostram a foto do produto e um rótulo curto, como "X8 Oceânica", "N90 Mono" ou "Sabonete Frescor da Mata · kit 3".

- **Fotos:** primeiro a imagem do próprio anúncio na TikTok (cadeia "Fotos 05:50" no workflow `37W8obVhxFccuHgv`, só GET `/product/202309/products/{id}`, `produto-foto-tiktok.cjs`); de reserva, o catálogo público das lojas (`/products.json`). O workflow `g3SNF23kzv3CZ5wk` roda todo dia às 05:40 e não usa credencial nem escreve na loja.
- **Casamento:** o anúncio da TikTok é ligado ao produto da loja por regra de nome (`crm_tts_produto_classifica_v1`).
  - Quando o anúncio não diz a variação (linha "8 Fios" sem cor, sabonete sem fragrância), fica sem foto e com o rótulo "não informada". Não se presume.
  - A classificação `fonte='manual'` não é sobrescrita pela regra.
- **Leitura no painel:** ação `produtos` do endpoint da cobrança (`2t4252NQIhmVr9Xq`), com a chave de Influs. O painel casa pelo título do anúncio.
