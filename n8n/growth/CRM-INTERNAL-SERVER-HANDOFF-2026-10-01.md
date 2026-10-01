# Repasse CRM para o servidor interno — 01/10/2026

O pacote de publicação parte de main `f7f1739` e preserva as PR206/207/208. A UI geral, o acesso Gerência CRM e a recuperação de preparação antiga já estavam publicados. Este recorte acrescenta o caminho visual de públicos por perfil de compra e versiona os candidatos de RFM e identidade de destinatário. Versionar esses candidatos não instala suas migrações nem libera envio.

## Entregue e disponível

- Login Gerência conserva a autorização CRM; a chave permanece somente na aba.
- Públicos personalizados permitem escolher Fishermans/O Aristocrata, combinar as condições disponíveis, contar, salvar e selecionar na campanha da mesma marca.
- Uma preparação antiga sem contexto pode ser guardada separadamente, após confirmação, para iniciar um público novo. Não apagar o armazenamento do navegador para recuperar o editor.
- Campanhas têm navegação e estados visuais de envio, agendamento e histórico; o monitor e as imagens públicas existentes permanecem preservados.
- A coleta Shopify existente é noturna. Dados ausentes ou expirados não significam “nunca comprou”.

O primeiro uso humano e a cobertura das marcas devem ser conferidos no repasse operacional privado. Testes sintéticos não substituem esse aceite.

## Acrescentado neste recorte, desligado até instalação comprovada

RFM: os sete perfis só preparam públicos quando o catálogo atual confirma a fonte, operação, versão, datas e quantidades. A UI usa o catálogo já carregado, sem consulta adicional para os cartões. O caminho cartão→editor→contar→salvar preserva as proteções das PR207/208, incluindo marca, acesso, rascunho e tentativa incerta. Sem fonte confirmada, as categorias publicadas continuam sendo retratos de análise.

Os cálculos usam Customer GID e dois Bulks completos da mesma loja, Customer primeiro e pedidos atualmente PAID depois. R/F/M usa esse mesmo histórico de pedidos e soma decimal de `currentTotalPriceSet.shopMoney`; não é vendas líquidas nem `Customer.amountSpent`. Empates, recência e critérios estão em `segment-shopify-rfm.md`. Contagens de categoria descrevem clientes da Shopify; a quantidade elegível para envio exige conferir lista nativa, identidade atual e consentimento.

O consumidor em `services/crm-shopify-sync/worker.cjs` começa com `rfmRevision=null`. Main, runtime e rotas HTTP não o chamam. A imagem atual não inclui todos os novos arquivos. O SQL RFM é uma extensão de ensaio; falta instalador operacional selado. Não executar `segment-shopify-rfm.sql` diretamente em produção.

A nova composição das consultas regulares aplica o caminho rápido somente a regra raiz RFM vinculada e sem marcadores A/B. Regras compostas, A/B e campanhas sem vínculo preservam o caminho anterior. A consulta histórica `084a9493…` permanece byte-exata; o candidato `f8bfbb7f…` ainda exige migração de pin e imagem. Não trocar o pin do emissor para fazer o código passar.

Conversão: `recipient-conversion-evidence.sql` e `recipient-conversion-install.cjs` capturam prospectivamente identidade imutável no claim regular, somente após instalação/ativação separada. Começam OFF, excluem A/B e não copiam e-mail. O compilador verifica baseline, fontes, ACLs, RLS, owners, triggers, prazo e locks. Falta a ponte envio aceito→comprador→API/UI. A taxa por compradores únicos ainda não está entregue; não apresentar pedidos/100 enviados como essa taxa.

## Provas e seus limites

- Integração RFM sobre main preservando207/208:131 testes, sem falhas/skips, fontes e bundle.
- PG17.10 descartável nas duas marcas: consumidor de arquivos→papel restrito→catálogo/API→contador→seleção regular; opt-out, UUID/e-mail atual, replay, fonte pausada, export parcial e troca atômica exercitados. Nenhum envio.
- Capacidade local com250mil contatos e500mil pedidos sintéticos, Node22.23.3 e PG17.10. Após agendamento verdadeiro e espera930s: consultas completas candidatas2,476s com1000 destinatários e1,305s comzero; antes do horário nenhum destinatário. A query antiga excedeu10s no scanner nos dois casos.
- Medições de capacidade usam proprietário da fixture, não papel/binário de produção. Node22/Darwin não prova OCI. Cenários A/B compostos usam stub declarado; não provam concorrência da stack completa. Atualizaçõeszero/sparse da escala usam fixture SQL.
- Conversão: seis testes portáteis e sete casos nativos PG17.10 aprovados em bancos descartáveis. Não provam cobertura de destinatários em produção nem conversão.

A CI deste pacote acrescenta os dois testes nativos RFM à matriz Shopify e uma suíte portátil RFM/conversão. Todas as execuções usam dados sintéticos e dependências fixadas, sem credenciais de produção.

## Ordem de execução no servidor interno

1. Fixar o commit realmente mesclado deste pacote e fazer inventário somente leitura dos serviços, bancos, versões, fontes, agendamentos e credenciais montadas. Conferir CI e arquivo publicado. Não reutilizar planos SQL ou recibos históricos como baseline atual.
2. Colocar primeiro o percurso já utilizável de Gerência→público personalizado→campanha no servidor, conservando contrato, autenticação e CORS. Frontend é estático; endpoints estão em `crm-read-config.js` e clientes Growth. Alterações de host exigem revisar CSP no gerador e nos artefatos, sem incluir credenciais no frontend.
3. Instanciar/testar os serviços candidatos OFF, com uma única instância do emissor. A imagem e a configuração devem corresponder ao código testado. Banco Listmonk usa extensões internas `crm_audience_v2`; não copiar grants amplos nem conceder tabelas de fatos à API.
4. Completar o produtor RFM no coletor existente: fases duráveis Customer→Paid Orders sob o mesmo mutex/journal, start intent por query, recuperação de ACK incerto, downloads, lease, ingestão em partes e finalização atômica. Confirmar commit via GET-only; não repetir ingest cegamente. Os Bulks legados do n8n ainda operam fora desse mutex: não adicionar scheduler paralelo.
5. Conferir `read_customers`, `read_orders` e `read_all_orders` para a identidade OAuth EXATA do serviço. Configuração ou permissão de outro app/n8n não prova acesso ao histórico completo. Reutilização das credenciais Shopify das duas lojas foi autorizada; mantê-las em arquivos/env privados e nunca registrar valores em logs, Git ou conversa.
6. Preparar instalador OFF com baseline fresco, pins, owner/ACL/RLS e recuperação de resposta incerta; provar o novo pin com imagem exata/papel real em ambiente isolado. Depois validar a cadência e o readback das duas fontes reais, sem enviar e-mails a clientes para provar a instalação.
7. Completar a ponte da conversão e os gates dos novos fluxos/A/B. Validar opt-out, confirmação, prazo, concorrência, envio único e resultado incerto antes de habilitar transporte.

## Preservações na migração

Manter uma única instância do emissor e conferir o estado real de campanhas e agendamentos antes de qualquer intervenção. Não repetir campanhas concluídas ou operações de resultado incerto. Conservar consentimento, opt-out, identidade e recuperação de respostas perdidas. Componentes fora do CRM e transportes existentes não fazem parte deste recorte.

Topologia ativa, campanhas específicas, acessos e recibos operacionais estão no repasse privado do projeto. Não anexar credenciais ou recibos privados ao repositório público. A presença de imagem ou código no servidor não comprova instalação, configuração, fonte ativa ou permissão de leitura.

## Pendências prioritárias

Públicos por perfil realmente atualizados da Shopify; ponte e taxa de conversão por destinatário; execução natural dos novos fluxos; aceite A/B; cobertura/aceite Olivas e origens VIP/popup; diagnóstico histórico n8n; primeiro uso do analista. Não declarar conclusão pelo push ou pela presença de arquivos no servidor.

Os checkpoints completos e recibos permanecem no projeto local em `deliverables/crm/RETOMADA-CURTA-CRM-2026-09-28.md` e nos índices privados de runtime. Esses diretórios e credenciais não fazem parte deste pacote Git.
