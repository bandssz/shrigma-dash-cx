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
