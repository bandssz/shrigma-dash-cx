# Serviço interno dos fluxos CRM

Menor runtime Node para o primeiro e-mail CART Fish/Aristo da PR137. Continua dependente de PostgreSQL, n8n (recebimento/agendamento) e Listmonk (transporte). Não é a migração de plataforma proposta para depois da estabilização.

A configuração observada do n8n 2.0.2 não disponibiliza `pg` no Code node. Este serviço separado evita mudar módulos globais ou reiniciar n8n/Listmonk. Ele não inicia cron, admite participantes, publica revisões, abre épocas nem ativa capacidades do painel. Nasce com `CRM_FLOWS_ENABLED=false`; SQL e coortes também precisam estar expressamente habilitados para executar.

## Fronteira

Porta interna 8080, sem domínio público, portas publicadas ou CORS. Um bearer aleatório de pelo menos 43 caracteres, em configuração privada, autentica todas as operações. O n8n deve usar credencial própria de header, nunca código contendo a chave. A chave gestor do painel não serve nesta fronteira.

- `GET /healthz`: somente vivacidade, revisão e execução habilitada/desabilitada. Não afirma disponibilidade do banco, autorização de envio, cache ou entrega.
- `POST /internal/source`: recibos estritos do coletor allowlisted. Captura não inscreve pessoas.
- `POST /internal/tick`: marca e limite 1–5. Usar 1 na primeira integração. Sem retry; recibos/reservas existentes são consultados antes de novo trabalho.
- `POST /internal/reconcile`: marca e intenção. Só concilia; não repete transporte.

JSON até 196.608 bytes, cabeçalhos até 8 KiB, duas operações concorrentes, sem fila HTTP interna. Falhas retornam código estático, sem payload, contatos ou erros remotos. Resposta perdida exige conciliação durável; não tratar 503 como licença de reenvio. Conexões são encerradas após a resposta; desligamento deixa a chamada atual terminar antes de fechar o pool. Uma parada forçada pode deixar tentativa incerta, que continua bloqueada.

## Configuração e implantação

O carregador exige destinos fixos: banco `listmonk` no serviço interno conferido e origem HTTPS `https://email.shrigma.com.br`. `shops` liga cada marca ao GID e domínio Shopify comprovados; OAuth renova tokens em memória com limite/timeout e sem retry automático. A imagem não contém credenciais.

Variáveis necessárias: `CRM_FLOWS_REVISION`, `CRM_FLOWS_TOKEN`, `CRM_PG_HOST`, `CRM_PG_USER`, `CRM_PG_PASSWORD`, `CRM_PG_DATABASE`, `CRM_LISTMONK_ORIGIN`, `CRM_LISTMONK_AUTHORIZATION`, `CRM_LISTMONK_CACHE_TARGET`; para cada prefixo `CRM_FISH_` e `CRM_ARISTO_`, `SHOP`, `SHOP_ID`, `CLIENT_ID`, `CLIENT_SECRET`, `COLLECTOR`. `CRM_FLOWS_ENABLED` é false se ausente. Não imprimir nem versionar os valores. Configuração inválida impede boot sem revelar qual valor era secreto.

Plano de instalação: um novo app interno `comunicacao/crm-flows`, uma réplica, sem sobreposição na atualização, pool máximo 4, sem portas públicas, build do Dockerfile deste diretório com contexto da raiz e ref Git imutável. Revisar capacidade do host e papel PostgreSQL antes de criar. Configurar inicialmente OFF; conferir revisão, vivacidade e leitura agregada do worker antes de ligar qualquer entrada. Nenhum serviço foi criado por esta implementação.

Ainda faltam instalador composto dos schemas/grants, confirmação da instância/cache, ponte autenticada n8n para os coletores, admissão controlada e publicação/ativação pelo painel. `healthz=200` não elimina essas etapas. Não anunciar ativação no helper de capabilities antes do aceite real.

## Provas e retorno

CI usa PostgreSQL isolado, HTTP sintético e imagem sem rede externa para provar boot OFF, fronteira, execução única entre dois workers e recuperação. Fonte Node22 fixada por digest oficial; dependência `pg` com lockfile. Nenhum teste cria assinante ou envia e-mail real.

Antes de ativar, retorno é remover a ligação nova e manter OFF. Depois de ativação futura, interromper novas entradas, preservar ownership/dispatch/recibos e conciliar chamadas em curso. Nunca apagar reserva nem devolver uma coorte ao legado para repetir envio. Não atualizar instâncias existentes do Easypanel como parte deste pacote.
