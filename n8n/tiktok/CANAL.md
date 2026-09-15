# Canal inteiro (ads + afiliados + lives + orgânico) — modelagem

A Marcela vai responder por 100% do TikTok, então o painel precisa fechar o canal, não só afiliados.
A modelagem abaixo **copia a taxonomia oficial da plataforma**, porque é a única que reconcilia com o
Seller Center — se inventarmos dimensão nossa, o número do painel nunca vai bater com o do TikTok e
a discussão vira sobre a planilha em vez de sobre o resultado.

## A referência

A própria TikTok Shop ("Sales Metrics Breakdown Logic", Seller University) quebra venda em três eixos:

- **tipo de conteúdo**: LIVE · vídeo curto · product card (vitrine/busca)
- **origem do pedido**: afiliado · próprio (seller)
- **atribuição**: GMV **direto** (comprou interagindo com o conteúdo) × **indireto** (viu e comprou depois),
  modelo *last-touch*, janela de 1 dia

E, por fora, separa **Ads Gross Revenue** de **Non-Ads Gross Revenue**. Ads Manager reporta por data de
*interação*; Seller Center por data de *transação* — por isso os dois nunca batem exatamente, e o que
vale como fonte de GMV para nós é o Seller Center (é o que a Shop API devolve).

Os dashboards de escala (Dataslayer, Saras, Eva, Dashboardly) usam exatamente esses eixos e recomendam
três cortes de leitura, não um dashboard único: **diário** (pulso: GMV, top SKU, conversão),
**semanal** (ROAS e performance de criador), **mensal** (coorte e categoria).

## O que mudei em relação ao que eu ia fazer

Eu ia criar três tabelas paralelas (`canal`, `video`, `live`). **Isso estava errado** e a referência
deixou claro: um mesmo pedido é live *e* afiliado ao mesmo tempo — três tabelas por superfície
duplicariam GMV e tornariam "conversão total do canal" impossível de fechar.

O certo é **uma tabela-fato com dimensões**:

```
crm_tts_canal_dia  →  grão (dia, marca, superficie, origem)
```

Somar tudo de um dia = GMV do canal, sem dupla contagem. Vídeo e live ganham tabela própria só no
grão de **entidade** (cada vídeo, cada transmissão), que é outra pergunta ("que criativo replicar"),
não outra fatia do mesmo bolo.

## As tabelas

| tabela | grão | responde |
|---|---|---|
| `crm_tts_canal_dia` | dia × marca × superfície × origem | quanto o canal fez e de onde veio |
| `crm_tts_video_dia` | dia × vídeo | que peça vendeu, de qual criador |
| `crm_tts_live_dia` | transmissão | que live vendeu (chave é a live, não o dia: live cruza meia-noite) |
| `crm_tts_canal_custo` | dia × marca | investimento em mídia — **entrada manual** |
| `crm_tts_canal_v` | dia × marca | a visão pronta: ticket, conversão, CTR, ROAS, % orgânico, % reembolso |

## O buraco conhecido: custo de mídia

A Shop API devolve **receita, nunca investimento**. Spend só existe na *TikTok Ads Business API*, que é
**outro app**, com outra autorização. Enquanto esse app não existir, `crm_tts_canal_custo` é digitada
(uma linha por dia por marca) — sem ela não há ROAS nem take rate real, só GMV.

Decisão do Felipe pendente: digitar diariamente (a Marcela, 30 s/dia) ou abrir o app de Ads agora.

O ROAS na view é **blended de propósito**: o custo é do canal, não da superfície. Ratear custo por
superfície seria inventar atribuição que a plataforma não entrega.

## Status

Tabelas criadas no banco (15/09). O coletor ainda **não** existe: `/analytics/*` responde `105005`
até as duas lojas serem reautorizadas — ver [REAUTORIZAR.md](REAUTORIZAR.md). Assim que a autorização
entrar, eu leio o formato real das respostas e escrevo o coletor em cima do que a API devolve de
verdade, em vez de adivinhar o shape.

## Fontes

- TikTok Seller University — Sales Metrics Breakdown Logic Upgrade
- Emplicit — Ultimate Guide to TikTok Shop Traffic Attribution
- Dataslayer — TikTok Shop Analytics 2026: KPIs, Attribution & Reporting
