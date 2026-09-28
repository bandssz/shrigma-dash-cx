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

## Imagem candidata OFF no registro

O workflow manual `crm-flow-image-publish.yml` prepara `ghcr.io/bandssz/shrigma-crm-flows`. Este código não comprova imagem publicada e não cria serviço. Executar somente depois do merge e dos checks da revisão escolhida:

```sh
gh workflow run crm-flow-image-publish.yml --repo bandssz/shrigma-dash-cx --ref main -f source_sha="<SHA completo revisado da main>"
```

O SHA precisa ter 40 caracteres hexadecimais e pertencer à história de `origin/main`; vazio seleciona a revisão da main que iniciou o workflow. Um probe independente exige a configuração e a autorização efetiva fixadas em `crm_graph_worker`, recusando revisões anteriores a essa guarda. Isso não concede LOGIN: o papel continua indisponível para conexão até a transição operacional autorizada.

O primeiro job copia somente fontes permitidas do Git para um contexto limpo, confere os hashes do Dockerfile/package/lock existentes, roda testes, constrói Linux/amd64 e testa o boot OFF sem rede. Não recebe credenciais de produção ou token do registro. O OCI acompanha revisão, hashes do arquivo/manifest/config e identificação do run. A conversão Docker→OCI pode reserializar a configuração e mudar seu digest. Por isso, o teste importa a própria OCI no daemon, exige que ID e camadas da imagem importada coincidam com `config_digest` e `rootfs.diff_ids` da OCI e inicia o container por esse ID. Também confere a identidade do container e que o arquivo OCI permaneceu intacto; usa apenas configuração sintética. O manifest Docker importado serve somente à execução local: a publicação preserva o manifest e os bytes da OCI original.

Somente o job seguinte recebe `packages: write`. Ele verifica novamente o artefato daquele mesmo run e copia seus bytes com preservação do digest, sem reconstrução ou execução do artefato. A tag é `sha-<SHA completo>`: digest já igual é conciliado, diferente é recusado. Não existe tag operacional `latest`. Resposta incerta gera somente readback; não há segundo push automático. Negação de acesso ou timeout não são tratados como ausência de pacote.

O recibo `crm-flows-registry-receipt-<run>` registra `REGISTRY_VERIFIED_NOT_DEPLOYED`, revisão e referência `ghcr.io/bandssz/shrigma-crm-flows@sha256:…`; a futura instalação deve usar essa referência por digest. Publicação autenticada não comprova pull público, serviço instalado, cache nativo, execução ou entrega. Nenhuma ativação decorre deste workflow.

Verificação local sem Docker, registro ou produção: `python3 -m unittest discover -s tools/crm-flow-image -p 'test_*.py'`. A CI `Private CRM flow service` executa essas guardas e o percurso real Docker→OCI→Docker importado→boot OFF, usando o mesmo helper do publisher. Essa prova de PR não cria recibo publicável nem acessa o registro.

## Provas e retorno

CI usa PostgreSQL isolado, HTTP sintético e imagem sem rede externa para provar boot OFF, fronteira, execução única entre dois workers e recuperação. Fonte Node22 fixada por digest oficial; dependência `pg` com lockfile. Nenhum teste cria assinante ou envia e-mail real.

Antes de ativar, retorno é remover a ligação nova e manter OFF. Depois de ativação futura, interromper novas entradas, preservar ownership/dispatch/recibos e conciliar chamadas em curso. Nunca apagar reserva nem devolver uma coorte ao legado para repetir envio. Não atualizar instâncias existentes do Easypanel como parte deste pacote.
