# Carrinho: prazo correto depois do silêncio 22h–08h

**Publicado e ativo em 24/09/2026 às19h38 BRT.** Correção exclusiva Growth aplicada em
Aristo `APG7xy5uY4YzU6vA` e Fish `4YidT1MdzugL4wWB`.

| Marca | Versão publicada e ativa |
|---|---|
| Aristo | `77bff157-7fa6-4e21-9670-81472f759441` |
| Fish | `210be1a1-e50f-4cde-8522-e7f0fad21886` |

O readback confirmou `versionId=activeVersionId`, estado ativo e igualdade de todos os
nós, conexões e configurações com os candidatos revisados. Não houve alteração de CX.

O código anterior contava o teto de adiamento pela idade do carrinho (11h/34h).
Isso não implementava a decisão de adiar o disparo para a manhã com janela até 12h:

| Caso em Brasília | Regra anterior | Regra corrigida |
|---|---|---|
| Carrinho 21h30, t1 elegível 22h | Vencia às 08h30 | Permite de 08h inclusive até 12h exclusive |
| Carrinho 23/09 22h, t24 elegível 24/09 22h | Já vencido ao reabrir 25/09 08h | Permite 25/09 de 08h inclusive até 12h exclusive |
| Elegibilidade 02h | Teto variava conforme idade | Próxima abertura é 08h do mesmo dia, prazo12h |
| Elegibilidade antes22h ou exatamente08h | Teto normal 4h/27h | Mesmo teto normal |

O reparo calcula a elegibilidade nominal como `cart_at + shrigma_flow_wait(...)`.
Se ela caiu no silêncio, o teto vira a próxima abertura às08h no fuso `America/Sao_Paulo`
mais4h. Fora desse caso, o teto continua `cart_at +4h`/`+27h`. A guarda global de silêncio
permanece; portanto nada sai entre22h e08h. Às12h o prazo está vencido, inclusive se o cron
não drenou a fila. O reparo não permite recuperação ilimitada de mensagens antigas.

O patch só altera os dois predicados de teto e seu comentário no nó `Monta SQL elegíveis`.
Mantém a compra, opt-out, condição de espera, estágio habilitado, deduplicação, flags,
variante, limite500, formatação da mensagem, chamadas do motor e reservas. Não introduz
função/tabela de banco, segredo, dependência compartilhada ou alteração em CX.

O gerador exige versão ativa e hash fresco do nó, confere que a versão ativa contém os
mesmos nós/conexões e recusa qualquer divergência dos trechos revistos. A saída é um
candidato local; não contém chamada à rede ou ativação.

Validação local:

- 5 testes com PostgreSQL/PGlite: bordas21h30/22h, t24due22h, madrugada, 07h59m59s,
  08h, 11h59m59s,12h, elegibilidade antes22h e exatamente08h.
- 1.441 minutos possíveis de abandono verificaram teto máximo t1 inferior às24h.
  Com espera atual30min, o máximo é14h30; não há colisão com t24.
- Os dois candidatos privados foram compilados e seus SQL completos executados sobre
  fixture sintética para os dois toques: original não tinha elegível; corrigido tinha apenas
  o esperado. Opt-out, compra recente/posterior, envio anterior, flags e telefone inválido
  continuaram excluídos.
- Com o candidato holdout, 11/11 testes locais passaram. Os testes locais não executaram
  envio externo nem escrita de produção.
- Depois da publicação, o SQL completo lido dos dois workflows foi executado uma vez
  por marca em consulta agregada de leitura: Aristo0/Fish0 elegíveis naquele instante.
  As duas consultas responderam com uma linha, sem erro. Zero elegíveis não é prova
  de envio nem comprovação da janela de manhã.
- Nova leitura às 22h13 BRT confirmou ambas as versões ativas acima. O agregado
  dos dois toques de carrinho, nas duas marcas, registrou zero linhas e zero aceites
  WhatsApp desde 22h. Esse intervalo curto confirma somente o período observado;
  não prova sozinho toda a noite nem o adiamento da manhã.

**Pendente: prova operacional na próxima janela de manhã.** A publicação/readback e os
testes de fronteira estão comprovados; ainda é preciso observar o processamento real
08h–12h e completar a observação da noite. Não apresentar fixture ou contagem
de elegíveis como mensagem realmente enviada.

Os candidatos holdout foram regenerados dos exports pós-publicação destas versões e
continuam desabilitados, sem publicação. Recibos privados: `silence-deploy-receipt.json`,
`silence-after-{id}.json`, `silence-smoke-result-{id}.json` e `bloco2-silence-evening.json` em
`.private/runtime/growth-audit-20260924/` fora do repositório público.
