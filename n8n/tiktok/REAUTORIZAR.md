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

## Como saber que deu certo

- O aviso amarelo no topo da aba **Afiliados** some sozinho (ele lê `crm_tts_token`).
- `SELECT loja, autorizado_em FROM crm_tts_token;` traz as duas lojas com a data de hoje.
- A coleta do canal para de registrar `105005` em `crm_tts_coleta_log`.

## Por que isso não vira trava de novo

| Antes | Agora |
|---|---|
| refresh token era constante no código | mora em `crm_tts_token`, escrito pela própria autorização |
| reautorizar exigia um dev editando workflow | é abrir um link logado na loja |
| escopo faltando aparecia como tabela vazia | aparece como faixa amarela no painel, com o link do lado |
| vencimento do token só se descobria quebrando | o painel avisa 14 dias antes |
