# Requisitos de ativação no fluxo publicado

Candidato em sombra, sem publicação, instalação ou liberação operacional. O status autenticado da publicação pausada agora pode explicar o que falta para ativar: executor sem aprovação ou sem confirmação recente, mensagem ainda sem confirmação no serviço de envio, execução desligada, manutenção fechada, infraestrutura ausente ou período de execução já aberto.

O percurso usa a API lifecycle existente, o papel restrito `crm_audience_api` e a tela do fluxo. `CRM_AUDIENCE_GRAPH_READINESS_ENABLED` nasce `false`. Quando habilitado em um ambiente que já possui as extensões, o status acrescenta `activation_readiness`. O navegador valida marca, jornada, versão, hash da publicação, campos exatos e prazo de 30 segundos. “Atualizar requisitos” faz somente GET; uma leitura expirada não permanece apresentada como atual. A publicação, rascunho preservado e recibos continuam intactos.

## Limite explícito

Este status não é uma revisão persistida de ativação. Não gera `admission_review_hash`, não abre período de admissão, não despausa, não muda controles, não cria clone e não autoriza envio. A resposta sempre permanece bloqueada por `cache_identity_unverified`: uma instância física do Listmonk/cache ainda precisa ser comprovada independentemente do processo Node. O nome `cache_target`, um hash aprovado administrativamente ou uma lease viva do grafo não fornecem essa prova.

O heartbeat opt-in `CRM_GRAPH_WORKER_HEARTBEAT_ENABLED` do `crm-flows` produz apenas evidência de funcionamento do processo. A aprovação administrativa nasce OFF; as funções de lease não recebem grants automáticos. O próximo instalador precisa conceder somente a função de heartbeat ao login dedicado, depois da conferência administrativa da identidade. A API recebe somente a função agregada de readiness, sem acesso direto à lease, deployment, hashes ou UUID do processo. O executor ainda não usa a lease como gate de claim: essa ligação transacional faz parte da etapa posterior e precisa ser comprovada antes de ativar.

## Composição SQL

Depois da extensão de publicação e acesso runtime, instalar `journey-graph-worker-lease.sql` e `journey-graph-activation-readiness.sql` em uma transação, com controle global OFF e papéis já preparados. A instalação não habilita nenhum controle. O helper aceita os pins da publicação que o servidor já conferiu e os compara novamente no banco. Expõe apenas estado, motivos e validade; corpos de mensagens, destinatários, credenciais e pins internos não saem na resposta.

A resolução nativa usa o release/material da revisão publicada e o alvo fixado no deployment. Clone ausente ou ainda sem confirmação bloqueia o status. Qualquer período de execução aberto bloqueia nova ativação, mesmo na mesma jornada: este incremento não presume que um período antigo pertence à nova autorização. Ausência de uma dependência não se transforma em sucesso.

## Próximo incremento

Comprovar separadamente a identidade física do serviço de envio/cache e integrar preparação/reconciliação pelo provider nativo existente. Depois, criar a revisão curta persistida e o commit único que reconfere publicação, controles, lease, clone e identidade do cache antes de abrir a admissão e despausar. Claim e novas admissões devem reconferir a lease, preservando a reconciliação e a propriedade de participantes já existentes quando ela expirar. Até essa prova completa, a ativação permanece indisponível.
