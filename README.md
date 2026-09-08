# Dashboard CX · Grupo Shrigma

Painel interno de CS/CX. Site estático que lê snapshots do Postgres (via webhook do n8n) —
**nunca chama o Gleap diretamente**.

## Arquitetura (3 camadas, nesta ordem)

1. **Coleta** — workflow n8n `CX — Dashboard · Snapshot Gleap→Postgres`
   - A cada 30 min (07–20h SP): atualiza a janela `1d` de hoje.
   - Às 01:15: consolida o dia anterior fechado e grava as janelas `7d` e `30d`.
   - Falha de chamada grava **NULL, nunca 0**. `coletas_ok < coletas_total` marca a linha
     como incompleta e o painel avisa.
2. **Leitura** — workflow n8n `CX — Dashboard · API de leitura` (GET → JSON + CORS).
   Uma chamada devolve tudo: séries diárias, janelas exatas, agentes, votos NPS e fontes semanais.
3. **Tela** — estes arquivos. `dados.js` só faz matemática (testável com node),
   `app.js` só pinta, `config.js` tem a URL da API.

## Tabelas no Postgres (banco do Listmonk, Easypanel)

- `cx_snapshot` — marca × janela × dia (métricas de marca)
- `cx_snapshot_agente` — marca × agente × janela × dia
- `cx_manual_semanal` — Reclame Aqui (jsonb, semanal, via bookmarklet)
- `cx_social_comentarios` — comentários IG/FB via Meta Graph, com sentimento próprio
  (OpenAI). Independe da Replient: volume, respondido, oculto e sentimento são nossos.
  Coleta automática a cada 2h; sentimento classificado 1× por comentário (nunca reprocessa).
- NPS não tem tabela própria: é lido de `subscribers.attribs->'nps'`

Cada coluna tem `COMMENT` no banco explicando origem e pegadinha
(`SELECT obj_description('cx_snapshot'::regclass)` e afins).

## Regras de interpretação (não mude sem entender)

- `trabalhados` por agente = `ticketActivityCount` do Gleap ("Tickets worked on").
  Usar `totalCountForUser` subnotifica o agente pela metade.
- `primeiro_fechamento_seg` é tempo até o **primeiro** fechamento, não resolução total.
- `fila_aberta` é foto do momento da coleta — não existe para dias retroativos (NULL).
- **1ª resposta em expediente** (seg–sex 8h–18h SP) é cálculo nosso, feito no workflow
  noturno `CX — 1ª resposta em horário comercial`: o Gleap não oferece o recorte e o
  parâmetro `businessHours` **zera o resultado com HTTP 200**. Fonte: `/tickets?createdAt>=…`
  (o operador vai no NOME do parâmetro) + `/messages` procurando `type=TEXT` com `bot=false`.
  O painel mostra as duas: expediente (o que o time controla) e espera total (o que o cliente sente).
- Comentários: `respondido_pela_marca` é o que conta como atendimento — `respondido` sozinho
  incluiria resposta de outro usuário. `apagado` é inferência (o comentário desapareceu do post
  entre duas coletas) e só é marcado quando a lista do post foi lida por completo.
- Medianas **não somam**: períodos de 7/30 dias usam a linha de janela exata quando ela
  existe; senão, aproximação ponderada por volume, marcada com "≈" na tela.

## Publicar no GitHub Pages

1. Crie um repositório (ex.: `shrigma-dash-cx`).
2. Suba estes arquivos na raiz (index.html, styles.css, app.js, dados.js, config.js).
   **Não suba** `payload_teste.json` e `teste_dados.js` (são só de desenvolvimento).
3. Settings → Pages → Source: `main` / root → Save.
4. Em ~1 min o painel estará em `https://<usuario>.github.io/shrigma-dash-cx/`.
5. Monitor de parede: abra com `?janela=dia` (ou `?marca=aristocrata&janela=7d` etc.).

> Acesso: o site é público, mas a API exige chave (`?k=`), validada no workflow
> `CX — Dashboard · API de leitura` (nó "Valida chave" — é lá que se troca).
> O painel pede a chave uma vez por dispositivo e guarda em localStorage.
> A chave nunca aparece neste repositório.

## Rodar local

Qualquer servidor estático: `python3 -m http.server` na pasta e abrir `http://localhost:8000`.


## Growth — operação por canal (08/09/2026)

`growth.html` mantém a navegação existente e permite recortar marca, período e canal.
A visão inicial mostra disparos, pedidos e receita atribuída, com cards de WhatsApp e e-mail;
a aba **Automações** separa cada marca/canal/fluxo/peça e permite filtrar a tabela por fluxo.

- `growth-data.js`: datas, campanhas, réguas, atribuição e A/B; funções puras compartilhadas pelo front e testes.
- `growth-delivery.js`: reconciliação dos aceites/status WhatsApp e volumes de e-mail.
- `growth-ui.js` / `growth.css`: cards, indicadores de cobertura e tabela por canal.
- A API já existente recebe `painel=growth` para restringir a resposta quando a chave é mestra; isso não amplia o acesso de outra chave. Nenhuma chave fica no código.

### Significado dos números

WhatsApp usa `crm_wa_envios` e `crm_wa_cobertura`: agregados de 90 dias BRT do motor próprio,
associados aos status pelo ID da mensagem. Aceite não é entrega. `delivered` ou `read` comprovam
entrega; falhas com entrega posterior não duplicam o funil. Registros sem aceite não entram
em disparos. O fluxo explícito `teste-motor` é contabilizado à parte; outros testes internos
podem permanecer porque o histórico não grava o modo. Não inclui volume da Reportana.

E-mail separa campanhas Listmonk e automações: o log transacional comprova aceite da API,
não entrega individual SES. Abertura, CTR e CTOR usam apenas as campanhas com a medição correspondente.
Métricas ausentes ficam como `—`. Receita e pedidos do resumo vêm da data da compra/último clique;
não são uma taxa de conversão da coorte de envios. Receita na tabela de campanhas é acumulada
dos disparos selecionados. Atribuição ambígua entre dois fluxos com a mesma peça não é duplicada.

Comparações percentuais só aparecem para períodos fechados e bases conhecidas. Datas seguem Brasília
independentemente do fuso do dispositivo. O gráfico exclui receita orgânica e não usa cliques de e-mail
como se fossem WhatsApp. A atualização automática mantém o último dado quando há falha e permite repetir.

### Verificação sem navegador

As fixtures dos testes são sintéticas. Não incluir payloads reais, credenciais ou backups da API neste repositório.

```sh
npm install --no-audit --no-fund --prefix ../growth-test-tools linkedom@0.18.12
node --test tests/*.test.cjs
```

O teste de integração usa um DOM local, sem navegador ou chamadas externas. Opcionalmente,
`GROWTH_LIVE_PAYLOAD` pode apontar para um payload agregado privado, fora do repositório,
para reconciliar os indicadores com uma consulta real. A extensão da API foi aplicada separadamente,
com backup, guarda de versão e confirmação da versão publicada.


### Acompanhamento e saúde por conta (08/09/2026)

O aviso de saúde avalia o horário de **cada conta**: uma verificação recente de uma WABA
não encobre outra com dado antigo. Dados ausentes, inválidos, muito futuros ou com mais de
duas horas não recebem sinal verde. Alertas antigos continuam identificados como históricos;
um alerta do monitor não equivale à interrupção de todos os envios próprios. A visão é geral
das contas recebidas pela API e pode incluir atividade de outros provedores.

Os avisos de e-mail respeitam o canal selecionado e mantêm os limiares internos de atenção.
Os percentuais das campanhas selecionadas não são a reputação oficial da conta SES. A AWS
usa volume representativo e critérios próprios; o painel não infere suspensão da conta a
partir desse recorte. Referência conferida em 08/09/2026:
[Processo de revisão de envio SES](https://docs.aws.amazon.com/ses/latest/dg/faqs-enforcement.html).
`gerado_em` indica a geração da consulta, não o horário de coleta de todas as suas fontes.

A seção **Acompanhamento das automações** destaca falhas de entrega, erros anteriores ao
aceite e aceites sem confirmação, agrupados por marca/fluxo/peça. Atalhos abrem Automações
com o filtro correspondente e preservam o período. A ausência de uma contagem em qualquer
parte da base deixa o total desconhecido, em vez de mostrar soma parcial ou zero.
O quadro representa o histórico do recorte, não estado ligado/parado; o último registro é
da peça inteira e não necessariamente da falha. Sombra sem erro não entra como ocorrência.
A cobertura de e-mail permanece informativa até existir reconciliação individual SES.
