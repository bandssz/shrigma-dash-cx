# CRM atual — guia para o time e a skill de e-mail

Atualizado em 20/10/2026. Gateway instalado: e9ab89fd; Campanhas c3448ea6, Públicos 5e550aff. CI com imagem real, saúde nativa e HTTP 8/8 conferidos. Agenda grande e percurso completo passaram nas duas marcas, restritos a QA/Gestão. A janela de 20 minutos a 7 dias e o fim do teto seguem restritos até o “passou” de Felipe.

**Disponibilidade:** as fontes de Afiliados, Influs e Orgânico voltaram; leitura com dados conferida nas duas marcas. A infraestrutura registrou a recuperação natural das rotas do n8n, sem alteração/reinício por produto. A direção visual aprovada foi implantada somente no CRM, preservando as outras frentes. A prévia pública foi removida (404); o painel antigo continua disponível. [Autorrevisão e prints](../referencias-ui/AUTORREVISAO.md).

**Turno da noite 16→17/10:** públicos editáveis/arquiváveis/restauráveis e produto comprado/não comprado, vários e E/OU passaram nas duas marcas. Modelos por etapa persistem; HTML, pausa/retomada, janela de Brasília e pedido de revisão foram provados em TEST interno. Resultados reúne os disparos por identificação de campanha nos links. Nenhuma ativação comercial foi liberada.

**Ensaio de 17/10, às 05h:** nas duas marcas, públicos novos com produto positivo/negativo foram contados, salvos, editados de E para OU, reabertos, arquivados e restaurados. Duas jornadas novas de duas etapas concluíram pausa e retomada; os quatro e-mails chegaram à caixa interna com o HTML e as imagens conferidos. Os dois públicos deste ensaio foram arquivados novamente; nenhuma seleção comercial foi usada no envio. Quatro frentes, período, comparação e reload: 16/0 vistas. Resultados acumulados, CSV, Modelos e Campanhas: 4/0 vistas. Início do CRM: 1,43–1,52 s; Resultados: 2,04–2,87 s nesta rodada. Picos anteriores de 3,39/3,57 s continuam registrados: a estabilidade abaixo de 3 s ainda não está encerrada. Naquele ensaio, agendamento/cancelamento nativos não foram provados; as campanhas protegidas #188–#191 ficaram intactas. Evidências: `operacao/runtime/noite-20261016/rehearsal-*-safe.jsonl` e `rehearsal17-physical-inbox-proof.json`. Os dois guias HTML foram atualizados a partir dos originais; a skill permaneceu intacta.

## Remetentes — 17/10

Em Campanhas, Aristo oferece avisos@oaristocrata.com e avisos@marketing.oaristocrata.com; Fishermans oferece avisos@fishermans.com.br e avisos@marketing.fishermans.com.br. Respostas para é contato@oaristocrata.com ou contato@fishermans.com.br. Uma marca não vê a opção da outra. Escolha, salve e aguarde desaparecer o aviso de tentativa pendente antes de recarregar; depois reabra. Contato nunca é remetente. Os quatro pares foram salvos e reabertos pela interface.

Nas jornadas TEST, o remetente é avisos do domínio principal e as respostas vão para contato da marca. HTML e imagens foram recebidos e conferidos às 09h46–09h47 nas duas marcas. Escolher entre os dois remetentes por jornada ainda falta. Em campanhas, as novas revisões avisos@marketing chegaram nas duas marcas às 09h45 e 09h49. Fishermans levou cerca de três minutos e meio entre aceite e caixa; não repita uma tentativa aceita ou incerta. O conector da caixa não fornece o cabeçalho Reply-To nem MIME bruto; Reply-To foi conferido na prévia/API e no corpo da requisição nativa.

## Acesso e filtros

Entrar em [CRM](https://crm.shrigma.com.br/) com o acesso individual. **Os acessos dos dois analistas já estão criados.** Frente, marca e “Permitir alterações” são permissões separadas. A senha do CRM não dá acesso ao Listmonk.

Em **Marca de trabalho**, na lateral, escolher O Aristocrata, Fishermans ou Todas as marcas permitidas. No celular, abrir a navegação pelo botão ☰. Para editar, escolher uma marca específica. Olivas aparece somente para quem tem permissão; sua fonte segue indisponível. Nos links abaixo, substituir `brand=aristo` por `brand=fish` abre Fishermans. Ordem do menu: **Início → Resultados → Campanhas → Públicos → Jornadas → Modelos**. O laboratório de teste é aberto dentro de Jornadas.

O canal E-mail/WhatsApp recorta a análise; não autoriza envio. O período é compartilhado entre frentes e marcas e continua no reload: hoje, ontem, últimos 7/30 dias, esta/semana passada, este/mês passado e personalizado. Brasília; semana de segunda a domingo. Datas explícitas na URL prevalecem. O período do topo recorta relatórios; as janelas de compras/engajamento dos públicos são regras próprias. Sem dados, a última janela disponível aparece com aviso e a seleção é preservada. Conferir janela, origem e atualização; falta de cobertura aparece como indisponível.

## Telas e percurso

Menu: **Início → Resultados → Campanhas → Públicos → Jornadas → Modelos**. O Início guia Público → Mensagem → Campanha → Automação → Resultado; Mensagem leva a Modelos. Teste é uma etiqueta, sem menu próprio.

| Tela e link | O que funciona hoje | Limite atual |
| --- | --- | --- |
| [Início](https://crm.shrigma.com.br/app/crm/?brand=aristo&view=home) | Receita e pedidos atribuídos, envios, cliques registrados, saúde e próximas campanhas conforme cobertura; marca e período. | Taxas, conversão e peso na receita total dependem das fontes disponíveis. Cliques registrados não são pessoas únicas. Na última publicação, as quatro frentes preservaram os números; um pico de 3,39 s no Início não se repetiu nos controles. A estabilidade abaixo de 3 s continua em aberto. |
| [Públicos](https://crm.shrigma.com.br/app/crm/?brand=aristo&view=audiences) | Combinar listas, quantidade/valor/última compra, engajamento e produtos comprados/não comprados, um ou vários, com E/OU; contar regras admitidas, reabrir públicos existentes e selecionar como referência no formulário da campanha. Criar, contar, editar o mesmo público, arquivar, restaurar e reabrir passaram com a conta de teste nas duas marcas. As versões anteriores ficam preservadas. A tela mostra a última sincronização Shopify efetiva, separada da leitura do catálogo. | Produto positivo, negativo, múltiplos produtos e E/OU foram contados e editados pelo painel nas duas marcas; a consulta em lote preserva desconhecido sem convertê-lo em zero. Coleção e primeira compra por data ainda precisam de fonte confirmada. Arquivar retira de Ativos e da seleção da campanha; em Arquivados, abra e restaure a definição intacta antes de editar. Fonte/versão alterada exige nova conferência. Contagem elegível inclui consentimento e escopo da marca; não é o total bruto de clientes da Shopify. |
| [Modelos](https://crm.shrigma.com.br/app/crm/?brand=aristo&view=templates) | Abrir arquivo UTF-8 de até 200 KB, conferir prévia e marca, salvar novo rascunho e reabrir o conteúdo. Importação → campanha → teste → agenda → cancelamento passou nas duas marcas. | Em QA/Gestão, scripts, redirects e destinos de links fora da loja impedem salvar; os demais pontos aparecem como avisos por linha. A prévia isola ações e recursos externos; confira também os endereços originais de links e imagens. |
| [Campanhas](https://crm.shrigma.com.br/app/crm/?brand=aristo&view=campaigns) | Público salvo primeiro, contagem, Peça/prévia e rascunho. Em QA/Gestão, após criar, Ajustar links usa o identificador real da campanha; salve novamente e confira os links. TEST interno recebe o prefixo [TESTE]. Agenda nativa e cancelamento passaram no percurso completo: Aristo 196.157 e Fish 82.213 elegíveis. Final Rascunho, sem data nem envio comercial. | QA/Gestão: 20 minutos–7 dias, sem teto; estimativa a 60 mil/h. Editores conservam 20 minutos–2 horas/10 mil. Os ciclos grandes anteriores também passaram com dois cancelamentos em cada marca. Escolha outro endereço interno somente se o campo estiver liberado. Abertura aos editores e primeira campanha comercial dependem de Felipe. |
| [Jornadas](https://crm.shrigma.com.br/app/crm/?brand=aristo&view=journeys) e [Laboratório](https://crm.shrigma.com.br/app/crm/?brand=aristo&view=lab) | Consultar as sete definições existentes; criar do zero ou copiar carrinho; editar entrada, público de referência, esperas, condições de saída e e-mails; salvar/reabrir no servidor. No ensaio, duas jornadas novas foram pausadas/retomadas e receberam quatro e-mails, dois por marca; relatório por etapa indica aceite da API, sem inventar entrega. | Só a conta interna participa. O teste padrão envia texto; em Ativar teste com HTML, cada etapa usa a peça final escolhida em Modelos, congelada no início. Disponível para a própria caixa corporativa de usuários com edição CRM. Escolha dias/horas de Brasília na entrada e salve: fora da janela, o teste aguarda. Salvar/reabrir, janela fechada/aberta e HTML físico passaram nas duas marcas. A execução iniciada mantém HTML e horário originais; editar o rascunho não muda esse teste. Ativação comercial continua desligada. A primeira ativação real exige HTML do modelo recebido e conferido na caixa nas duas marcas, além das proteções e aprovação. Condições de saída do ensaio não são um construtor geral de bifurcações. Não editar nem iniciar outra revisão enquanto houver execução ativa ou incerta. Editar o rascunho não altera o teste já iniciado; adoção de etapas futuras está em preparo. Compra real, frequência compartilhada e exclusividade com as sete jornadas ainda não estão provadas. A janela de Brasília já passou em teste. Ativação comercial permanece bloqueada. |
| [Resultados](https://crm.shrigma.com.br/app/crm/?brand=aristo&view=results) | Campanha acumulada por identificação nos links (utm_campaign): totais ponderados de envios/entregas/aberturas/cliques, evolução, disparo por disparo e CSV recortado pela busca. Pedidos e receita usam o total próprio da campanha no período/modelo escolhido, sem somar peças. Evolução geral, onde a venda fecha, tabela por peça, receita assistida e % novos preservados. | Engajamento usa todos os disparos presentes no histórico da fonte; pedidos/receita respeitam o período e o modelo. Histórico disponível não significa histórico integral. Parcial mostra somente o subtotal comprovado; ausência não vira zero. Assistências não se somam à receita atribuída. Receita compartilhada não é dividida arbitrariamente por peça. |

**Montar e manter um público:** Novo público → nome e regras admitidas → Contar agora → Salvar público → reabrir. Para editar, alterar → contar novamente → Salvar alterações; o ID é mantido e nasce outra revisão. Para arquivar, salve ou descarte alterações locais → Arquivar público. Feche o editor para ver a lista; em Arquivados → Abrir regras → Restaurar público, a definição arquivada volta intacta. Regra sem fonte confirmada não vira zero.

**Importar a peça da skill:** Modelos → Importar peça pronta → colar ou abrir arquivo UTF-8 → Conferir prévia → Salvar novo rascunho → Reabrir. Em Campanhas → 2. O quê → Peça, escolha a revisão e confira a prévia na mesma página. Aguarde Rascunho salvo antes de sair. A peça conserva os padrões da marca; salvar não envia.

**Ensaio anterior de 16/10 às05h — registro histórico:** públicos lista + compra confirmada Shopify contados/salvos/reabertos: Aristo 98.269 elegíveis (8,9 s), Fishermans 24.251 (2,6 s); contagens não equivalem ao total bruto da loja. Duas jornadas novas salvas e reabertas, pausa/retomada, relatório e quatro recebimentos físicos. Campanhas novas #194/#195 criadas uma vez, reconciliadas por leitura e reabertas exatamente; dois TEST recebidos, sem alterar as campanhas. O roteiro inicial navegava antes da conferência assíncrona; foi corrigido sem repetir CREATE. Dezesseis vistas das quatro frentes, nas duas marcas/1440/390, com período e reload; mais oito conferências de troca real de marca, fallback e restauração do período. Shopify atualizada automaticamente: Aristo 03h05, Fishermans 03h32. Naquele ensaio, agendamento/cancelamento ficaram indisponíveis no editor.

**Público primeiro:** em Nova campanha → 1. Para quem, escolha o público salvo e aguarde a contagem confirmada. Ao criar, o CRM congela a lista dessa revisão para a campanha nativa. Não escolha listas avulsas para substituir o público. Se a confirmação ficar pendente, use Consultar tentativa para acompanhar o mesmo pedido; não crie outra campanha.

**Resultados conferidos nesta atualização:** quatro CSVs (peças e conversão, nas duas marcas) exportados com recorte e metadados; desktop/celular sem quebra após o ajuste do gráfico. A rolagem das tabelas é interna.

**Registro A/B:** guarda hipótese, variantes, métrica e janela por pessoa e marca. Não divide público, agenda, envia ou declara vencedor.

**Imagens:** a skill usa imagens públicas dos produtos na Shopify. As referências encontradas em modelos não comprovam marca. Biblioteca integral e upload não são necessários para importar a peça.

## Nesta semana: CRM e Listmonk

- **CRM:** consulta e análise, filtros/CSV, públicos admitidos, preparação de campanhas, importação de peças, planejamento A/B e jornadas em teste.
- **Skill de e-mail:** somente copy, design, seleção de imagens Shopify e qualidade; entrega HTML e texto para importar no CRM. Não é o executor da operação.
- **[Listmonk](https://email.shrigma.com.br/):** o CRM usa a agenda nativa e permite cancelar antes do início. O percurso ampliado foi conferido em QA/Gestão nas duas marcas. Operação comercial segue o procedimento aprovado e o ok de Felipe.
- **Jornadas:** as sete publicadas continuam preservadas. O novo laboratório não inscreve clientes. Primeira ativação real depende de aprovação e das proteções ainda pendentes.

## Não operar

Continuam **em breve**: teste direto de modelo, ativações comerciais, coleção e primeira compra por data. A agenda ampliada funciona somente em QA/Gestão; a abertura aos editores depende do aceite de Felipe.

Itens QA são para conferência. Uma campanha QA pode conter público grande; TEST interno usa somente o endereço interno indicado. Ao encerrar a prova, confira Rascunho, data nula e enviados0. Não contorne botão nem repita envio aceito ou incerto. Preservar #188/#189 e os rascunhos/testes históricos; não convertê-los em campanhas comerciais. SES, DNS, remetente e supressões permanecem protegidos.

## Paridade antiga × nova

| Item | Situação |
| --- | --- |
| Navegação, Início guiado, marcas permitidas e canal | Portado em Tabler; fonte Olivas falta. |
| Evolução, peças, onde a venda fecha, atribuição, assistências, % novos e CSV | Portado conforme cobertura. |
| Automações por canal, campanhas × automações e carrinho | Consulta portadas; pedidos/receita por definição exigem vínculo revisado. |
| Públicos: listas, compras e engajamento | Criar, contar, editar, arquivar, restaurar e reabrir; produto comprado/não comprado, vários e E/OU provados nas duas marcas. Coleção e primeira compra por data ainda faltam. Público congelado e agenda QA já foram conferidos no Listmonk. |
| Campanha acumulada por identificação nos links | Portada e conferida nas duas marcas; taxas ponderadas, detalhe por disparo e CSV. Respeita cobertura; receita/pedidos usam o período. |
| Modelos | Importação HTML/texto e reabertura provadas; formulário passou nas duas marcas; prévia isolada e importação priorizada. TEST direto em breve. |
| Registro A/B | Planejamento individual salvo; execução automática fora deste bloco. |
| Jornadas montáveis | Autoria, Modelos por etapa salvos, HTML corporativo interno, pausa/retomada e janela real provados nas duas marcas. Pedido de revisão recebido pelo proprietário; ativação comercial, gatilhos automáticos e demais proteções continuam em breve. |
| Agendamento e cancelamento pelo CRM | Nativos e conferidos nas duas marcas. QA/Gestão: 20 minutos–7 dias/sem teto; editores conservam seus limites até aceite de Felipe. Cancelar antes do início retorna a Rascunho sem data. |

“Recebeu X e não abriu”, reenvio protegido, grupo de controle e fontes analíticas adicionais continuam na fila. O painel antigo no GitHub Pages segue preservado até a paridade completa. Nenhum cliente recebeu mensagem nas provas.

Materiais HTML em operacao/guias-20261016/ atualizados a partir dos dois originais do time, com CSS, estrutura e interações preservados. A skill original foi lida como referência e não foi alterada. REVISAO-EMAIL-SHRIGMA.md traz oito ajustes sobre trechos efetivamente lidos. Os guias refletem os percursos provados e marcam o restante em breve.


**Pedir ativação:** após salvar e reabrir a jornada, o pedido conserva essa revisão e chega à caixa de solicitações de Felipe, em Gestão → Gerenciar acessos → Solicitações de jornadas. Consultar pedido recupera o recibo; não ativa nem inscreve clientes.

Provas e histórico técnico: operacao/ESTADO.json; recibos de publicação em operacao/runtime/noite-20261016/. Os registros históricos anteriores deste guia foram preservados no backup privado; a operação atual está descrita acima.

**Shopify em17/10:** conclusões automáticas Aristo03h13 eFishermans03h33(Brasília),visíveis emPúblicos. Recontagens atuais do mesmo público por produto:6/10.578 elegíveis,três respostas iguais por marca; lista e consentimento fazem parte da contagem. EmFishermans eram10.558 antes da nova captura; não comparar como se fosse o mesmo retrato.

17/10, sprint da manhã — Campanhas destaca receita/pedidos por marca + campanha dos links, com recorte de vendas por período e abertura dos disparos. Parcial é subtotal conhecido; sem cobertura aparece Indisponível. Conversão permanece indisponível até existir base comparável de compradores e destinatários. Prova real4/0 vistas, originais4/0, Resultados/Modelos4/0 e quatro frentes16/0. Início1,33–1,72s nesta rodada; Campanhas2,59–4,14s: meta global abaixo3s aberta. Nenhum envio ou nova agenda.
