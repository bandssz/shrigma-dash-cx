# A/B de e-mail Fish/Aristo — candidato de núcleo e seleção

**Não implantado. CRM07 ainda não está concluído.** O registro descritivo v1 e seus históricos continuam intactos. Nenhum envio, agendamento, lista, destinatário real ou serviço foi alterado. Os arquivos v2 ainda não estão ligados à UI ou a uma rota HTTP.

## O que está implementado

- Protocolo imutável: duas campanhas CRM em rascunho, da mesma marca, versões exatas e mesmas listas originais; divisão 50/50 de toda a base elegível, sem parcela restante nem envio automático da vencedora.
- `crm_ab_prepare_v2`: deduplica por ID interno Listmonk, preserva opt-in/opt-out e bloqueio global, recusa desabilitados e base acima de 100 mil. Gera seed no servidor; ordenação SHA256(seed + ID) sorteia uma permutação e divide ao meio (diferença máxima de uma pessoa). IDs e seed nunca entram na resposta ou no navegador.
- Uma coorte ativa por marca. Chave primária impede uma pessoa em dois braços; o mesmo UUID/ator/payload recupera o mesmo resultado, sem novo sorteio. Nova identidade não substitui o experimento. Leitura `crm_ab_operation_v2` devolve o recibo exato do próprio ator; ausência não autoriza repetição.
- Contagens por braço: alocados originais, revogados, envios contabilizados pelo Listmonk, pessoas com ao menos um clique rastreado e pessoas sem fonte. O denominador fica congelado após opt-out; cliques repetidos contam uma vez e só na variante atribuída, dentro da janela.
- Resultado usa o protocolo guardado, janela fixa de 24–168h, mínimo por braço e diferença mínima em pontos percentuais. Após a janela e a conclusão de ambos os envios, Fisher bilateral exige `p < 0,05` e diferença observada pelo menos igual ao mínimo escolhido. Empate, pouca amostra, interrupção e evidência insuficiente não produzem vencedora. Há teste contra um oráculo independente de combinações inteiras, incluindo zeros e grupos desiguais. [Definição do teste de Fisher — NIST](https://www.itl.nist.gov/div898/software/dataplot/refman1/auxillar/fishexac.htm).
- Opt-outs não significam falha de medição; exclusão de pessoa/eventos, cliques anônimos ou cruzados, alteração de rastreamento e números contraditórios significam desconhecido. Não se usa UTM, abertura, receita atribuída ou ausência de dados para inventar conversão. A métrica é **clique rastreado por pessoa alocada**, inclusive possíveis scanners; não clique humano garantido, CTR por entregue ou compra.

`ab-experiment-core.sql` cria quatro tabelas privadas e funções de alocação/leitura. `ab-experiment-selection.sql` mantém ativação OFF, impede edição/envio individual dos rascunhos associados, registra término do native worker e invalida evidência alterada. As guardas retornam sem alterar campanhas não associadas a A/B. SQL v2 é migração de criação única: recusa nomes já existentes; precisa preflight fresco antes de instalar.

## Transporte escolhido e dependência do host

Copiar contatos para listas A/B cria uma segunda inscrição e exige sincronizar descadastro nos dois sentidos. Duas transações de opt-out podem segurar origem e derivada em ordem oposta; uma ponte por trigger ingênua pode falhar por deadlock. Esse caminho não foi implementado.

O candidato mantém **as listas originais nas duas campanhas**. Acrescenta apenas um `AND` de coorte às consultas `next-campaigns` (contagem) e `next-campaign-subscribers` (lotes). O nativo continua aplicando opt-in, bloqueio, ordenação, limite e checkpoint. Seu link de descadastro continua apontando para as inscrições originais. Uma revogação confirmada vale na próxima seleção de lote; mensagens já selecionadas em memória mantêm a janela de corrida que o nativo já possui. [Consultas oficiais v6.1.0](https://github.com/knadh/listmonk/blob/v6.1.0/queries/campaigns.sql), [descadastro nativo](https://github.com/knadh/listmonk/blob/v6.1.0/queries/subscribers.sql).

`ab-listmonk-cohort-patch.cjs` exige SHA256 upstream `37b1b131a6b9005141b1bf2e32dde53a68838184bc4348f6c97fb61b581c5882` e produz `b1a3dafd0502622d70a1b28b8ff09956acc48541bb883ff0e0894089ea42c817`. Qualquer versão ou âncora diferente exige nova revisão. A fonte `initFlags/initFS` 6.1 carrega queries embutidas; `static-dir`/`i18n-dir` não oferecem override de queries. **É necessário custom build do serviço.** Não há script que modifique o host. [Inicialização oficial](https://github.com/knadh/listmonk/blob/v6.1.0/cmd/init.go).

Campanhas não A/B usam um teste de pertinência calculado por init/hashed plan; não chamam a função por destinatário. Isso preserva seus resultados, mas ainda acrescenta custo de planejamento/consulta. Não se pode declarar impacto zero em produção a partir da fixture. O `native_query_sha256` é recibo de implantação a ser preenchido somente após comprovar o binário/worker real; não é prova autônoma só por existir no banco.

## Provas realizadas e faltantes

Passaram localmente protocolo, SQL PGlite, guardas, acesso gestor e recuperação v1. A prova privada com as **consultas upstream integrais** alocou 1.000 pessoas sintéticas em 500/500, overlap zero, preservou checkpoints e retornou 498 após um opt-out de origem e um bloqueio global. A seleção de campanhas comuns retornou exatamente as mesmas linhas.

Fixture de aproximadamente 100 mil membros, lote de 1.000 e nove medições aquecidas: mediana inicial 3,55ms original / 3,00ms candidato, variação de ambiente, não benchmark do host. Plano confirmou init/hashed subplan. Reexecutar no PostgreSQL e volume/índices equivalentes ao host antes de aceitar o desempenho.

O CI inclui PostgreSQL 17.10 com duas sessões: mesmo UUID, mudança de catálogo durante espera por lock, opt-out antes da alocação e antes do próximo lote. **Essa etapa aguarda CI**; Docker local está sem daemon, portanto não foi declarada como passada. A prova upstream baixa apenas a fonte pública versionada e verifica seu hash antes de executar em banco sintético; nunca recebe URL de produção.

## Antes de ficar operável

1. Revisar e provar o custom build em ambiente isolado, comparando consultas, contagens, paginação, cancelamento e carga de campanhas não A/B. Confirmar versão instalada e usuário do banco; conceder apenas os acessos necessários ao worker, sem grants PUBLIC.
2. Completar o coordenador A/B: revisão fresca do público/conteúdo, agendamento dos dois braços e recibo em uma transação, cancelamento de ambos antes do início, recusas definidas com recibo durável. Nenhuma função de agendamento está incluída neste núcleo. A guarda já recusa o agendador comum.
3. Integrar a API/UI v2 com sessão gestor, confirmação mostrando marca/campanhas/contagens/data, journal durável antes do único POST e GET de operação para resultado incerto. Não reutilizar o journal v1 fingindo que seu payload é v2. Os métodos internos SQL não são uma rota pública nem prova de autorização por si.
4. Autorizar acesso/janela do host e plano de troca com seu responsável. Instalar SQL OFF; nenhuma coorte real antes de todo o conjunto estar revisado. Trocar o worker sem dois emissores ativos concorrentes; preservar filas/checkpoints e comprovar os painéis/serviços compartilhados. Só então registrar o build verificado, habilitar a capacidade e a UI, com prova técnica sem destinatários. Um envio real continua dependendo da ação confirmada do gestor.

Estimativa restante: coordenador/API/UI e testes, 2–4h; build, staging, revisão de carga e troca do host, mais 2–4h de trabalho técnico **se acesso, responsável e janela estiverem disponíveis**. Não é promessa de prazo enquanto essas condições forem desconhecidas.

Reversão: cancelar/parar as campanhas A/B pelo controle nativo e confirmar que nenhum pipe/lote A/B permanece ativo; desabilitar runtime; voltar ao artefato anterior preservando banco/recibos/guardas. Nunca voltar ao binário sem filtro enquanto uma campanha A/B puder executar sobre as listas originais. Não remover funções/tabelas usadas por um worker ainda rodando o build com filtro.

Nenhum arquivo, workflow ou tabela exclusiva de CX foi lido ou alterado. A mudança no serviço compartilhado está apenas proposta e exige avaliação de impacto antes de implantação.
