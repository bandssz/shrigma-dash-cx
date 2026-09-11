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


### Operação atual e templates (08/09/2026 · revisado em 09/09/2026)

A aba **Automações** separa **Envios no período**, **Operação atual** e **Templates WhatsApp**.
O objeto `crm_operacao` é um snapshot sanitizado fornecido exclusivamente pela API autenticada
no escopo Growth/todos. Credenciais, parâmetros de workflows e dados de clientes não entram
no contrato do front. A coleta automática roda a cada 5 minutos; a UI distingue conferência
pontual de coleta automática e sinaliza dados com 15 minutos ou mais.

**O inventário é dinâmico.** O coletor mantém a lista de workflows e templates acompanhados;
o painel exibe o que a coleta mais recente devolveu e não fixa quantidades no código. Referências
datadas: 14 workflows/23 templates na conferência de 08/09 às 13h37; 15/24 a partir das 19h15 do
mesmo dia. Esses números são observações, não limites do schema — novos vínculos entram na lista
do coletor (lado Codex) e aparecem no painel na coleta seguinte, sem mudança de front.

Ativação e publicação não comprovam entrega. Modos vêm da versão publicada; serviços
compartilhados aparecem nos filtros de marca. A última execução disponível respeita a política
de retenção: um erro antigo pode continuar aparecendo quando sucessos não são salvos.
Templates mostram status/categoria esperada e observada; cartões aprovados cuja integração ainda
está pendente continuam separados dos templates mapeados nos fluxos. O catálogo traz metadados,
não corpo, componentes ou mídia. O filtro de datas afeta apenas o histórico; marca e canal afetam
também o inventário atual. Falha de consulta de um workflow (`collection_status=error`) aparece
como consulta indisponível, nunca como automação desligada, entrega falha ou operação saudável.
A ausência ou falha de coleta não aparece como estado saudável, e a interface não oferece
controles de edição sem backend.

O incidente `new` com horários nulos no inventário foi corrigido em 09/09 às 17h43 (Brasília):
a coleta de 17h45, conferida às 17h46, preservou configuração de `fish_pix`/`receiver`, com
15 workflows, 24 templates e zero erro de coleta. É evidência datada, não diagnóstico da fila
atual. A separação por `config_collection`/`execution_collection` ainda é proposta em R1.

### Navegação, exportação e estado da tela (09/09/2026)

- **Faixa de fontes** sob os filtros: hora da última resposta da API, último status WhatsApp
  recebido da Meta, última coleta de venda (Shopify), de e-mail (Listmonk) e do inventário.
  Cada fonte tem o próprio horário; a etiqueta só muda de cor quando existe regra conhecida
  (inventário com mais de 15 minutos, consulta que falhou, fonte ausente).
- **KPIs adaptativos**: no canal WhatsApp a primeira linha mostra aceitos, entregues, falhas,
  receita e pedidos; na visão consolidada, entrega WhatsApp e CTR de e-mail; no e-mail, CTR com a
  base medida declarada. Cada KPI tem um atalho para a tabela que o explica, preservando marca e período.
- **Tabelas** (Campanhas, Conversão, Automações, Operação atual, Templates): busca sem acento,
  ordenação por cabeçalho (valor ausente sempre no fim, em qualquer direção), filtros de estado/modo
  nos workflows e status/categoria/uso nos templates, estados vazios que dizem qual filtro esvaziou
  a lista e botão para limpar.
- **Exportar CSV** exporta exatamente as linhas visíveis (busca, filtro e ordenação aplicados),
  com colunas de recorte repetidas em toda linha (marca, canal, período, hora da consulta; nos
  inventários, hora da coleta). Formato: `;` como separador, vírgula decimal, UTF-8 com BOM — abre
  direto no Excel em português. Valor ausente vira célula vazia, nunca zero; receita indivisível
  sai em branco com a coluna "Receita indivisível" = sim; texto que começa com `=`, `+`, `-` ou `@`
  recebe apóstrofo. Não exporta a chave, `version_id`, `id` de template nem nada que a tela não mostre.
- **Estado preservado**: ordenação, busca e filtros vivem em memória, não no DOM; linhas abertas,
  `details` e o cursor da busca sobrevivem à atualização a cada 60 s e à falha de consulta.
  A URL carrega marca, canal, período, seção e aba (`#marca=fish&canal=whatsapp&p=7&sec=regua&aba=templates`):
  copiar o link entrega a mesma tela. A chave nunca entra na URL nem no hash.
- Implementação em `growth-table.js` (funções puras, testadas em `tests/growth-table.test.cjs`)
  e nos testes de DOM em `tests/growth-render.test.cjs`.

### Rascunhos locais de template (Entrega 2 · 09/09/2026)

A aba **Automações › Rascunhos locais** é um editor para escrever e revisar templates de WhatsApp
e e-mail **antes** de existir cadastro pelo painel: nome, marca, canal, idioma, categoria esperada,
peça, cabeçalho, corpo com variáveis `{{n}}`, rodapé, exemplos das variáveis, botões (resposta rápida,
link, telefone), prévia do texto digitado com os exemplos aplicados, checagens locais (perfil conservador
de 1024/60/60/25 caracteres para corpo/cabeçalho/rodapé/botão, até 10 botões, variáveis em sequência,
exemplos, `https://`, aviso de link para atendimento e linguagem de oferta em Utility) e importar/exportar em JSON.

O rascunho fica **só no navegador** (`localStorage`, chave `shrigma_growth_rascunhos`) e a tela diz isso
em todo lugar: não é cadastro na Meta, no Listmonk nem no n8n; não existe botão de publicar, submeter
ou ativar; a prévia é do que foi digitado, nunca de um template publicado (o contrato atual não traz
corpo de template). Se o nome coincidir com um template do catálogo, o card avisa que existe um
template com esse nome e status, sem tratar o rascunho como esse template. Exportação não leva o id local
nem qualquer credencial; importação aceita só campos conhecidos. Integração real: `BACKEND_REQUESTS.md` (R5).
As checagens não certificam aprovação nem categoria na Meta. Na revisão de 10/09, a documentação
oficial de componentes respondeu HTTP 429; não houve recertificação das regras atuais.
Antes de implementar submissão (R5), validar novamente combinações de botões, variáveis por
componente, idiomas e limites do tipo de template suportado.
Código em `growth-drafts.js` (regras e armazenamento, puro) e `growth-drafts-ui.js` (tela).

### Contrato proposto de gestão de templates/workflows (Entrega 3 · 09/09/2026)

`BACKEND_REQUESTS.md` (R5) especifica, para o Codex implementar, o contrato que o painel consumirá
para gerir templates e workflows: capacidades por chave (`capabilities`), leitura de conteúdo e
histórico, rascunho no servidor e validação (sem efeito externo), submissão e acompanhamento
(Meta/Listmonk), controles de workflow (modo/ativação) com chave de escrita própria, versão esperada,
idempotência, auditoria e a distinção rascunho → validado → submetido → publicado ≠ ativo.
`tests/fixtures/growth-templates-contract.synthetic.json` é a fixture sintética desse contrato.
**Nenhum desses endpoints existe**; o painel só exibirá os controles quando a API declarar a
capacidade correspondente — hoje não exibe nenhum.

### Fontes por coleta e saúde dos fluxos (10/09/2026)

A API Growth passou a devolver `crm_fontes` (hora, cadência e status de coleta por fonte — `coleta` ≠ `evento`:
o último status recebido da Meta é push e não indica saúde) e `wa_fluxo_saude` (tabela `shrigma_wa_fluxo_saude`,
gravada de hora em hora pelo workflow "WA · Saúde dos fluxos": gatilho de e-mail sem linha WhatsApp em 2h, aceites sem
status da Meta em 1h, falhas > 20%; task no ClickUp ao virar alerta e a cada 6h). A faixa de fontes usa `crm_fontes`
quando presente (fallback antigo continua) e os chips de saúde dos fluxos aparecem sob ela — só com dado da API;
ausência não vira "saudável".

### Template → workflow e métricas por template (R3 · 10/09/2026)

O coletor de inventário passou a declarar `mapped_in` por template a partir do **manifesto** (workflow, peça e campo
de modo que governa a peça — nunca inferido do nome; `native_pending` fica vazio) e deixou de fixar 15/24 no código.
A API Growth devolve `crm_wa_template` (mesmas métricas de `crm_wa_envios` com a dimensão `template_ref`; a soma por
dia/marca/fluxo/peça reconcilia com a peça). A aba Templates mostra "workflow · peça · modo atual" e
"registros · aceitos · entregues · falhas" do período selecionado, e exporta as três colunas; sem os dados na resposta,
nada é inventado.
