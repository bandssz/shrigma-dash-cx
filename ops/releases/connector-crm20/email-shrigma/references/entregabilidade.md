# Entregabilidade: evidência atual e critérios internos

## Diagnóstico

1. Conferir funcionamento do emissor, fila, aceite/entrega e falhas com timestamp e cobertura.
2. Quebrar por provedor/segmento e verificar público, maturação e tracking antes de inferir reputação.
3. Conferir autenticação pelo header recebido, identidade SES e/ou relatórios DMARC disponíveis.
4. Ler Postmaster quando disponível, com data e ausência de amostra explícitas. Não esperar um relatório inacessível para fazer o restante do diagnóstico.
5. Só então decidir ajuste de público, conteúdo, remetente ou configuração. Não mudar DNS ou quota por palpite.

Abertura baixa, inclusive uma diferença >8× entre provedores, é sinal para investigar; não comprova inbox/spam. Proxy pode aumentar abertura, bloqueio pode reduzi-la e scanners podem gerar cliques. Os resultados históricos permanecem em `aprendizados.md`, sem certificação causal retrospectiva.

## Autenticação

SPF verifica o domínio de envelope; DMARC precisa de SPF alinhado ou DKIM alinhado com o From. No SES padrão, MAIL FROM da Amazon pode passar SPF sem alinhar à marca. Confirmar no header/DMARC e em `GetEmailIdentity`; `Message-ID` e varredura de nomes DNS não comprovam a ausência de Custom MAIL FROM.

Configurar Custom MAIL FROM só com os valores e status da identidade/região atual; o MX deve apontar ao feedback da região e o SPF deve ser único naquele nome. Contar lookups recursivos atuais, sem assumir o número registrado em 05/09. Não alterar políticas DMARC de forma incidental.

Fonte: [Custom MAIL FROM no SES](https://docs.aws.amazon.com/ses/latest/dg/mail-from.html).

## Bulk e reputação

Para grandes remetentes de marketing Gmail, conferir SPF, DKIM, DMARC/alinhamento e descadastro one-click nos headers reais, além do link visível. Não estender automaticamente o mesmo corte numérico a todos os provedores. A diretriz Google exige spam <0,3%; a prática interna conservadora do grupo usa <0,10% para avanço de fatias frias. São critérios diferentes.

Fonte: [diretrizes de remetentes Gmail](https://support.google.com/mail/answer/81126), consultadas em 15/09/2026.

O log de complaints do SES/Listmonk não cobre toda denúncia do Gmail e não substitui o Postmaster. Taxas dessas fontes têm universos diferentes; não subtrair Gmail do denominador sem prova de como a métrica foi calculada. Dado ausente não prova saúde. Não prometer que compliance volta ao verde exatamente 30 dias depois; verificar a ferramenta.

No SES, acompanhar a conta/região e os sinais de reputação, quotas e taxa atuais via acesso disponível. A AWS pode revisar ou suspender envios por problemas; 2%/0,08% são alertas internos conservadores do histórico, não garantia de tolerância. Não requisitar console/CloudShell quando a API já resolve.

Fonte: [reputação SES](https://docs.aws.amazon.com/ses/latest/dg/monitor-sender-reputation.html).

## Público, remetente e rampa

Preservar o remetente aprovado de cada jornada. Os testes antigos favorecem raiz em certos públicos; não tornam “raiz frio / subdomínio quente” uma regra universal. Estado documentado em 05/09: Aristo marketing fora de uso até reavaliação; Fish em testes/rampa. Reconsultar o estado atual antes de retomar. Subdomínio não isola automaticamente todo impacto do domínio organizacional.

Regras internas históricas para fatias frias: medir composição, começar pelos mais recentes, ler segurança antes de ampliar e evitar varredura de não engajados perto de evento crítico. A rampa de ~1.000 Gmail/dia é um ponto histórico de partida, não quota universal; não dobrar mecanicamente sem evidências atuais e autorização do plano.

Manter promessa comercial e planejar capacidade antes da campanha. Uma promessa de horário não autoriza ignorar suspensão, falha de segurança ou supressão. Não reduzir concorrência global de forma incidental: pode afetar o transacional. Dados antigos “50/s, 300k/dia, concurrency 35” não substituem consulta atual.

## Supressões

Verificar status global, descadastro/consentimento de lista, hard bounce/complaint e supressões comerciais da marca. A receita antiga `NOT EXISTS bounces` excluía qualquer bounce e deve ser confrontada com a política atual; não remover supressão vigente silenciosamente. Separar soft bounce recuperável de falha permanente conforme os dados reais.

A regra comercial relatada é evitar promoção a compra recente **ainda não entregue** e a atraso de expedição. O SQL antigo excluía todos os compradores <15 dias, inclusive entregues; corrigir só após confirmar o campo de entrega e o critério adotado. Se a entrega for desconhecida, explicitar a decisão conservadora. Não inventar schema de pedidos no WHERE.

### Descadastro vale para a marca, não para a lista

Para o Gmail, quem saiu de um e-mail da marca saiu da marca: continuar recebendo por outra lista é **descadastro não honrado** (Postmaster "Aceitar o cancelamento — precisa de ajustes": remover em até 48h). Com listas sobrepostas (Base ⊃ Compradores/Leads), um opt-out que vale só para as listas da campanha não basta. Regras:

- `unsubscribed` em **qualquer** lista de marketing da marca = fora de **todas** as listas de marketing daquela marca (propagar, não só respeitar na lista de origem). O comportamento do link de descadastro da versão instalada (listas da campanha × sair de tudo/blocklist) se confere, não se presume.
- Reconciliação, sync noturno, espelho, pop-up e pós-compra **nunca** inserem `confirmed` por cima de quem saiu e **nunca apagam** a linha `unsubscribed` — apagar destrói a prova do opt-out e o próximo `INSERT … ON CONFLICT DO NOTHING` o recoloca. Junções pela lista-base filtram `status = 'confirmed'`.
- Marketing que sai por `/api/tx` (carrinho, browse, boas-vindas, cross-sell, reativação) também respeita esse opt-out — transacional de verdade (pedido, entrega, conta) é que é isento.
- Cliente da Shopify sem consentimento de marketing entrar na Base é decisão de negócio declarada, não default técnico; ela pesa em denúncia e LGPD.

### One-click (RFC 8058)

Todo e-mail de **marketing** — campanha **e** fluxo de marketing por `/tx` — leva os dois headers: `List-Unsubscribe-Post: List-Unsubscribe=One-Click` e `List-Unsubscribe: <https://…>`, apontando para um endpoint que aceite o POST sem login/formulário e aplique o opt-out da marca. Link visível no rodapé não substitui. Provar pelo "Mostrar original" de uma mensagem recebida de cada emissor (campanha, cada fluxo, outros remetentes do domínio e subdomínios — o Postmaster agrega tudo), não pela configuração lida.

Medição dos portões é documentada com fonte/data/público. Campo ausente, API indisponível ou Postmaster atrasado vira pendência explícita, nunca liberação automática.

## Parâmetros vigentes (datados — reconferir, não presumir)

Estes números são o ponto de partida da operação, não constantes universais. Cada um vale até ser remedido; a origem está em `aprendizados.md`.

| Parâmetro | Valor | Data | Observação |
|---|---|---|---|
| Portão de composição, fatia fria | ≥80% abridores → livre · 40–80% → manda e espera T+24h · <40% → fatia | histórico | portão de fatia **fria**; não libera bloco único no dia D |
| Portão de segurança | T+3h; alarme se Gmail <5% | histórico | lê também o Postmaster do dia anterior |
| Postmaster para avançar fatia fria | <0,10% | prática interna | diretriz Gmail é <0,3%; são critérios diferentes |
| Portão de desempenho | T+24h (T+36h em fim de semana); remetente ~T+20h | histórico | ajustar ao início/fim real da fila |
| Espaço entre ondas do mesmo dia | ≥3h | regra | não existe portão intradiário |
| Gmail na lista VIP Aristo | ≈74,8% | 30/08/2026 | recontar antes de usar |
| Gmail nos engajados Fish | ≈58% | histórico | recontar antes de usar |
| Rampa de subdomínio novo | a partir de ~1.000 Gmail/dia, dobrando só com Postmaster <0,10% | histórico | ponto de partida, não quota |
| Capacidade SES | 50/s · 300k/24h | histórico | consultar cota atual da conta/região |
| Vazão Listmonk | concurrency 35 × rate 1 ≈ 35 msg/s | histórico | baixar concurrency é **global** e atrasa o transacional |
| Alertas internos SES | bounce 2% · complaint 0,08% | histórico | conservadores; não são tolerância garantida da AWS |
| `marketing.oaristocrata.com` | fora de uso até re-aquecimento | 05/09/2026 | colapso Gmail 56%→3% foi denúncia de usuário (1,1–1,7% nos 6 primeiros dias, sem rampa) |

Campo ausente, API indisponível ou Postmaster atrasado viram pendência explícita — nunca liberação automática. Dado que envelheceu entra na conversa como hipótese datada, com a data à vista.

## Caminho para voltar a disparar por subdomínio

Vale para `marketing.fishermans.com.br` e para re-aquecer `marketing.oaristocrata.com`. **Não é proibição, é sequência.** Cada etapa produz uma prova; sem a prova, a etapa seguinte não abre. A ordem existe porque o colapso de 15–20/08/2026 foi exatamente o inverso: subdomínio recém-criado recebendo volume de público quente sem rampa e sem leitura de Postmaster.

**1. Infra do subdomínio.** Identidade verificada no SES da região em uso (`GetEmailIdentity`), DKIM assinando com o subdomínio, DMARC do domínio pai cobrindo o filho e alinhamento confirmado **no header recebido** de um envio real — não por varredura de DNS. Custom MAIL FROM é opcional; se for configurar, MX apontando para o feedback da região e SPF único naquele nome, contando os lookups atuais.

**2. Reputação do pai.** Postmaster do domínio raiz <0,10% nos dias anteriores. O Postmaster do pai **agrega os subdomínios**: denúncia no filho suja o compliance da raiz, que carrega o transacional. Subdomínio não isola o que o domínio organizacional sofre.

**3. Rampa.** Começa por público quente (abridores recentes), a partir de ~1.000 Gmail/dia, dobrando só com Postmaster <0,10% no dia anterior e portão de segurança T+3h limpo. Nunca salto, nunca evento crítico como primeiro disparo do subdomínio, nunca não-abridores nos primeiros ciclos.

**4. Remetente por temperatura.** Enquanto a rampa corre, público frio continua saindo pela raiz. O histórico favorece raiz em frio e subdomínio em quente, mas isso é resultado de um teste — reconfirme com o dado da própria rampa antes de tratar como regra.

**5. Ampliar o contrato — só depois de 1 a 4.** Em `campaign-contract.js` (lido em `757af50`, 26/09) o domínio da loja já é mapa próprio (`STORES`, usado no teste de link comercial), mas remetente e Reply-To continuam presos a `BRANDS` na raiz. A mudança que falta é **dar ao remetente sua lista própria** no repositório Growth (`n8n/growth/campaign-contract.js`), sem afrouxar `STORES`:

```js
const SENDERS = {aristo:['oaristocrata.com'], fish:['fishermans.com.br']};   // from_email / reply_to
// subdomínio entra aqui só quando as etapas 1-3 tiverem prova, e uma marca de cada vez
```

`campaign-tracking.js` e `checklist.py` **não** mudam: o mapa deles é da loja, usado para reescrever e validar link. Alterar catálogo, validação e testes junto — é mudança coordenada no repo, não edição de skill.

**6. Ressincronizar a skill.** Depois que o Growth mudar, copie os arquivos para `scripts/lib/` e atualize `source.json` (revisão + sha256). Duas convenções divergentes é o que o manifesto existe para impedir.

**Enquanto 1–5 não estiverem cumpridos:** declarar a pendência. Disparo por subdomínio só sai pelo caminho nativo do Listmonk como tarefa explícita, autorizada e declarada — não se contorna trocando o `from_email` só para passar no validador, nem se migra campanha gerida para o nativo para fugir da proteção. Registrar a decisão com data, marca, público e prova de cada etapa.
