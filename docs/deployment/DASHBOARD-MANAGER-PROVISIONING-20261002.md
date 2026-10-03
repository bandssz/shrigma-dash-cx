# Credenciais individuais dos gestores — preparação isolada

Base desta etapa: `5ec3653c4a822a2d22e38fc4778f4094dad8768d`, branch `codex/dashboard-candidate-crm-fix-20261002`, worktree separado. A hospedagem instalada continua em `10fee73e150b5685e18ab0ff1d9abc41da4e1cdd`. Esta etapa não habilita escrita, não publica novos serviços, não altera o acesso mestre nem muda tráfego.

O convite com e-mail, área e pedido de leitura/edição já existe. A lacuna é emitir automaticamente uma identidade própria na origem, confirmar essa identidade e revogá-la também na origem. Copiar uma chave administrativa para gestores não resolve essa lacuna.

## Implementação candidata

`crm-manager-provisioning.cjs` prepara um transporte privado com origem HTTPS fixa, autenticação específica do serviço, comandos fechados, limite de corpo/resposta e prazo total. O bearer do gestor permanece no portal; a origem recebe seu digest. Recibos vinculam namespace, emissor, pessoa, lifecycle, principal, geração e intenção. Status permite reconciliar uma confirmação perdida após reinício. Edição permanece recusada antes de qualquer chamada.

`crm-manager-journal.cjs` mantém intenção e candidato cifrado no SQLite, separado do slot ativo. Seus hooks exigem a transação do cadastro. Uma renovação conserva a chave ativa durante a preparação; antes de tentar o commit, grava o estado incerto e bloqueia a leitura do predecessor até reconciliar/promover a nova geração. Revogação registra um tombstone e uma operação durável antes da exclusão local. Respostas antigas não restauram o lifecycle revogado. Identidades legadas e o administrador ficam fora desse namespace.

O material cifrado, digest e identidade da candidata são conferidos antes da atestação e da promoção. Recibos terminais têm MAC persistido para impedir alteração por replay. Candidata preparada vencida pode ser reconciliada e substituída; um commit potencialmente enviado exige consulta do mesmo identificador e não pode ser descartado pelo relógio. O primeiro provisionamento também pode tentar novamente após expiração confirmada.

Os hooks de convite, aceite e revogação agora estão ligados ao journal **somente quando `createAuth` recebe a configuração privada `crmManagedRead`**. O journal integra o pacote fechado. O ponto de entrada do servidor não fornece essa configuração e não inicia cliente, processamento de fila ou emissor. Portanto o cadastro automático continua desligado no portal instalado. O perfil desligado não cria tabelas de provisionamento.

A UI candidata informa preparo, acesso pronto/pendente e revogação pendente usando apenas o estado público. Confirmação local de revogação não é apresentada como confirmação da origem. Transferir um gestor para outra área exige revogar e criar outro convite; não reaproveita o link antigo. O pedido de edição permanece registrado, mas não concede edição nem reutiliza uma chave legada.

`services/crm-manager-provisioner` é um serviço novo e isolado, desligado por padrão, com quatro RPCs parametrizadas e autenticação própria. `n8n/access/crm-manager-provision-v1.sql` propõe somente objetos novos para um namespace e registra as intenções/gerações na mesma transação da origem. Não cria papel, cadastra emissor, concede privilégios de produção ou modifica funções/ACLs existentes. O primeiro administrador e identidades não mapeadas permanecem fora desse namespace.

Status devolve o recibo histórico imutável de prepare/renew vencido para reconciliar um ACK perdido e encerrar a candidata local. Isso não renova o prazo nem reativa a chave. Replay direto e commit vencido continuam recusados; revogação do lifecycle prevalece também sobre status e respostas antigas.

## Evidência desta preparação

Os testes locais usam duas contas sintéticas, SQLite descartável, PGlite descartável e transporte em processo. Exercitaram convite, senha, emissão, atestação contratual, promoção, renovação, revogação, replay após reinício, perda de confirmação e preservação do administrador. Falhas de persistência foram injetadas para comprovar rollback de senha, consumo de convite e intenção. Os testes da UI comprovam os estados exibidos sem segredos; não comprovam uso humano no portal instalado.

A rodada local final dos componentes novos passou em **84 testes**, sem falha; a prova nativa foi pulada nessa rodada porque depende do PostgreSQL efêmero da CI. A revisão independente do journal passou em 23 grupos adversariais; a dos hooks de autenticação passou em oito e a do gateway em 19. A regressão existente do portal passou em Node22, incluindo HTTP apenas em loopback. A CI exclusiva desta branch constrói as duas imagens fora do servidor, verifica UID e importa o emissor sem abrir socket/banco. Uma prova adicional em PostgreSQL nativo descartável está preparada para ACL e concorrência; somente execução bem-sucedida dessa job constitui evidência nativa. Publicação de imagem exige um marcador explícito e os dois jobs verdes.

Essas provas não comprovam cadastro no PostgreSQL real, permissões gerais de leitura do banco atual, configuração de TLS/ingress ou cadastro pronto no portal instalado. Não foi criada nenhuma conta, chave ou alteração SQL de produção nesta etapa.

## Consulta real de metadados

Em 02/10/2026 às 20h30 BRT, uma consulta fechada verificou somente catálogo, permissões e contagens/datas de cache. O utilitário existente foi conferido por leitura de sua versão publicada e configurações de retenção. O SQL usou uma conexão, transação repeatable-read/read-only, limite de 4 segundos, encerramento de transação ociosa em 5 segundos e rollback. A resposta passou por um parser fechado antes de sair do processo privado.

- O CHECK atual de painel aceita `growth`, entre os escopos legados conhecidos; não admite os novos nomes sugeridos `organico-read`/`influs-read`.
- Orgânico tinha um cache recente; Influs não tinha linha nessa estrutura. Não se deve assumir uma fonte pronta de Influs por esse caminho.
- Os papéis avaliados não constituem uma restrição completa de leitura em todos os caminhos do banco. O leitor CRM continua limitado por sua superfície HTTP revisada; essa limitação não é prova de todos os ACLs do PostgreSQL.
- Nenhuma linha de chave, hash de chave, payload ou dado de negócio foi retornada. Não houve DML, DDL, função de autenticação, agendamento ou envio.

SQL usado: SHA-256 `35ba091e71e4b4ebec31a721bc906cbb10d94f4eb2aa75a9f3707dd8df118c46`. Parser usado: `ffe7ae716f6458aa69459d79c6f77b0e9dda5b4ca6e29c3d2e28e48f5a63baf0`. Relatório completo e prova permanecem no armazenamento privado.

## Sequência para liberar o cadastro real

1. Concluir a prova nativa de ACL/concorrência e o processamento durável da fila do portal; as provas conjuntas em PGlite e os hooks transacionais estão implementados.
2. Testar o percurso HTTP completo com duas contas sintéticas e a atestação direta do principal próprio na origem; a UI de estados está implementada, sem campo de chave.
3. Preparar o serviço e acesso próprios da origem com limites de recursos e configuração privada; apresentar qualquer mudança necessária no banco atual de forma concreta, antes de aplicá-la.
4. Validar login mestre e gestores no canário, leitura real, edição por operação e isolamento entre áreas. A opção edição só será liberada com os respectivos contratos e testes concluídos.
5. Confirmar recuperação de identidade e reversão, incluindo o journal, antes do corte dos domínios finais. Tráfego real exige aprovação explícita.

Nenhum procedimento SQL preparado nesta etapa autoriza sua aplicação automática no banco de produção. As alterações e PRs da frente CRM no Claude Cowork continuam independentes desta branch do portal.

## Publicação e reversão desta etapa

Revisar o commit candidato, os jobs e o digest exato antes de instalar um novo canário. Construir na CI; reservar 0,5 CPU/512 MiB para o portal e 0,25 CPU/128 MiB para o emissor, uma réplica de cada. Conferir capacidade imediatamente antes de qualquer início e usar rede/credenciais privadas; os limites não são reserva garantida por si mesmos.

Criar uma cópia consistente e cifrada da identidade, incluindo as tabelas do journal, e usar volume próprio no canário. Preservar V22 e sua identidade. Reverter o canário para a imagem/volume anteriores se login, leitura, isolamento ou reconciliação falharem. Se o emissor já tiver criado gerações reais, encerrar primeiro suas intenções e confirmar revogações dos lifecycles geridos; desligar o processamento antes da reversão, sem remover contas ou configurações legadas.

A aprovação de entrada em produção deve especificar domínios, revisão, digest, políticas de acesso e alterações exatas necessárias no banco. Até essa aprovação, nenhum domínio final passa a apontar para a candidata e nenhuma hospedagem atual é desativada.
