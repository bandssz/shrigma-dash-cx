# Integração CRM e migração — estado em 03/10/2026

## Fontes e preservação

A entrega Claude da PR [#216](https://github.com/bandssz/shrigma-dash-cx/pull/216), head `e91e44ab49f6bbee79c715860bb549c3d45c5682`, foi incorporada às candidatas. A base de produção conferida foi `565ab590ecbbaf021a05fdaa31bb570246ad52b3`. A PR [#217](https://github.com/bandssz/shrigma-dash-cx/pull/217), head `70f914c3f235f56f14fc15d66144ae8a8e551b4d`, reúne a publicação frontend para o GitHub Pages e tem 32 checks aprovados. Seu merge permanece pendente de autorização específica: a revisão automática recusou a ação por publicar na hospedagem atual.

A implementação do portal fica na branch exclusiva `codex/dashboard-candidate-crm-fix-20261002`, PR draft [#214](https://github.com/bandssz/shrigma-dash-cx/pull/214), sobre a branch operacional separada. A pasta principal `repo`, sua branch `codex/growth-reliability-20260924` e seu commit `552541830cf0c910725625c9f7fb76a2547d006f` foram preservados. Não houve stash, reset, merge ou push nessa branch. As fontes e a infraestrutura do CX permanecem disponíveis.

## Portal instalado e endereços de teste

O novo serviço `dashboard-image-20260930/web-access-v24-f58dfa73` foi observado saudável, na imagem imutável `ghcr.io/bandssz/shrigma-dash-operational-canary@sha256:9d25e5d9d78ba5734f9b7a008f6d512becc95d91402d92eaddc62c5ebc669705`, revisão `f58dfa7333c9e2b66d0e39023eb3ea39bc5802ea`.

- https://dashboard-v24-gerencial.tazdb8.easypanel.host
- https://dashboard-v24-crm.tazdb8.easypanel.host
- https://dashboard-v24-organico.tazdb8.easypanel.host
- https://dashboard-v24-influs.tazdb8.easypanel.host

Tem uma réplica, limite de 0,5 CPU/512 MiB, heap128 MiB, 64 processos, UID/GID1000, raiz somente de leitura, capabilities removidas e volume exclusivo. A identidade cifrada e o hash da conta mestre foram copiados consistentemente do V23, montado somente para leitura, preservando V22/V23. A prova de cópia e sua persistência são obrigatórias antes de abrir o portal. O MCP não expôs o código final do processo pai da importação; não foi declarado exit0 desse pai. O importador exclusivo foi parado/desabilitado, sem variáveis privadas e sem contêiner em execução observado; seu volume/prova foram preservados.

Passaram 45 verificações HTTPS anônimas: TLS, saúde, sessão, proteção de áreas, CX inacessível, recusa de escritas, cabeçalhos e bytes de cinco assets públicos da imagem revisada. Isso não comprova login humano, decifragem comercial, dados reais ou contas de gestores. Não foi fabricada sessão mestre. Provisionamento gerenciado, UI READ e escritas continuam desligados; só o upstream crm-read está configurado. Não há workers, sincronizações ou emissores duplicados.

A imagem já contém o formulário CREATE/UPDATE, renovação manual e ponte READ parcial da candidata. Os oito serviços existentes de comunicação, 131 mapeamentos anteriores e configurações V22/V23 foram preservados; só quatro novos hosts de teste foram acrescentados, total135. Os domínios finais e o backend de campanhas não foram trocados. Antes da criação havia CPU45,56%, cerca20,8GiB de memória e329,3GiB de disco livres; build foi feito fora do servidor. A releitura posterior observou CPU40,63% e20,5GiB livres.

A CI [37116055111](https://github.com/bandssz/shrigma-dash-cx/actions/runs/37116055111), no head exato f58dfa7, confirmou 875 resultados aprovados, zero falhas/skips, seis jobs de validação e preflight OCI canônico. Só o publisher do portal candidato publicou; publishers de campanha e emissor foram ignorados. Nenhum SQL foi aplicado no banco atual. O restante desta seção registra etapas anteriores que explicam a implementação; suas CIs antigas não substituem essa prova.

## Validação da candidata

A última CI inteiramente aprovada antes da interface nova foi [37105977063](https://github.com/bandssz/shrigma-dash-cx/actions/runs/37105977063), commit `e6a154d6b21b3f2b1d77bd03de97b3deebce2611`: 770 resultados aprovados, cinco jobs de validação aprovados e três publishers ignorados. A prova PostgreSQL17 de escrita teve 13 casos, exclusivamente na fixture descartável; não instalou SQL no banco atual.

O shell candidato contém formulário para editar campanhas existentes, conferir público, agendar e cancelar pelo contrato privado do BFF. A troca de marca preserva operações pendentes; a reabertura consulta o mesmo diário antes de nova escrita. A data original conserva segundos e milissegundos quando o campo não é alterado. Foram 67 casos locais distintos aprovados de UI, HTTP, build e navegação, mais dez verificações do contexto Docker. O backend só admite escrita no perfil sintético de teste, desligada por padrão. Nenhuma dessas provas agendou ou alterou os rascunhos reais167/168.

Os quatro scripts públicos usam esbuild0.28.2 fixado no lockfile existente. O gerador verifica manifesto e bytes; a CI exige `--check`. Ferramentas e dependências de build ficam fora da imagem. O pacote tem 30 arquivos públicos e16 privados, 938.474 bytes; a inicialização soma949.016 bytes, abaixo do teto950.000. O contexto Docker admite somente arquivos literais revisados.

A CI [37111132986](https://github.com/bandssz/shrigma-dash-cx/actions/runs/37111132986), commit `a977f0064de17c8f11e96c42d4a1bb36bf59b92b`, passou no perfil OCI canônico, mas falhou globalmente em uma variante opcional não usada no servidor. A CI seguinte, [37112490572](https://github.com/bandssz/shrigma-dash-cx/actions/runs/37112490572), commit `f8c32978a1c7ff0e4314467ac2726f7e8a00169c`, confirmou os seis jobs de validação aprovados, 810 resultados aprovados e três publishers ignorados. Verifica o perfil canônico comprovado no host e marca a variante como não executada; guards, limpeza, limites e recusa de PID zero permanecem intactos.

## Criação de rascunhos integrada em isolamento

A candidata agora inclui o diário privado CREATE e o formulário Novo rascunho. Exige sessão, Origin/CSRF, vínculo individual e marca; a entrada não aceita ID, versão, ator ou chave remota do navegador. Persiste a intenção cifrada antes do único POST. ID e tracking derivam somente do recibo201 comprovado; a criação termina em draft sem horário ou envio. Depois permite salvar horário, conferir, confirmar agendamento e cancelar no fluxo existente.

Reabertura, reinício, timeout e404 consultam a mesma tentativa por GET. CREATE e UPDATE compartilham reservas por usuário/marca no SQLite e WebLocks no browser. O ID confirmado encerra o formulário de criação antes da leitura seguinte; se essa leitura falhar, não permite criar outro draft acidentalmente. Uma resposta tardia não preenche outra marca ou usuário.

Na integração local, 114 casos distintos passaram: 36 backend/HTTP/regressão, 36 UI/client/regressão/revisão independente e42 build/Docker-context/shell/recuperação. Incluem processo novo heap128 sem listener/rede, backup SQLite WAL completo e restauração em volume de teste novo, preservando ciphertext/MAC/chave da tentativa e retomando somente GET. Não são provas de produção, kernel do portal ou login humano.

O gerador real produziu pack945.230 bytes (teto950.000), seed955.798 (teto separado960.000) e payload bruto2.402.301 (teto16MiB), SHA3624ffa6c71705d662c60fdb5679788e11f6b593326f3f1789d20bd41370ee4d, com30 arquivos públicos e17 privados. Somente o teto do transporte de inicialização subiu10.000 bytes; pack, expansão, heap e recursos permanecem limitados. O Docker admite exatamente o novo módulo. Os três publishers exclusivos da candidata passam a depender de todos os jobs de validação; marcadores de publicação e pipelines de produção foram preservados.

A CI [37114762959](https://github.com/bandssz/shrigma-dash-cx/actions/runs/37114762959), commit `6ec31dc6654fa5379ac7ae3ef82b3499d684901a`, confirmou 857 resultados aprovados, zero falhas/skips, seis jobs verdes e três publishers ignorados. A imagem foi construída para validação, sem publicação no registry ou instalação dessa versão. Escrita continua OFF por padrão, exclusiva de crm-sandbox/synthetic.invalid. Não amplia o emissor READ, não habilita o admin a editar com chave mestre, não inclui templates/upload e não cria agendamentos reais. Backups de releases antigos exigem helper/policy compatíveis; não afrouxar a allowlist nem sobrescrever o volume ativo para aceitar outro pack.

## Ponte parcial de leitura individual integrada, desligada

A nova ponte admite somente GET de catálogo, lista e detalhe de campanhas e da biblioteca de mídia, com destinos fixados e o acesso individual privado do gestor. Exige principal, lifecycle/version, geração, expiração e MAC antes da chamada e depois de ler o corpo. Marca/query são congeladas; sessão, área, origem, bytes, UTF-8, redirects e eco de segredo são conferidos. 401/403/404 não leem o corpo remoto nem repetem a consulta. O administrador preserva suas próprias credenciais e o fluxo legado; não recebe a chave de outro usuário.

A revisão encontrou e corrigiu a liberação antecipada da vaga de uma consulta após seu timeout. A resposta pode terminar em 25 segundos; a vaga continua ocupada até fetch e corpo realmente terminarem, mesmo após desconexão. As provas cobrem limite de quatro por pessoa e dezesseis no total, com reentrada após conclusão. Foram 16 testes do autor e duas regressões independentes aprovadas; a integração final passou na CI875 do f58dfa7 e está na imagem V24. Esses 18 casos locais não abriram conexão a serviços externos ou PostgreSQL real.

DASHBOARD_CRM_MANAGED_READ_UI permanece OFF por padrão, exige o perfil gerenciado explícito e todos os flags de escrita OFF. Públicos/segmentos ficam fora: o GET atual pode atualizar o catálogo. Templates, jornada e demais fontes não foram admitidos sem contrato de destino/ator/capacidade/efeitos. A ponte não oferece o CRM inteiro, edição, CREATE, validação ou agendamento. Se ao mestre faltar uma credencial própria de campanhas, a operação continua recusada; a ponte não faz alias de crm-panel-read nem remove esse impedimento silenciosamente.

O pacote combinado medido tem 949.014 bytes (teto950.000), seed959.612 (teto960.000), 30 arquivos públicos e18 privados; SHA9338ef1ec26b17b5368ba7367931e1753507498201f178babcc58e6b5a203dab. A margem do transporte é pequena e requer nova medição após mudanças. Allowlist e Docker incluem somente o módulo adicional; tetos, recursos e pipelines existentes permanecem preservados.

## Inicialização comprovada no Easypanel, sem SQL

O bootstrap `0292fb5e7da032567fabdb167b1bb84c4b3d0c95142fd82dd6b55188569f5c31` corrige a enumeração do volume após chown: com somente CHOWN, root não pode enumerar um diretório0700 que já pertence ao UID1000. A última conferência passa a ser de metadados; vazio é conferido antes da transferência e novamente pelo UID1000 antes de gravar. Os oito pins de fontes e todos os SQLs permanecem intactos.

Em03/10 às09:07UTC, o serviço exclusivo `crm-manager-preflight-v3-a7034687db0f` passou no Easypanel com imagem5ca20e4e, bootstrap0292 e bundle7feaf269. O limite agregado foi0,35CPU/320MiB, com cerca de20GiB livres consultados antes da criação. Não tinha credenciais, portas, domínios ou rede externa. O cliente PostgreSQL e o executor SQL não foram carregados; fontes SQL foram apenas bytes inertes. O Health exige guard do kernel, fontes por SHA e prova de arquivo/diretório com fsync. O MCP observou healthy/failingStreak0; isso não equivale a consultar o corpo JSON ou comprovar um banco funcionando.

Depois do ensaio, o projeto `comunicacao` inteiro (oito serviços), os131 domínios e as configurações V22/V23 coincidiram exatamente com os registros anteriores. V23 permaneceu saudável. O ensaio foi parado e desabilitado, com volume e prova preservados. A tentativa isolada anterior, que havia falhado, também permanece desabilitada e não foi reutilizada.

## Pendências de liberação

1. Autorizar e mesclar a PR217 para o frontend atual do GitHub Pages; confirmar publicação e navegação nas duas marcas. O filtro de biblioteca por marca em `services/crm-campaign/media.cjs` exige liberação separada da imagem de campanhas23e472ab, depois de prova isolada e conferência GET real.
2. O usuário autorizou o escopo vazio/inativo do instalador READ V3, mas ele ainda não foi executado. A pergunta apresentada descreveu incorretamente 500ms como duração máxima de bloqueios; a correção exige orçamento transacional próprio500ms, prova nativa e apresentação explícita da possibilidade de atraso na limpeza/liberação pelo servidor antes da execução. O lock_timeout500ms original limita só espera de aquisição. Ele cria quatro tabelas vazias, sete funções, dois índices explícitos e dois papéis NOLOGIN. Há novas concessões ao owner em `crm_dash_chave` e `shrigma_panel_permission_v1`, mais triggers internos de FK; portanto o instalador não é SQL somente leitura. Não altera registros existentes nem ativa issuer/login. A nova conexão preparada confirma transaction_timeout500ms no servidor antes de catálogo/DDL, mantendo todos os SQLs/fingerprint exatos; não muda configuração global ou de outras sessões. Interrupção/COMMIT/limpeza não dão garantia física rígida500ms. Expiração/ACK perdido permanecem incertos, sem retry ou aumento do orçamento. Reversão exige estrutura vazia/inativa, perfil exato e ausência de consumidores/dependências inesperadas.
3. Concluir autenticação restrita do gateway PostgreSQL, registro/segredo privado do issuer, ingresso e limites efetivos de rede, e ligação do portal. Auditar a fronteira PUBLIC/HBA/TLS/logs sem modificar controles existentes para fazer a prova passar. Instalar objetos vazios não basta para disponibilizar dados aos gestores.
4. CI875, imagem imutável e novo V24 com clone consistente já foram comprovados. A ligação real dos emissores/fontes e validação autenticada continuam pendentes; não ativar por flag antes dessas provas. Manter backup/helper compatível com o pack9338ef1e, teto950.000 e seed959.612/teto960.000.
5. Concluir identidade individual de edição e sua admissão própria, incluindo promoção/revogação, concorrência e consulta histórica de uma operação após expiração/rotação. A proposta SQL de escrita está inativa, sem LOGIN/emissor e não integra a exceção READ. Não habilitar produção mudando somente uma flag.
6. Validar login mestre no V24 sem redefinir senha, duas contas de gestores com áreas e leitura/edição distintas, dados reais, criação/conferência/agendamento/cancelamento controlados, templates no n8n/Listmonk e mídia. Resultados incertos devem consultar a mesma tentativa; não repetir POST ou apagar o diário.
7. Validar fontes individuais de Orgânico/Influs e a recuperação externa das contas. Existe backup cifrado fora do servidor, mas a custódia externa das chaves de recuperação ainda está pendente. Atualizar o backup depois das contas reais e antes do corte.

## Entrada em produção e reversão

Publicação de frontend, backend de campanhas, gateway de identidade e portal são liberações independentes. Cada uma precisa da revisão/CI do commit e digest exatos. Builds não recebem segredos; imagens, respostas, Git e logs não devem conter credenciais. Consultar capacidade antes de novos serviços e conservar limites de recursos. Não executar migrations de negócio, workers, sincronizações ou envios duplicados.

Depois das provas reais, apresentar para aprovação explícita o corte de `gerencial.shrigma.com.br`, `crm.shrigma.com.br`, `organico.shrigma.com.br` e `influs.shrigma.com.br`. Preservar o domínio principal, GitHub Pages, CX, serviços existentes, configurações anteriores e volumes V22/V23/V24.

Em falha de login, dados ou isolamento, restaurar os mapeamentos anteriores dos quatro domínios. Reverter frontend por PR; restaurar o digest anterior do backend com sua configuração preservada. Não fazer reset da pasta principal. Reconciliar/revogar somente lifecycles novos do issuer antes de desativá-lo, conservando identidades e credenciais legadas. O rollback SQL vazio deve recusar remoção após ativação/dados; não realizar DROP automático para recuperar uma instalação incerta.
