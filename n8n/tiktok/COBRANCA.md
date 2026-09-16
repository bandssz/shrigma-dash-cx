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

### Por que não é "infinito"

O Felipe pediu para tentar reativar indefinidamente. Duas razões para o teto existir, e a segunda é
a que decide:

1. **Não dá para saber se a pessoa respondeu.** Medido em 16/09: a API de mensagens devolve só o ID
   da conversa. Não há leitura de mensagem (`GET` em `/messages` responde *Invalid method*), não há
   contador de não-lidas, não há última mensagem. Ou seja, "se não responder, manda outra" não é
   implementável — o sistema mandaria o 8º toque para quem respondeu no 1º e está conversando com a
   Marcela agora. Isso é pior que não cobrar.
2. **Insistir sem limite queima o canal.** É a caixa de entrada do criador dentro do TikTok, com o
   nome da marca. Quem ignorou três mensagens não converte na oitava, mas pode denunciar.

O que o sistema **consegue** ver é melhor para o objetivo: se a pessoa **produziu**. Quem grava sai
da fila sozinho na coleta seguinte, porque deixa de bater o critério. Então a régua não persegue
quem já respondeu — ela para em quem entregou.

O teto é configurável no painel (`Toques`). Se quiser 6, é digitar 6. Recomendação: 3.

**Reativação depois disso** não é insistir mais — é um gatilho novo. Quando o criador volta a pôr um
produto na vitrine, ou entra numa campanha nova, ele aparece como alvo de novo com a régua zerada.

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

## Para ligar

Na aba **Cobrança** do painel, no bloco "Ligar a cobrança": troca de `simulação` para `ativo` e salva.
O botão pede confirmação com o texto "Enviar de verdade?" quando o clique liga o envio — é o único
lugar do painel que fala com criador em nome da marca.

Uma marca de cada vez, se preferir. O teto por dia fica no mesmo bloco.
