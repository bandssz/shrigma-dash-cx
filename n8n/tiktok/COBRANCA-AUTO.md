# Cobrança automática com mensagem aprovada

Decisão do Felipe (26/09/2026): **modelo aprovado, envio sozinho**. A Marcela aprova uma vez o texto de cada toque (marca × etapa × tentativa). Depois disso, o robô envia sozinho com as guardas v2 (`COBRANCA-SAFETY-V2.md`).

## Peças

| peça | onde | estado em 26/09 |
|---|---|---|
| `cobranca-safety.sql` | tabelas e funções v2 (reserva, envio, conclusão, simulação) | instalado em produção |
| `cobranca-auto.sql` | aprovação de modelo, fila do dia, resolução, painel, prontidão | instalado em produção |
| `regra-update.sql` | `cobranca_modo = ativo` só com `crm_tts_cobranca_pronta_v2` | instalado em produção |
| `cobranca-painel-workflow.cjs` | endpoint da aba Cobrança (`2t4252NQIhmVr9Xq`) | ativo |
| `cobranca-v2-workflow.cjs` | novo miolo do sender `37W8obVhxFccuHgv` | **não aplicado: espera o aceite do Felipe** |
| `tts-cobranca.js` | aba Cobrança do painel | entra no ar com o merge |

## Como a mensagem sai

1. **Aprovação.** A Marcela aprova o texto como está, ou edita e aprova no mesmo passo. Um texto sem aprovação só aparece na simulação. Se o texto mudar ou a aprovação for retirada, a mensagem para de sair, inclusive nas revisões já geradas (motivo `modelo_nao_aprovado`).
2. **Fila do dia** (`crm_tts_cobranca_prepara_v2`):
   - Entra quem pôs o produto na vitrine e não gravou, ou recebeu amostra e não postou.
   - Cada pessoa aparece em uma etapa só. Quem já está no meio da régua vem primeiro, e amostra vem antes de vitrine.
   - O número de pessoas vai até o teto do dia.
   - A fila gera a revisão individual com o texto final, já com `{nome}` e `{produto}` preenchidos.
3. **Reserva** (`crm_tts_cobranca_reserva_v2` = `claim_v2` + disjuntor):
   - A reserva confere teto, intervalo e sequência.
   - Enquanto houver um envio sem confirmação da TikTok, a marca não reserva ninguém.
4. **Conversa.** O robô abre a conversa e a lê inteira, com paginação de até 10 páginas de 20 mensagens. Ele não envia quando:
   - o criador respondeu em qualquer época;
   - há mensagem sem ler;
   - alguém falou nos últimos 7 dias;
   - a leitura veio incompleta ou num formato desconhecido.

   Cartões da loja ou da plataforma, como convite e amostra, contam como mensagem da loja.
5. **Envio.** `em_transporte` é gravado antes da chamada. Não há nova tentativa: sem aceite claro da TikTok, o envio fica `incerto`. O corpo segue o formato das mensagens recebidas: `content` = `{"content": texto}`.

## O que volta sozinho e o que é da Marcela

Tudo o que não segue o fluxo normal fica em `crm_tts_cobranca_resolucao_v2`, com a reserva inteira como estava.

**Volta sozinho** (`auto_liberar`), só se nunca começou transporte:
- motivo técnico (fonte ou modelo mudou, TikTok não abriu a conversa etc.);
- conversa em andamento ou leitura incompleta, depois do intervalo da régua;
- reserva presa há mais de 2 horas.

**Decisão da Marcela, na aba Cobrança, em "Precisa de você":**

| situação | ações |
|---|---|
| Criador respondeu ou tem mensagem sem ler | **Já respondi · devolver à régua** (as mensagens dele até ali passam a contar como vistas) ou **Tirar da régua** |
| Envio sem confirmação | Conferir no chat do Seller Center e marcar **Chegou** (a régua segue) ou **Não chegou** (o toque volta para a fila). Enquanto isso, a marca fica parada. |

## Para ligar

1. Aplicar `buildSender(fresh, {expectedVersionId})` no export fresco do `37W8obVhxFccuHgv`. O sender legado sai do workflow.
2. Conferir o workflow nó a nó. Rodar com as marcas em simulação e ler o resultado na aba.
3. Gravar `crm_tts_cobranca_config_v2` com a versão conferida.
4. A Marcela aprova as mensagens. Depois, alguém liga a marca na configuração da aba. O botão pede "Enviar de verdade?".

Sugestão para o primeiro dia: teto de 3 por marca. O primeiro envio real também confirma o formato do corpo da mensagem.

## Testes

- `node --test tests/tts-cobranca-safety.test.cjs tests/tts-cobranca-ui.test.cjs`
- `CAMPAIGN_PGLITE_MODULE=… node tests/tts-cobranca-auto-postgres.cjs`: SQL real e código real dos nodes, na ordem do workflow, com transporte falso. Cobre simulação, aprovação, teto, resposta do criador, resposta já vista, envio incerto e disjuntor, retirada de aprovação, tirar e devolver à régua, e liberação automática.
