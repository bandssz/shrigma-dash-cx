# Reautorizar as lojas no TikTok Shop

Por que isso existe: no TikTok Shop o **pacote de escopos fica preso à autorização**, não ao app.
Ligar uma permissão nova no Partner Center não vale nada sozinho — o token que já está rodando
continua com os escopos antigos. Só uma **nova autorização de cada loja** emite um token com o
pacote novo. É por isso que `/analytics/...` responde `105005` mesmo com a permissão marcada.

Leva ~3 minutos por loja e só precisa ser refeito quando ligarmos um escopo novo (ou quando o
refresh token vencer, o que o painel avisa 14 dias antes).

## Passo a passo

**1. Ligar os escopos (uma vez, no app — não por loja)**

Partner Center → o app *Shrigma* → **Manage API / Gerenciar API** → marcar:

- `Shop Analytics` — é o que libera `/analytics/*` (canal, vídeos, lives)
- `Order Information` e `Product Information` — já estão ligados, confirmar que seguem marcados
- `Affiliate Seller` — já ligado, é o que roda hoje

Salvar. Nada muda ainda: o token velho continua sem os escopos novos.

**2. Autorizar cada loja**

Abrir, **logado como vendedor da loja** (a conta que administra aquela Seller Center):

```
https://services.tiktokshop.com/open/authorize?service_id=7670181171502434055
```

Aceitar. O TikTok redireciona para o nosso webhook, que:

- troca o código por access + refresh token;
- chama *Get Authorized Shops* para descobrir **qual loja** é essa (ninguém precisa escolher nada);
- grava em `crm_tts_token` (`loja`, `shop_id`, `shop_cipher`, `refresh_token`, `autorizado_em`).

A resposta no navegador é um JSON com `ok: true` e o nome da loja. Se aparecer `loja desconhecida`,
o `shop_id` não está no de-para do nó *Monta upsert de tokens* — avisar.

**3. Repetir para a segunda loja**

Sair da conta (ou usar outro navegador/anônimo), entrar como vendedor da outra loja, abrir o mesmo
link. As duas lojas têm que aparecer em `crm_tts_token`, uma linha cada.

**4. Não precisa fazer mais nada**

O *Token Manager* lê `crm_tts_token` antes do cache e **descarta o cache quando `autorizado_em` muda**.
Ou seja: assim que a autorização entra, a próxima chamada já usa o token novo, com os escopos novos.
Antes de existir essa tabela, alguém tinha que editar a constante `SEEDS` no código — essa era a trava.

## Medido em 16/09/2026 — reautorizar não bastou

As duas lojas foram reautorizadas e o token novo entrou. Mas o próprio token diz quais escopos
carrega (campo `granted_scopes` da resposta de `/token/refresh`), e vieram **só 5, todos de afiliado**:

```
seller.affiliate_collaboration.read    seller.affiliate_collaboration.write
seller.affiliate_messages.write        seller.creator_marketplace.read
seller.authorization.info
```

Resultado medido endpoint a endpoint: afiliado (colabs, pedidos, amostras) responde OK; `order`,
`product` e `analytics` respondem `105005`.

**Conclusão: o escopo precisa estar liberado no app ANTES da autorização.** Autorizar de novo com o
app do jeito que está vai produzir exatamente os mesmos 5 escopos, quantas vezes for. O passo 1 é
que não surtiu efeito — ou a permissão não foi salva, ou o app (criado na categoria *Colaborações do
criador*) não oferece as permissões de loja/analytics sem mudar de categoria ou passar por revisão
da TikTok. Isso se confirma abrindo a página de permissões do app no Partner Center.

`granted_scopes` agora é gravado em `crm_tts_token` a cada autorização, e o painel mostra a lista do
que falta — então dá para conferir sem abrir chamado com ninguém.

## Quais escopos pedir, e a diferença entre os dois erros (medido 16/09/2026)

A API devolve `105005` em dois sabores, e eles pedem ações **diferentes**:

- *"The access token does not include any scope… **Reauthorize**"* → a permissão existe no app,
  mas não chegou no token.
- *"**This app has not been granted** any access scope… **Add**"* → a permissão não está no app.

Resultado do teste endpoint a endpoint, na Fishermans:

| API | mensagem | ação |
|---|---|---|
| Shop Analytics | reauthorize | está no app, não chega no token — conferir se está *aprovada* ou *pendente* |
| Order Information | reauthorize | idem |
| Product Information | reauthorize | idem |
| Finance | reauthorize | idem |
| Fulfillment | **add** | adicionar ao app |
| Return & Refund | **add** | adicionar ao app |
| Customer Service | **add** | adicionar ao app |
| Promotion | **add** | adicionar ao app |
| Seller/Shop info | **add** | adicionar ao app |

### Prioridade, pela decisão que cada uma destrava

1. **Product Information** — hoje a regra de SKU de amostra é um *regex no título do produto*, gambiarra
   que só existe porque não lemos o catálogo. Com esse escopo a regra passa a ler SKU/variante de
   verdade (o kit misto novo entra sozinho, sem mexer em regex), dá para não aprovar amostra de SKU sem
   estoque, e o problema já medido de *SKU desativado ainda pagando comissão* vira alerta automático.
2. **Order Information** — é o **denominador**. Hoje o GMV do painel é só de afiliado; sem pedidos da
   loja não existe "% do canal que é afiliado", não dá para reconciliar com Bling/Shopify, e a tabela
   de canal não tem contra o que ser conferida.
3. **Finance** — transforma GMV em margem: comissão efetivamente paga, taxa da plataforma, liquidado
   × pendente. É o que faz o painel responder *quanto sobrou*, não *quanto vendeu*.
4. **Fulfillment** — ataca direto os 30% de perda operacional: *aprovada e não enviada* é problema de
   expedição, e hoje não enxergamos o pacote da amostra.
5. **Return & Refund** — preenche a coluna de reembolso do canal e mostra qual criador traz cliente
   que devolve.

Promotion, Customer Service e Seller info ficam para depois: cupom ainda não é alavanca no TikTok e
o atendimento já vive no Gleap.

## A sonda: quem avisa quando a TikTok aprova

Aprovar uma permissão é um processo da TikTok que leva dias e não manda aviso. E o token só ganha o
escopo na **próxima autorização**, então existe uma janela em que a permissão já está liberada e
ninguém sabe — o painel seguiria vazio sem motivo aparente.

O workflow **"Sonda de escopos"** (`hxcQkWmx8iiuKNKo`, de 6 em 6 horas) resolve isso: bate um
endpoint barato por família de API e classifica a resposta em `crm_tts_escopo`:

- `falta_no_app` — *"this app has not been granted"*
- `reautorizar` — *"the access token does not include"*

**Cuidado: a mensagem sozinha não diz se a permissão foi aprovada.** Eu li `reautorizar` como
"já liberado, é só reautorizar" e estava errado — em 16/09 reautorizamos as duas lojas às 13h41 com
Analytics, Order, Product e Finance nesse estado, e `granted_scopes` continuou com os mesmos 5
escopos de afiliado. A verdade é `granted_scopes`, não a mensagem de erro.

Por isso o painel só pede reautorização quando uma família **muda de estado depois** da última
autorização. Se a sonda já conferiu depois de autorizar e nada entrou, a faixa diz exatamente isso:
reautorizar de novo não resolve, falta a TikTok aprovar no app.
- `ok` — passou da checagem de escopo
- `desconhecido` — a sonda não conseguiu medir (nunca assume `ok`)

`mudou_em` carimba a virada, que é o instante da aprovação. A faixa do painel lê isso e troca de
mensagem sozinha: enquanto está em análise ela manda esperar; quando libera, ela manda reautorizar.

Duas armadilhas que a sonda teve que contornar, as duas descobertas medindo:

1. O `105005` volta como **HTTP 401** e o n8n, por padrão, lança exceção com o texto
   `Request failed with status code 401` — o corpo com a mensagem se perde e tudo era classificado
   errado. Precisa de `ignoreHttpStatusErrors: true` para ler o **corpo**, não o status.
2. Em várias famílias a validação de parâmetro roda **antes** da checagem de escopo, e aí a resposta
   não diz nada sobre permissão. `page_size` vai na query na maioria, mas a Promotion exige inteiro
   e só aceita no corpo — com ele na query ela falhava na validação de tipo e a sonda lia `ok`.

## Como saber que deu certo

- O aviso amarelo no topo da aba **Afiliados** some sozinho (ele compara `granted_scopes` com o que o canal exige).
- `SELECT loja, autorizado_em FROM crm_tts_token;` traz as duas lojas com a data de hoje.
- A coleta do canal para de registrar `105005` em `crm_tts_coleta_log`.

## Por que isso não vira trava de novo

| Antes | Agora |
|---|---|
| refresh token era constante no código | mora em `crm_tts_token`, escrito pela própria autorização |
| reautorizar exigia um dev editando workflow | é abrir um link logado na loja |
| escopo faltando aparecia como tabela vazia | aparece como faixa amarela no painel, com o link do lado |
| vencimento do token só se descobria quebrando | o painel avisa 14 dias antes |
| `105005` não dizia qual escopo faltava | o painel nomeia o escopo, de `granted_scopes` |

## Sobre vencimento: não vence

Medido: `refresh_token_expire_in` volta como **2125** (99 anos). O refresh **rotaciona** o token a cada
chamada, mas o anterior **continua válido** — testei reusando o mesmo token do banco duas vezes
seguidas, as duas funcionaram. Então o que está em `crm_tts_token` não caduca, e o Token Manager
guarda o rotacionado no cache. Reautorizar só é necessário quando **mudar o pacote de escopos**.
