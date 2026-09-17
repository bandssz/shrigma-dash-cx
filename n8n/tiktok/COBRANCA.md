# Cobrança de conteúdo

## O gargalo que isto ataca

Medido em 16/09/2026 — o funil de produção não perde gente na seleção, perde no meio:

| | convidados | puseram na vitrine | postaram |
|---|---:|---:|---:|
| Fishermans | 375 | 143 | 83 |
| O Aristocrata | 301 | 39 | 21 |

São **82 criadores que já aceitaram, já colocaram o produto na loja deles e nunca gravaram**. Não é
gente fria: é gente que disse sim e parou. Mais 3 receberam amostra e ainda não postaram.

## Como funciona

Roda em dias úteis às 13h20 (workflow `TikTok Shop - Cobrança de conteúdo`). Duas etapas:

- `vitrine_sem_video` — pôs na vitrine e não gravou
- `amostra_sem_video` — recebeu amostra e não postou (entra primeiro na fila, é produto que já saiu)

O canal é o chat de afiliados do próprio TikTok — mapeado na unha em 16/09, porque o escopo
`seller.affiliate_messages.write` já estava concedido:

```
POST /affiliate_seller/202412/conversations                {creator_id}         -> conversation_id
POST /affiliate_seller/202412/conversations/{id}/messages  {msg_type, content}  -> entrega
```

## A régua: 3 toques, 7 dias entre eles

Quem não gravou depois do primeiro toque recebe um segundo 7 dias depois, e um terceiro 7 dias
depois disso. Cada toque tem texto próprio (`crm_tts_cobranca_modelo`, chave marca × etapa ×
tentativa): o 1º oferece ajuda, o 2º pergunta o que falta, o 3º dá saída — "se não encaixou, eu tiro
da sua vitrine".

### Por que não é "infinito" — e o que mudou em 18/09

O Felipe pediu para tentar reativar indefinidamente. Em 16/09 isso não era implementável porque a
API parecia não ler mensagem. **Em 18/09 achei a família inteira de IM na documentação** (a busca do
portal não indexa; o índice sai de `GET /api/v1/document/tree`): `Get Message in the Conversation`,
`Get Conversation List`, `Get Latest Unread Messages`, webhook `New message listener`. Testado na
Fishermans: a conversa com um criador voltou com as mensagens dele, `sender_id`, `create_time` e 7
não lidas.

Então a régua agora é de verdade "se não respondeu, manda outra". Antes de cada toque o robô abre a
conversa e olha as últimas 20 mensagens:

| o que vê | o que faz | por quê |
|---|---|---|
| há mensagem **não lida** do criador (qualquer idade) | pula, motivo `respondeu` | pendência da loja: alguém precisa ler |
| a última palavra é do criador, há ≤ 30 dias | pula, motivo `respondeu` | a bola está com a Marcela |
| última palavra é do criador, há > 30 dias, já lida | **toca** | a conversa morreu; insistir vale |
| alguém (loja ou criador) falou nos últimos 7 dias | pula, motivo `conversa_ativa` | não empilhar robô em conversa humana |
| conversa nova ou parada | **toca** | |

Pulo vai para `crm_tts_cobranca_pulo` (uma linha por pessoa/etapa, estado mais recente) e **não
consome tentativa**. Quem pulou por `respondeu` aparece no topo da aba Cobrança em "Responderam e
estão esperando", com o trecho da última mensagem e quantas não lidas — isso virou a linha mais
urgente da aba, porque é gente que já engajou e está sem resposta.

Ensaio com os 30 alvos do dia (18/09, envio bloqueado no harness `cob_local.js`): 26 tocariam, 4
pulariam — todos com mensagem não lida do criador, um deles um **link de vídeo pronto** que ninguém
abriu (`fmshop2923`, 4 não lidas desde 11/08) e outro com o WhatsApp do criador (7 não lidas).

O teto de toques continua (3, configurável), por segunda razão: **insistir sem limite queima o
canal.** É a caixa de entrada do criador dentro do TikTok, com o nome da marca. Quem ignorou três
mensagens não converte na oitava, mas pode denunciar. Quem produz sai da fila sozinho na coleta
seguinte. **Reativação** depois do teto é gatilho novo (produto novo na vitrine, campanha nova).

## As travas

| trava | onde | o que impede |
|---|---|---|
| `cobranca_modo` | `crm_tts_regra` | `dry_run` (padrão) grava a mensagem e **não chama a API**; `ativo` envia; `pausado` não faz nada |
| `cobranca_max_dia` | `crm_tts_regra` | teto por marca por dia (15). **Limita a quantidade**, não só abre o portão — sem isso, 63 pendentes sairiam de uma vez no primeiro dia |
| PK `(marca, etapa, username, tentativa)` | `crm_tts_cobranca` | ninguém leva o MESMO toque duas vezes, por mais que o workflow rode todo dia |
| `cobranca_max_tentativas` | `crm_tts_regra` | teto de toques por pessoa (3) |
| `cobranca_dias_entre` | `crm_tts_regra` | espera mínima entre um toque e o próximo (7 dias) |
| `MAX_POR_EXECUCAO` | código | trava dura contra disparada (60), independente da regra |
| pausa de 900 ms | código | respeita o QPS da API — e isto fala com gente, não com máquina |

## A copy fica no banco

`crm_tts_cobranca_modelo` (marca × etapa). `{nome}` e `{produto}` são trocados no SQL, então **o que
está no log é exatamente o que vai na mensagem** — não existe versão "de verdade" diferente da simulada.

O título do anúncio é encurtado antes de entrar na mensagem: "Sabonete Natural Masculino O Aristocrata
150g 4.9 Estrelas 90mil Avaliações" vira "Sabonete Natural Masculino O Aristocrata 150g". Título de
catálogo dentro de uma DM soa como robô.

### O que deixa a mensagem com cara de robô

Lendo a simulação inteira, o que denuncia automação não é o texto — é o preenchimento:

- **Título de anúncio no meio da frase.** "Vi que você pôs o Sabonete Natural O Aristocrata Frescor na
  sua vitrine" — ninguém escreve assim. Virou "o sabonete" e "a linha", que é como a Marcela falaria.
- **Apelido usado como nome.** Metade dos apelidos é nome de loja ou tem emoji: "Opa, cantinho do
  pescador!" é pior que não chamar de nada. O nome só entra quando o apelido parece nome de pessoa
  (primeira letra maiúscula, resto minúsculo, e fora de uma lista de palavras de loja). Na leva atual
  são 10 de 30 com nome — os outros 20 abrem só com "Opa!".
- **Tamanho.** Quatro parágrafos com prova social soa como e-mail marketing. A v2 tem três linhas e
  termina numa pergunta ("Travou em alguma coisa?"), que é o que faz o criador responder.

### Erros que só apareceram lendo a simulação

1. O **produto** na etapa de vitrine vinha do nome INTERNO da campanha — "FEITO JUSTAMENTE
   PRA VOCE", "trofeu e grana na linha". Numa DM soa como mensagem enviada pro contato errado.
2. O corte do título parava no meio: "Sabonete Natural O Aristocrata Frescor da". Agora corta em
   fronteira de palavra e ainda tira preposição pendurada no fim.
3. A mensagem da Fishermans citava **X4/X8 e camuflagem** para quem tinha posto uma **monofilamento**
   na vitrine — e isso só existe na família X. Denunciava que a mensagem era automática. A copy de
   vitrine agora não assume família de produto.

## Destravado em 18/09: a versão 202508 aceita o open_id

Primeiro disparo real (16/09, 13h20) falhou nas 30 com `16032001 Invalid parameter CreatorId`: a
`POST /affiliate_seller/202412/conversations` quer `creator_id` **numérico**, e nenhum payload que
lemos tem esse número. Nenhum criador recebeu nada; log limpo, régua zerada.

A saída estava na própria doc, numa página que a busca do portal não acha:
**`POST /affiliate_seller/202508/conversations`** (`Create Conversation with creator`) recebe
`{creator_open_id, only_need_conversation_id:false}` e devolve `conversation_id`, `creator_im_id`,
`is_new`, `unread_count`, `username`. Testado: `code 0`, `is_new:false` para um criador que já
conversa com a Marcela pelo Seller Center. O envio continua em
`POST /affiliate_seller/202412/conversations/{id}/messages` `{msg_type:'TEXT', content}`; a leitura em
`GET /affiliate_seller/202412/conversation/{id}/messages?page_size=20` (singular, `conversation`).

Cota de outreach (`GET /affiliate_seller/202607/creator_outreach/quota`): as duas lojas voltam
`unlimited:true`. Não há teto da plataforma para nós hoje; o teto é o nosso (15/dia/marca).

Outras APIs que apareceram no mesmo índice e valem fila: `Seller Search Creator on Marketplace`
(202608), `Get Marketplace Creator Performance` (202608), `Get Open Collaboration Creator Content
Detail` (202508), `Query Creator Promotion Details in Target Collaboration` (2026), webhook
`New message listener` (33). O `sender_id` das mensagens é o `creator_im_id`, não o open_id.

## Para ligar

Na aba **Cobrança** do painel, no bloco "Ligar a cobrança": troca de `simulação` para `ativo` e salva.
O botão pede confirmação com o texto "Enviar de verdade?" quando o clique liga o envio — é o único
lugar do painel que fala com criador em nome da marca.

Uma marca de cada vez, se preferir. O teto por dia fica no mesmo bloco. O cron é dias úteis 13h20;
para não esperar, `POST /webhook/tts-cobranca-4a9e7b {k}` roda na hora com a regra vigente.
