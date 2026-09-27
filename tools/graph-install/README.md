# Instalação composta do executor CRM, inicialmente desligado

Estende a base `crm_graph_candidate` já usada pelos rascunhos Fish/Aristo. Não reaplica o schema inicial nem cria serviço, senha, login, participantes, épocas, templates ou capacidades do painel. O papel `crm_graph_worker` nasce NOLOGIN, sem membership e sem poderes administrativos. O banco deve continuar com o grafo OFF e a retenção CART aberta na versão 2.

`deploy.cjs` compõe source → release → native → cart → dispatch-receipt → maintenance → papel restrito em um único DO. Congela os arquivos, funções, relações, privilégios, índices, triggers e controle existentes. O papel recebe somente os objetos e colunas usados pelo executor; as permissões necessárias para locks não permitem alterar a linha. A função de chave do destinatário precisa ser SECURITY DEFINER, com fingerprint revisado: a tabela da chave não fica acessível ao worker.

O SQL enviado começa em `DO $graph_install$` e termina no fechamento desse bloco, sem SET, SELECT, BEGIN ou COMMIT externos. O `lock_timeout` de 500 ms configurado dentro do DO limita cada espera individual por lock; não limita a duração total da instalação. O instalador exige `statement_timeout_ms` inteiro entre 1 e 30000 na conexão: a preparação e o readback recusam campo ausente, zero ou valor acima do limite. A primeira guarda do DO, antes de locks ou DDL, confere novamente o setting efetivo daquela conexão. O timeout precisa estar ativo antes de enviar o comando; o instalador não altera essa configuração nem aceita setá-la dentro do bloco como substituto. O timeout HTTP do cliente não cancela nem limita a execução no PostgreSQL.

O runtime ainda é código confiável: este papel não fornece isolamento por linha/marca, e as inserções nos recibos/reservas continuam autorizadas ao executor. As guardas preservam consentimento, identidade, controles e a delimitação do primeiro carrinho. Não usar esta conexão em APIs públicas ou com SQL fornecido pelo painel.

O snapshot lista em `public_create_schemas` os schemas não sistêmicos que concedem CREATE a PUBLIC. Essa lista precisa estar vazia: um papel novo também receberia esse privilégio. A preparação recusa o ambiente antes de criar plano ou intent, o DO confere novamente antes das migrations e o readback recusa uma concessão posterior. O instalador nunca revoga privilégios compartilhados para superar esse bloqueio; corrigir a configuração exige uma revisão coordenada dos demais serviços.

## Fases

O chamador injeta o transporte privado e um `FileStore` novo. Nenhum endpoint/segredo está no código. `snapshot()` é somente leitura; após revisão do snapshot, `prepare({snapshot_sha256})` fixa o plano. `install(plan_hash)` faz uma leitura fresca, grava/fsync o intent privado antes do SQL e verifica o resultado por nova leitura. `reconcile()` só lê: qualquer timeout/erro posterior ao intent bloqueia uma segunda instalação automática, inclusive quando não se sabe se houve efeito.

Os quatro workflows protegidos são CART produtor/consumidor, pedidos/popup e API de templates. São comparados por versão e export completo; o utilitário SQL também é conferido. Os quatro workflows precisam usar a mesma referência de credencial PostgreSQL do utilitário, cuja leitura atesta `current_user=postgres`; outro papel exige uma revisão de compatibilidade antes da instalação. O instalador não faz PUT, ativa workflow ou chama transporte de e-mail. Os artefatos privados são 0600 e não devem ser versionados.

A instalação preserva os rascunhos e a retenção existente, mas modifica o claim legado, acrescenta proteções em templates/assinantes/listas e estende o estado da retenção para delegação. Por isso a regressão PostgreSQL de CART com grafo OFF é obrigatória. A escrita exige CI verde, revisão do plano e prova dos papéis usados pelos serviços existentes. Não basta um healthcheck do worker.

Os testes executam o SQL compilado e verificam que o banco retorna um único resultado de comando, além de provar rollback integral e conexão saudável após uma falha tardia. Esses testes de banco não substituem a verificação do transporte n8n/webhook. A remoção de um prefixo externo corrige o contrato de um único DO; não identifica por si só a causa de uma resposta HTTP vazia. Intents e planos de tentativas anteriores permanecem preservados e não autorizam repetição automática.

## Selos e sequência operacional

O schema do grafo recebe o selo `crm-graph-install-v1`; o da retenção recebe `maintenance-cart-graph-install-v1`, preservando o selo anterior na propriedade `previous`. Os planos CART antigos deixam de ser válidos por definição. O instalador TX atualizado aceita esta cadeia somente com os fingerprints atuais dos dois schemas, do papel e das dependências públicas. A instalação TX estende os dois selos atomicamente; o readback do grafo confere o predecessor contra seu comprovante original. Planos anteriores precisam ser refeitos. Não forjar o selo anterior nem ignorar drift.

Depois deste recorte ainda faltam configurar o serviço OFF, confirmar instância/cache, integrar a entrada autenticada, admitir participantes com ownership e habilitar publicação/ativação pelo painel com aceite operacional. Nenhuma dessas funcionalidades é entregue apenas pela composição do instalador.
