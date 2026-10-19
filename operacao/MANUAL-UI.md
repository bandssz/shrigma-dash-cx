# MANUAL-UI — governança da informação do sistema Shrigma

Vale para toda tela nova ou reformada em CRM, Afiliados, Influs e Orgânico. Tela que não cumpre estas regras não vai para prévia nem para produção.

## R1 — Uma pergunta por página
Cada tela responde a uma pergunta do analista, escrita na primeira linha do spec e do arquivo.

| Tela | Pergunta |
|---|---|
| Início | Como foi o e-mail neste período e o que está programado? |
| Campanhas | O que vai sair, o que saiu e como foi? |
| Jornadas | Quais réguas estão rodando e como vão? |
| Públicos | Quem vou alcançar? |
| Modelos | Que peças tenho prontas? |
| Resultados | O que está dando resultado? |

Conteúdo que não ajuda a responder a pergunta não entra.

## R2 — Três camadas
- **Decide** (topo): até 4 números, cada um com variação contra o período anterior.
- **Explica**: 1 gráfico + 1 tabela.
- **Detalha**: só ao clicar (drawer ou página de detalhe).

Nada abaixo da dobra é informação nova; é aprofundamento do que está em cima.

## R3 — Limites por tela
≤ 4 indicadores no topo · ≤ 1 gráfico principal · ≤ 1 tabela principal · ≤ 8 colunas (o resto no detalhe) · ≤ 2 avisos simultâneos · ≤ 1 ação primária no cabeçalho.

## R4 — Dicionário único de métricas
Mesmo nome, mesma definição, mesmo cálculo e mesma base de tempo em todas as frentes. Nenhuma métrica nova entra sem dizer que decisão ela ajuda a tomar.

| Nome | Definição | Cálculo |
|---|---|---|
| Enviados | Mensagens aceitas pelo Listmonk | contagem de aceites |
| Entregues | Mensagens com entrega confirmada pelo SES | contagem de Delivery |
| Pessoas alcançadas | Destinatários únicos com entrega | distinct destinatário em Entregues |
| Taxa de abertura | Pessoas que abriram ÷ pessoas alcançadas | aberturas únicas ÷ alcançadas |
| Taxa de clique (CTR) | Pessoas que clicaram ÷ pessoas alcançadas | cliques únicos ÷ alcançadas |
| Pedidos | Pedidos pagos atribuídos ao e-mail | último clique não-direto, janela de 30 dias (modelo da Shopify) |
| Receita atribuída | Soma dos pedidos acima | mesmo modelo; nunca dividida entre peças |
| % da receita da loja | Receita atribuída ÷ receita total da loja no período | — |
| Conversão | Pedidos ÷ pessoas alcançadas | só quando as duas bases existem; senão "—" |
| Ticket | Receita atribuída ÷ pedidos | — |
| Descadastros | Pessoas que saíram pela peça | contagem única |
| Rejeições | Entregas recusadas (bounce) | hard e soft separados só no detalhe |

## R5 — Aviso, etiqueta ou nada
- **Aviso (banner)**: só quando o analista precisa agir ou quando o número está errado/incompleto. Topo da página ou da seção, com a ação ("Dados até 14h · Atualizar"). Nunca mais de dois por tela.
- **Etiqueta (badge)**: estado de um objeto, uma palavra, no passado ou particípio — Rascunho, Agendada, Enviando, Enviada, Pausada, Parcial. Frescor como chip no cabeçalho ("atualizado há 12 min"). Detalhe no `title`.
- **Nada**: mecânica interna (revisão, recibo, versão, fonte, cache, aceite da API, CI, digest, cobertura, snapshot); ressalva que não muda decisão; disclaimer repetido; "em breve" em botão que o analista não usa.
- **Indisponível**: a célula existe e mostra "—", com motivo e desde quando no `title`. Nunca parágrafo embaixo de tabela. Nunca tela branca: sem dado no período, cair para a última janela com dado e etiquetar "dados de [período]".

## R6 — Linguagem de negócio
Substituições obrigatórias:

| Não | Sim |
|---|---|
| revisão | versão (só no histórico) |
| vínculo | público da campanha |
| utm_campaign | campanha nos links |
| E/OU | todas as condições / qualquer condição |
| TEST, QA | Teste interno |
| aceite da API | enviado |
| recibo | confirmação |
| fonte | origem dos dados (só no `title`) |
| coorte | grupo |

Texto de estado diz o que fazer, não o que aconteceu por dentro: "Teste enviado às 09h45 — costuma chegar em até 5 min".

## R7 — Período único
Um seletor global (hoje, ontem, últimos 7 e 30 dias, esta semana, semana passada, este mês, mês passado, personalizado) com comparação contra o período anterior. Todo número da tela obedece a ele. O que escapa do período (histórico completo de uma campanha) fica na página de detalhe com a própria etiqueta de janela.

## R8 — Layout
Tabler. Cabeçalho = título + período + uma ação primária. Página de lista = filtros + abas de status + tabela. Página de detalhe = duas colunas (conteúdo 2/3, contexto 1/3). Formulário = passos numerados numa página só, um botão salvar, estado ocupado visível. Blocos únicos de largura total — nada de cartões duplos lado a lado. Celular (390 px): indicadores empilham, tabela rola por dentro, menu não cascateia.

## R9 — Gráficos
Só quando a tendência decide algo. Um por tela. Linha para tempo, barra para comparação, nunca pizza. Eixo com unidade. Sempre com comparação (linha do período anterior ou variação %).

## R10 — Processo
Toda tela nova nasce com: a pergunta (R1), a lista de indicadores tirada do dicionário (R4), prévia em 1440 e 390 px nas duas marcas com dados reais da conta de teste, antes de produção. Tela que precisa de parágrafo para ser entendida reprova.

## Referências (copiar organização, densidade e hierarquia — nunca código, texto ou marca)
- **Shopify Analytics**: cards com variação % contra o período anterior; seletor de comparação; cada card leva ao relatório; 4 métricas no topo.
- **Shopify Polaris**: banner no topo da página/seção com como resolver; badge de uma palavra no passado para status de item; erros de formulário inline.
- **Klaviyo**: detalhe de campanha em Visão geral (engajamento no tempo, entregabilidade, resumo da peça) + Atividade por destinatário; agregado de 30 dias com faixas de desempenho.
- **HubSpot**: clicar numa métrica abre as pessoas por trás dela; "não enviado" com motivos (rejeitado, descadastrado, teto de frequência).
- **Stripe**: progressivo — visão alta primeiro, detalhe no ritmo do usuário; estimativa na home, número exato no relatório; hierarquia por tipografia e espaço, navegação por tarefa.
- **RD Station**: vocabulário em português (entregas, aberturas únicas, cliques únicos, descadastros); referência ao lado do número (95% entrega, 15% abertura, 2% clique, ≤3% hard bounce, ≤0,1% spam, ≤1% descadastro).
