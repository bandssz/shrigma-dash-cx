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

## As travas

| trava | onde | o que impede |
|---|---|---|
| `cobranca_modo` | `crm_tts_regra` | `dry_run` (padrão) grava a mensagem e **não chama a API**; `ativo` envia; `pausado` não faz nada |
| `cobranca_max_dia` | `crm_tts_regra` | teto por marca por dia (15). **Limita a quantidade**, não só abre o portão — sem isso, 63 pendentes sairiam de uma vez no primeiro dia |
| PK `(marca, etapa, username)` | `crm_tts_cobranca` | ninguém leva a mesma cobrança duas vezes, por mais que o workflow rode todo dia |
| `MAX_POR_EXECUCAO` | código | trava dura contra disparada (60), independente da regra |
| pausa de 900 ms | código | respeita o QPS da API — e isto fala com gente, não com máquina |

## A copy fica no banco

`crm_tts_cobranca_modelo` (marca × etapa). `{nome}` e `{produto}` são trocados no SQL, então **o que
está no log é exatamente o que vai na mensagem** — não existe versão "de verdade" diferente da simulada.

O título do anúncio é encurtado antes de entrar na mensagem: "Sabonete Natural Masculino O Aristocrata
150g 4.9 Estrelas 90mil Avaliações" vira "Sabonete Natural Masculino O Aristocrata 150g". Título de
catálogo dentro de uma DM soa como robô.

A copy passou pelas skills das duas marcas. Três erros que só apareceram lendo a simulação:

1. O nome do **produto** na etapa de vitrine vinha do nome INTERNO da campanha — "FEITO JUSTAMENTE
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
