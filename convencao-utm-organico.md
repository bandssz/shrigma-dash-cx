# Convenção de UTM do orgânico — Grupo Shrigma

Complementa `convencao-utm-shrigma.md`, que cobre e-mail. Mesma máquina de receita
(`crm_conversao`, alimentada pela `customerJourneySummary` da Shopify), regra diferente.

## O portão é o `utm_medium`, nunca o `utm_source`

```
utm_source   = instagram | facebook | tiktok | youtube
utm_medium   = organico                    <- ISTO é o que separa orgânico de pago
utm_campaign = <marca>-<iniciativa>        ex: aristo-desodorante
utm_content  = <superficie>-<apelido>      ex: story-teaser3, bio-lancamento
utm_term     = story | bio | legenda       onde o link estava
```

Anúncio do Meta também chega com `utm_source=instagram`. Se o coletor filtrasse por
source, receita de mídia paga entraria como conteúdo e o orgânico ficaria lindo de
graça. Por isso o gate é o medium, que só nós escrevemos à mão.

No banco, `crm_conversao.canal` recebe a **rede** (`instagram`, `tiktok`…), não a
palavra "organico": `canal` faz parte da chave primária, e guardar o mesmo valor para
todas as redes colidiria duas peças diferentes na mesma linha.

## Onde dá para ser exato e onde não dá

| superfície | link por peça? | exatidão |
|---|---|---|
| **Story** | sim, um sticker por story | **exata** — cada story tem seu `utm_content` |
| **Bio** | não, um link para toda a grade | **de campanha** — sabe a iniciativa, não a peça |
| **Legenda / comentário fixado** | sim, quando houver | exata |

Reel e post de feed não carregam link. O clique deles passa pela bio, e a bio não sabe
qual peça mandou a pessoa lá. Prometer atribuição por Reel seria mentira; o que o
painel mostra é receita da **campanha**, com a superfície declarada ao lado.

## De-para: `crm_organico_utm`

Uma linha por `(utm_campaign, utm_content)`, ligando o UTM à peça:

```sql
INSERT INTO crm_organico_utm
  (utm_campaign, utm_content, marca, rede, superficie, story_id, apelido)
VALUES
  ('aristo-desodorante','story-teaser3','aristocrata','instagram','story',
   '18134375761726554','Teaser 3 · véspera');
```

**Peça sem linha aqui aparece como receita órfã, nunca como zero.** Zero diria "não
vendeu"; a verdade é "não dá para saber de qual peça veio". É a mesma regra do UTM
ambíguo no e-mail.

## Checklist antes de publicar um link

1. `utm_medium=organico` está escrito? Sem isso a receita não é coletada.
2. `utm_campaign` bate com uma iniciativa que já existe, sem inventar sinônimo?
3. `utm_content` é único dentro da campanha?
4. Story: gravou a linha em `crm_organico_utm` com o `story_id` **no mesmo dia**?
   A API só devolve story por 24h — depois disso o `story_id` some e o de-para fica
   sem âncora.

## Por que orgânico não aparece no Growth

`growth.html` descarta `utm_medium='organico'` na entrada, e o `crm_intradia` nem
coleta. Growth é CRM; conteúdo é outro domínio, com outro dono e outra cadência.
Receita de post mora em `organico.html`.


## Atualização 08/09/2026 — padrão real do time e o que o painel aceita

O time de orgânico (planilha "Controle de Links Parametrizados") usa:

`utm_source=instagram|linktree` · `utm_medium=social` · `utm_campaign=venda` · `utm_content`/`utm_term` = superfície (story, reels, bio, post) e produto (amazonica8x, copo, S50…), **em qualquer ordem**.

O coletor da Shopify passou a aceitar `utm_medium ∈ {organico, social}` com `utm_source` em rede conhecida (`instagram`, `linktree`/`bio` → instagram, `tiktok`, `youtube`, `facebook`). O portão continua sendo medium + rede, nunca source sozinho. O bruto é gravado como veio; a normalização superfície/produto é feita na leitura (API + organico.html › Venda). `link_in_bio` (UTM que o próprio Instagram põe no link do perfil) conta como superfície `bio`, sem produto.

Link novo nesse padrão entra sozinho, sem de-para. O de-para em `crm_organico_utm` segue existindo só para ligar receita a um post/story específico.

Risco declarado: anúncio do Meta com `utm_medium=social` entraria como orgânico. `utm_medium` fica gravado em `crm_conversao`, então dá para separar depois por `utm_campaign`.


### Automação EU QUERO (Replient), 08/09/2026

- Fishermans: `utm_source=instagram&utm_medium=dm&utm_campaign=evergreen- comentarios&utm_content=replient-quero`
- Aristocrata: `utm_source=instagram&utm_medium=dm-automation&utm_campaign=aristocrata-quero-evergreen&utm_content=replient-eu-quero`

O coletor aceita `utm_medium ∈ {dm, dm-automation}` com `utm_source=instagram` como orgânico; na aba Venda vira superfície "dm (automação)". Os dois links divergem entre si (medium e nome da campanha) — se um dia for reescrever no Replient, o padrão sugerido é `utm_medium=dm · utm_campaign=quero-evergreen · utm_content=replient` nas duas marcas.
