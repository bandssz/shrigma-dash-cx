# Instalação composta do executor CRM, inicialmente desligado

Estende a base `crm_graph_candidate` já usada pelos rascunhos Fish/Aristo. Não reaplica o schema inicial nem cria serviço, senha, login, participantes, épocas, templates ou capacidades do painel. O papel `crm_graph_worker` nasce NOLOGIN, sem membership e sem poderes administrativos. O banco deve continuar com o grafo OFF e a retenção CART aberta na versão 2.

`deploy.cjs` compõe source → release → native → cart → dispatch-receipt → maintenance → papel restrito em um único DO. Congela os arquivos, funções, relações, privilégios, índices, triggers e controle existentes. O papel recebe somente os objetos e colunas usados pelo executor; as permissões necessárias para locks não permitem alterar a linha. A função de chave do destinatário precisa ser SECURITY DEFINER, com fingerprint revisado: a tabela da chave não fica acessível ao worker.

O runtime ainda é código confiável: este papel não fornece isolamento por linha/marca, e as inserções nos recibos/reservas continuam autorizadas ao executor. As guardas preservam consentimento, identidade, controles e a delimitação do primeiro carrinho. Não usar esta conexão em APIs públicas ou com SQL fornecido pelo painel.

## Fases

O chamador injeta o transporte privado e um `FileStore` novo. Nenhum endpoint/segredo está no código. `snapshot()` é somente leitura; após revisão do snapshot, `prepare({snapshot_sha256})` fixa o plano. `install(plan_hash)` faz uma leitura fresca, grava/fsync o intent privado antes do SQL e verifica o resultado por nova leitura. `reconcile()` só lê: qualquer timeout/erro posterior ao intent bloqueia uma segunda instalação automática, inclusive quando não se sabe se houve efeito.

Os quatro workflows protegidos são CART produtor/consumidor, pedidos/popup e API de templates. São comparados por versão e export completo; o utilitário SQL também é conferido. Os quatro workflows precisam usar a mesma referência de credencial PostgreSQL do utilitário, cuja leitura atesta `current_user=postgres`; outro papel exige uma revisão de compatibilidade antes da instalação. O instalador não faz PUT, ativa workflow ou chama transporte de e-mail. Os artefatos privados são 0600 e não devem ser versionados.

A instalação preserva os rascunhos e a retenção existente, mas modifica o claim legado, acrescenta proteções em templates/assinantes/listas e estende o estado da retenção para delegação. Por isso a regressão PostgreSQL de CART com grafo OFF é obrigatória. A escrita exige CI verde, revisão do plano e prova dos papéis usados pelos serviços existentes. Não basta um healthcheck do worker.

## Selos e sequência operacional

O schema do grafo recebe o selo `crm-graph-install-v1`; o da retenção recebe `maintenance-cart-graph-install-v1`, preservando o selo anterior na propriedade `previous`. Os planos CART antigos deixam de ser válidos por definição. O instalador TX atualizado aceita esta cadeia somente com os fingerprints atuais dos dois schemas, do papel e das dependências públicas. A instalação TX estende os dois selos atomicamente; o readback do grafo confere o predecessor contra seu comprovante original. Planos anteriores precisam ser refeitos. Não forjar o selo anterior nem ignorar drift.

Depois deste recorte ainda faltam configurar o serviço OFF, confirmar instância/cache, integrar a entrada autenticada, admitir participantes com ownership e habilitar publicação/ativação pelo painel com aceite operacional. Nenhuma dessas funcionalidades é entregue apenas pela composição do instalador.
