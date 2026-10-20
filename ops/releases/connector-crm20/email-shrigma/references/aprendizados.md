# Histórico fornecido na v1 — preservar números, revisar interpretações

Este arquivo preserva integralmente os registros entregues pelo operador na v1. **Não foram revalidados nesta revisão.** Datas, tabelas, hipóteses e conclusões abaixo descrevem o histórico; não são autorização de operação nem estado atual. Em conflito, valem a solicitação atual, SKILL.md e as referências operacionais. Trechos imperativos abaixo são registro histórico: não reativam campanha, não autorizam envio cross-brand, mexida em CX/NPS, cron duplo ou mudança de infraestrutura.

Correções de interpretação para leitura: abertura baixa não quantifica pessoas fora da inbox; razão Gmail/outros não prova filtragem; CTOR acima de 100% pode ocorrer com pixel bloqueado e não é matematicamente impossível; clique também pode vir de scanner; lista congelada prova seleção, não entrega; sucesso de webhook não exclui erro anterior. Causa única de queda, reputação isolada de subdomínio, data exata de recuperação e garantias de performance permanecem conclusões históricas relatadas, não comprovações desta revisão.

A referência antiga a cron duplo não deve ser executada: corrigir fuso/registro e conferir o próximo horário. Pixels de wrapper e body devem somar um, não dois. Consultas por atributo de conversão não são atribuição por pedido/posição. Novos registros devem incluir fonte, data, IDs, universo, janela e limitações, e separar observação de causalidade.

---

# Aprendizados medidos

**Este arquivo é a fonte única dos números.** Os outros arquivos da skill descrevem regras e apontam para cá — se um número mudar, muda só aqui. Nunca replique tabela daqui em outro arquivo.

Números de campanhas reais do grupo. Use como régua antes de projetar resultado.

---

## ⚠️ Postmaster oaristocrata.com — descadastro "precisa de ajustes" (05/10/2026)

**Observação:** compliance com autenticação, alinhamento, DMARC, TLS, spam rate e DNS verdes; vermelhos em "Cancelar inscrição com um clique" e "Aceitar o cancelamento".
**Achado (leitura do workflow "Sync Noturno de Estado (Aristocrata) v2", 05/10, sem execução):** a Auto-Reconciliação junta pela Base (16) sem filtrar status e insere `confirmed` em Compradores/Leads; `remove_de_leads` apaga a linha de Leads inclusive se `unsubscribed`; "Insere Faltantes" liga à Base todo cliente Shopify não blocklisted, sem filtro de consentimento. Combinado com listas sobrepostas, quem sai de uma lista volta a receber pela outra. Fishermans tem os mesmos nós (detalhe não lido).
**Limitações:** volume afetado **não medido**; headers one-click dos e-mails recebidos **não conferidos**; outros emissores do domínio não auditados. Causa do item one-click em aberto.

---

## ⚠️ Abertura por provedor — o número que mais importa

**Cap08 · campanha 61 · 25/08/2026 · subdomínio `avisos@marketing.oaristocrata.com` · 20.579 envios:**

| Provedor | Na lista | Abertura |
|---|---|---|
| Apple | 955 | 77,4% |
| Microsoft | 4.153 | 48,5% |
| Outros | 2.015 | 41,7% |
| Yahoo | 1.342 | 24,7% |
| **Gmail** | **12.647** | **3,0%** |

Agregado: 21%. Ninguém olharia duas vezes. Na real, **61% da audiência não chegou na caixa de entrada** e a peça ficou dez dias invisível.

**Distância normal Gmail × resto nesta conta:** Cap03 18,2% × 68,9% · Cap06 A/B ~18% × ~66% · Cap08 **3,0% × 46,4%**. Três a quatro vezes é o normal. **Acima de oito vezes é filtragem** — para e investiga antes do próximo disparo.

## ⚠️ RESOLVIDO (05/09/2026) — o colapso do Gmail no subdomínio era denúncia, não alinhamento

Postmaster Tools ativado nos dois domínios da marca O Aristocrata. Aba **Spam**, últimos 30 dias, cruzada com o `send_at` real das campanhas do Listmonk:

| Dia | `marketing.oaristocrata.com` | `oaristocrata.com` (raiz) | O que saiu |
|---|---|---|---|
| 14/08 | — | 0,28% | nada em massa · só transacional/welcome da lista 19 |
| 15/08 | **1,13%** | 0,71% | Aquecimento 02 · quentes 15d · 4.994 · **subdomínio** |
| 16/08 | (sem dado) | 0% | Captação 03 · compradores Frescor engajados · 12.005 · subdomínio |
| 18/08 | (sem dado) | **0,98%** | VIP B1 · 2.058 · subdomínio |
| 19/08 | **1,71%** | 0,80% | Cap04 638 + Repique 46 A/B 7.052 · subdomínio |
| 20/08 | **0,95%** | 0,56% | Cap05 · órfãos abridores · 7.903 · subdomínio |
| 21/08 → 03/09 | 0% | 0% (0,14% em 28/08) | 40+ disparos, inclusive **60.648 num dia (02/09)** e fatias frias Gmail de 7–8k pela raiz |

**Leitura.** O subdomínio nasceu em 15/08 e nos seis primeiros dias tomou 1–1,7% de denúncia em público **nominalmente quente**. Reputação de subdomínio novo é zero; o Gmail tratou os primeiros 35 mil envios como desconhecido → caixa de spam → quem achou marcou. Foi isso que derrubou a Cap08 (25/08) para 3,0%. Nunca foi SPF, nunca foi alinhamento de DKIM, e o volume da raiz no dia D (60k) não gerou denúncia mensurável.

A raiz **não mandou nenhuma campanha em massa antes de 21/08** e mesmo assim acompanha a curva do subdomínio em ~0,5–0,6× nos mesmos dias — o Postmaster **agrega o tráfego dos subdomínios na visão do domínio pai**. Denúncia no `marketing` suja o compliance da raiz, que carrega o transacional.

**Compliance "não está em compliance"** é janela móvel de ~30 dias. Sem dia novo ≥0,3%, o Aristo limpa por volta de **20/09/2026** (tarefa de reconferência na lista de alertas do ClickUp, `86akctjfm`).

**Regras que saem disso:** (1) subdomínio novo sobe em rampa de quente, ~1k Gmail/dia, dobrando só com Postmaster < 0,10% — doutrina em `entregabilidade.md`; (2) o portão T+3h lê o Postmaster do dia anterior; (3) quem denuncia é **público sem reputação prévia com o remetente**, não volume — a raiz aguentou 60k/dia e fatia fria Gmail de 8k a 0%.

Os suspeitos ranqueados em 26/08 (reputação degradada · alinhamento não confirmado · diluição da lista 55) ficam registrados como histórico: o primeiro estava certo pelo motivo errado, os outros dois estavam errados.

## Fishermans — Gmail saudável, subdomínio queimado (medido 05/09/2026)

Abridores únicos por provedor nas peças do Copo Térmico (20–24/08), remetente `contato@fishermans.com.br`:

| Peça | Público | Lista | Abridores | Gmail | não-Gmail |
|---|---|---|---|---|---|
| 65 | compradores 15–90d | 5.881 | 20,2% | 19,7% | 21,0% |
| 67 | multi 90–180d | 8.817 | 20,1% | 18,7% | 22,2% |
| 68 | adormecidos | 4.044 | 18,2% | 19,0% | 16,9% |
| 70 / 75 | leads frios | ~7.900 | 17,4% | 15,2–15,7% | 20,1–21,4% |
| 114 | engajados 30d (cross Fish→Aristo, 03/09) | 12.304 | **67,6%** | **63,8%** | 72,7% |

**Gmail ≈ não-Gmail em todos os recortes** (razão ~1×; no Aristo o normal é 3–4×). A raiz da Fish não tem problema de colocação. Régua para peça quente da Fish: 55–65% de abridores únicos.

**Base Fish em 05/09:** 72.579 suprimidos (enabled, sem bounce, fora da lista 33, sem pedido <15d). **58.979 (81%) nunca abriram nada** — 17.960 compradores e 41.019 leads, a maioria já tocada pelo Copo sem abrir. Engajados: 13.600. Cadência de 3/semana é para o trilho quente; o frio entra em fatia de ≤1/semana por pessoa com portão, e aposenta após 3 peças sem abrir em 90d.

**`marketing.fishermans.com.br`:** histórico inteiro são 3 blocos de ~60k em 29h para a base toda (29–30/06/2026, 177.951 envios, campanhas 20–22) e depois silêncio. Caiu em spam por nascimento, não por autenticação (SPF alinhado via Custom MAIL FROM, DKIM ok, compliance verde no Postmaster em 05/09). Re-aquecer pela rampa de subdomínio.

**Remetente `avisos@` × `contato@` na raiz da Fish** (72 × 73, leads frios, 23/08): 1.717 × 1.725 views, 76 × 81 cliques — empate. `avisos@` entra em rampa 1/3 → 1/2 → 1/1 no trilho quente a partir da Carta do Fundador nº1 (06/09, campanhas 115/116, listas 112/113 por `mod(id,3)`).

## Benchmarks por temperatura de audiência

| Audiência | Abridores únicos | Gmail | Fonte |
|---|---|---|---|
| Quentes (abriram nos últimos 30d) | 65% | 58% | aquecimento em 4.994 |
| Órfãos de captação (abridores que não converteram) | 57% | 55% | captação em 7.903 |
| Base de engajados ampla | 42% | 18% | captação em 12.005 |
| Abridores antigos ("ficha") | 23% | — | 2.536 |
| Trilho de destino já convertido | 12–17% | 8–15% | peças VIP em ~2.100 |
| Fria — **compradores 15–45d**, nunca tocados | 4,6–5,5% | ~5% | fatia fria em 8.404 |
| Fria — **45d ou mais** | **2,3–2,4%** | — | fatias frias 2 e 3 |
| Morta — sem abertura há muito tempo | 0,5% | 0,5% | resgate em 1.111 |

**Correção de 26/08:** o benchmark antigo de 4,6–5,5% era só de compradores 15–45 dias. **De 45 dias em diante cai para ~2,3%.** Não projete fatia fria antiga com a régua da recente.

**Lista morta é morta.** 0,5% de abertura, zero cliques, zero conversões — com o remetente bom. Aposente em vez de insistir.

## ⚠️ Lista 19 "VIP de Lançamentos" — é captação, não público quente

Medido: **13% abridora** — 2.209/19.489 em 30/08/2026; 2.764/21.156 em 31/08 (a lista cresce ~1,7k/dia por pop-up e anúncio). **Gmail 74,8%** (30/08) / 74,5% (31/08) — a maior concentração de Gmail da operação.

Projetar peça de "VIP quente" com a régua de quente (42–65%) erra por 4–5×. O nome engana: trate como **captação** e fatie de acordo. Todo número de composição desta lista envelhece em horas — reconte antes de usar.

## ⚠️ CTOR acima de 100% é denominador quebrado — decisão por clique absoluto

Leitura de 30/08/2026 marcou **CTOR de 528%** na campanha 41 (Alma da Roça E7) — matematicamente impossível. Remedição madura em 31/08: **8.722 abridores únicos, 312 clicadores únicos, CTOR 3,6%** (15.074 envios, 1.491 cliques brutos). O 528% veio de cliques brutos sobre um denominador de views subcontado.

Abertura subconta por proxy e bloqueio de imagem, e infla/quebra quando se mistura único com bruto. **Doutrina: quando a abertura parecer impossível ou suspeita, ancore a decisão em CLIQUE ABSOLUTO (clicadores únicos) e conversão** — clique não depende de pixel.

## ⚠️ A "queda para 0,4%" de 30/08 — o que era e o que não era

Diagnóstico de 30/08: desodorante caiu de 66,8% (15/08) para 0,4% (30/08) → "colapso de reputação de domínio". Verificação de 31/08 **derrubou o diagnóstico**:

1. **A medição de view nunca dependeu do tag no body.** Todas as campanhas usam o template 1 do Listmonk (`{{ template "content" . }}` + `{{ TrackView }}`), que injeta o pixel depois do `</html>` — e os clientes renderizam: a campanha 82, sem tag no body, marcou 7.947 views.
2. **Leitura madura da campanha 82** (29/08 22h, quentes, 16.359 na lista congelada): **41,6% de abridores únicos** · Gmail **20,2%** × não-Gmail **60,0%** = 3,0× — banda normal da conta (3–4×), não filtragem (>8×).

**Não houve colapso de entrega em 29–30/08.** O 0,4% foi leitura imatura (disparo às 22h lido na manhã seguinte) e/ou denominador errado. O que **é real e segue aberto**: Gmail em quentes a ~20% contra 54–58% do histórico — degradação a monitorar, registrada na contradição do subdomínio acima. E as seis peças F1–F6 do dia D saíram sem `{{ TrackView }}` no body — risco de medição se o template mudar; corrigidas em 30/08 e o `checklist.py` v2.4 agora reprova.

## Peça que vende — Alma da Roça E4 (campanha 35, dia D 08h VIP, 05/08/2026)

Leitura de 30/08 apontou ~6× a média de clique/envio da campanha. Remedição de 31/08: **2.198 envios · 483 abridores únicos · 112 clicadores únicos (5,1% clique/envio · CTOR 23%)** — a melhor peça da campanha por larga margem. A anatomia completa virou o checklist de oferta em `conversao.md`.

## Maturação das métricas

**Fatia 2 · campanha 78 · domingo 09h:** 1,09% em T+3h → **2,33% maduro**. Quase metade das aberturas entrou depois das 14h.

Uma leitura em T+3h de domingo levou a uma recomendação errada de cortar a peça seguinte. Portão de **segurança** (bounce, complaint) lê em T+3h. Portão de **desempenho** só em T+24h, e fim de semana T+36h.

## Rendimento de VIP por envio em público frio

Compradores 45–90d **0,14%** · 90–120d **0,064%** · abridores antigos **0,32%**.

Serve para calcular se vale escrever a peça antes de escrever a peça.

## Formato

Componentes × carta, assunto idêntico, mesmo minuto, base ao meio:

- abridores únicos: **12,8% × 8,2%**
- Gmail: **11,4% × 4,8%**

A diferença dobra no Gmail. Componentes é padrão, sem discussão.

## Remetente

Teste A/B controlado, T+20h:

| recorte | subdomínio | raiz |
|---|---|---|
| total | 11,7% | **17,2%** (1,47×) |
| Gmail | 8,2% | **14,8%** (1,79×) |
| cohort de LP | 8,4% | **12,0%** (1,43×) |
| endereços novos | 2,9% | **5,3%** (1,84×) |

O subdomínio fazia 54–58% de Gmail em público quente — **e não faz mais.** Causa resolvida em 05/09 (denúncia de usuário nos primeiros dias do subdomínio); ver a seção RESOLVIDO no topo deste arquivo.

## Assunto

**Frio — notícia seca bate identidade/curiosidade:**

- "Dia 2 o Frescor da Mata vira desodorante" → 5,5% abertura, 19 cliques, 13 conversões
- "Você já conhece esse cheiro. Ele só não saía do banheiro" → 4,6%, 12 cliques, 7 conversões

**Quente — quote de cliente bate número institucional.** A/B controlado, Cap06, 23/08, ~11.000 por variante, dados maduros:

| | A — quote | B — número |
|---|---|---|
| Assunto | "O cheiro é viciante" (palavra deles) | "60 mil caras já têm esse cheiro em casa" |
| Abertura | 42,8% | 43,1% |
| **Cliques** | **56** | 38 |
| Complaints | 3 | **6** |

Abertura empatada. Clique **47% maior** e metade das reclamações na quote. **Prova social na voz do cliente é o formato de assunto padrão** para público quente desta base.

## Conversão por peça

| peça | abriu | clicou | CTOR | converteu | taxa |
|---|---|---|---|---|---|
| aquecimento inicial | 268 | 47 | 17,5% | 39 | **83%** |
| captação ampla | 5.026 | 110 | 2,2% | 63 | 57% |
| fatia fria (notícia) | 181 | 18 | 9,9% | 13 | 72% |
| peça de trilho VIP | 392 | 27 | 6,9% | 10 | 37% |
| captação em órfãos | 5.046 | 73 | 1,4% | 31 | 43% |

**Quem clica converte.** O gargalo é o clique.

## Clique → cadastro por peça (vazamento de funil)

fatia 2 **60%** · ficha **73%** · Cap08 **34%** · Cap06 A **20%** · repique de clique **7,7%**.

Acumulado: **213 pessoas clicaram e nunca completaram o cadastro.**

Abaixo de ~30%, suspeite da LP, não do e-mail. No caso medido, o workflow da LP tinha 100+ execuções com sucesso e 1 erro — webhook de pé, atrito no formulário.

## Complaint rate, e por que ele engana

Complaint rate medido no bounce log do Listmonk numa varredura proposta de **82.899 endereços**: **0,013%** — seis vezes abaixo do teto de 0,08%. O argumento era "cabe folgado".

**O denominador não tinha Gmail dentro** (o Gmail não faz feedback loop com o SES) e o Gmail é ~66% da base. O número era verdadeiro e inútil. Varredura cancelada.

## Cohort de LP — o teto é da audiência, não do domínio

Cohort de landing page de anúncio com 9% de abertura parecia problema de spam. Medição: **84,7% dessas pessoas nunca abriram nenhuma campanha, de nenhum remetente** — inclusive gente que era cliente havia meses.

Trocar de remetente melhorou **1,43×** e parou aí. São leads que deixam e-mail e não usam e-mail.

## Escala de teste de remetente

A migração proposta era de **14.750 endereços** de uma vez, por palpite. Teste de remetente se faz em amostra determinística (`mod(id, 7) = 0`), mesmo dia, mesma peça, mesmo público.

## Views e cliques órfãos

`subscriber_id IS NULL`: **13 de 4.759** numa peça, **0** no repique. ~1% do volume. Filtrar `IS NOT NULL` é correto e não distorce — não é fonte de subnotificação.

## Volume Gmail por dia × abertura — série ruidosa

8.961 num dia → 1,5%. 26.139 em outro → 13,5%. Salto de 2.142 para 12.647 destinatários Gmail no mesmo disparo → 3,0%.

**Volume não é o único driver e provavelmente não é o principal.** A regra de rampa em `entregabilidade.md` é conservadora por precaução, não por causalidade provada.

Volume Gmail/dia praticado sem incidente aparente: **5.600 a 9.000**. **Atualização 05/09:** a raiz do Aristo mandou 60.648 no dia D (02/09) e 48.839 no dia seguinte, com fatias frias Gmail de 7–8k dentro, e o Postmaster marcou 0% de denúncia. O driver medido é *quem recebe* (reputação prévia do público com o remetente), não *quanto*. A régua de 9k continua como teto de prudência para fatia **fria**, não para quente.

## Buraco de cobertura

Cruzamento entre quem engajou e quem converteu, num lançamento real: **9.181 pessoas abriram peças e não entraram no destino** — três vezes o público convertido inteiro, e nenhuma peça do calendário falava com elas. Rode em toda campanha longa.

**Desodorante, medido 30/08/2026:** **19.962 pessoas engajaram com a campanha e não estão no VIP** — o mesmo tamanho da lista VIP inteira — das quais **1.415 já clicaram**. E **62.694 compradores fora do VIP**. É o público de maior conversão disponível e, historicamente, nunca teve peça própria.

## Atribuição real do canal

Num lançamento com 4.344 pessoas no destino, **4.150 nunca clicaram em nenhum e-mail**. O e-mail respondeu por ~4% da captação medida. Aquece e converte bem quem toca, mas não é motor de volume quando existe tráfego pago e WhatsApp em paralelo.

## Fadiga

Janela de 8 dias com 9 disparos: 9.408 pessoas receberam 1 e-mail, 15.956 receberam 3, 3.427 receberam 4, 31 receberam 5. **Quatro em oito dias não gerou dano mensurável** em público quente.

## Erros que já custaram caro

- **Ler abertura agregada** sem quebrar por provedor — esconde 61% da audiência fora da caixa de entrada.
- **Comparar duas peças sem ler a query real das listas** — universos diferentes, conclusão inventada ("saturação por volume") que não existia.
- **`subscriber_count` da API de listas** — devolveu 9.938 e depois 14.744 para uma lista de 8.226 reais, e 0 para uma de 16.620.
- **Decidir em T+3h** de fim de semana — quase cortou uma peça que dobrou de desempenho até a noite.
- **Views totais confundidas com abridores únicos** — inflou a régua em 15–25%.
- **`PUT status: cancelled`** a partir de `scheduled` — devolve 400 e a campanha **continua agendada**.
- **`utm_content` idêntico em todos os links** (Cap07, Cap08) — impossível saber qual posição converte.
- **Reply-To ausente em 10 campanhas agendadas** — criadas por API, header nunca é herdado.
- **altbody vazio** — e-mail só-HTML entrega pior.
- **Dark mode com dois buracos** (barra do topo e divider no `data-ogsc`) — só apareceu na auditoria de classes.
- **Falso positivo de auditoria por regex** — duas peças boas acusadas de "carta". E o próprio `checklist.py` v1 acusou 8 classes sadias. Confirme no HTML.
- **`eq-tx` isentada por engano no `LAYOUT`** — passou sem regra dark nos dois mecanismos na Cap08, peça já enviada, sem correção possível.
- **Cron registrado velho** após mudança via API sem deactivate/activate — disparo com 1h de diferença.
- **`import` de módulo com efeito colateral** — duas campanhas duplicadas em produção.
- **Assumir a data do documento de contexto como "hoje"** — leva a tratar peça já enviada como futura e a deixar espelho ativo além do prazo. **Confira a data real antes de agir.**
- **Seis peças do dia D sem `{{ TrackView }}` no body** (30/08) — o pixel só existia por cortesia do template 1. `checklist.py` v2.4 reprova.
- **f-string de Python colapsa `{{ }}` em `{ }`** — o TrackView saiu quebrado mesmo "depois de corrigido"; gerador em f-string precisa de `{{{{ TrackView }}}}` no fonte. Só o checklist pegou.
- **Pré-voo verde num build que não aconteceu** (30/08) — o gerador quebrou, o HTML antigo ficou em disco e o checklist validou o arquivo velho. **Apague a saída antes do build.**
- **`utm_source=email` no template contra `listmonk` na prática** — peça montada pelo template sumia do dash.
- **CTOR de 528% aceito como leitura** — denominador quebrado; ver a doutrina do clique absoluto acima.
- **Tratar a lista 19 "VIP de Lançamentos" como público quente** — é 13% abridora, captação de pop-up/anúncio.
- **Estrear subdomínio sem rampa** — `marketing.oaristocrata.com` (35k em 6 dias, 15–20/08) e `marketing.fishermans.com.br` (178k em 29h, 29–30/06) caíram em spam por nascimento. Nos dois casos a autenticação estava certa.
- **Diagnosticar queda de Gmail sem abrir o Postmaster** — três suspeitos ranqueados em 26/08 e o dado que resolvia estava numa aba que ninguém tinha aberto.
- **Dois `v=spf1` no mesmo nome** (raiz da Fish até 05/09) — permerror, o receptor descarta os dois.
