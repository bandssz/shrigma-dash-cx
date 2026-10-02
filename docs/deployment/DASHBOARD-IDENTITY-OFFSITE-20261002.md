# Recuperação externa das contas: preparação e evidências

O titular delegou a escolha do destino e mencionou GitHub. O repositório do dashboard é público. Bancos de contas, chaves, credenciais, links de convite e arquivos privados não entram nele, em imagens ou em logs.

## Destino externo preparado

Foi criado um repositório **novo e privado** exclusivamente para arquivos cifrados de recuperação. A API autenticada confirmou a visibilidade privada e a consulta anônima retornou 404. Actions foi desativado apenas nesse repositório novo. A proteção de releases imutáveis foi ativada e confirmada pela API. Cada versão contém somente `cipherblob.json` e `public-manifest.json`; nenhum SQLite em claro, chave privada RSA ou chave da aplicação é enviado.

Em 02/10, o primeiro ensaio completo usou apenas uma identidade sintética: backup consistente SQLite, cifra com RSA4096/OAEP-SHA256 e AES256-GCM, envio como dois assets de uma release inicialmente draft, download autenticado e comparação byte a byte, decifragem, integridade SQLite e recuperação da linha sintética. Só depois da prova a release foi publicada. A API confirmou `immutable=true`. O recibo privado confirma que nenhuma conta corporativa foi utilizada. A existência desse ensaio não comprova recuperação da base corporativa.

A alternativa S3 continua documentada em [BACKUP-S3.md](../../services/dashboard-operational/BACKUP-S3.md). A tentativa única de criar bucket novo recebeu `403 AccessDenied`; nenhum bucket existente, política IAM ou credencial foi alterado. A cópia privada cifrada em GitHub remove o bloqueio de destino para o próximo ensaio, sem depender de mudar permissões AWS existentes.

## Chaves e aceitação do snapshot

A chave privada RSA4096 foi criada em diretório privado do Mac, fora de Git, com permissões 0700/0600. O servidor recebe apenas a chave pública. O cofre local separado já contém a chave da aplicação e ela foi comparada em memória com a configuração ativa do v13: correspondência confirmada, sem imprimir o valor. A chave da aplicação continua separada do backup cifrado.

O envelope exige um hash de nonce novo, gerado no Mac antes do job e autenticado no AAD do GCM. A restauração recusa um envelope antigo íntegro com nonce diferente **antes** de criar um diretório de plaintext. Alterar o nonce no cabeçalho invalida a autenticação GCM. O nonce não autentica sozinho o produtor: a proveniência depende de TLS verificado, imagem por digest, origem e montagem confirmadas pelo MCP, e interrupção dos jobs de snapshot/cifra antes de expor o leitor.

O manifesto público contém somente esquema, tamanho e hash do ciphertext. A comparação com esse manifesto verifica transporte; não cria uma prova independente de origem. Um pin externo do manifesto pode ser informado quando existir um canal independente. A aceitação final exige o nonce esperado, a autenticação GCM, o manifesto interno cifrado e a integridade SQLite.

## Imagens e sequência isolada

O workflow novo `dashboard-identity-offsite-shadow.yml` testa o envelope e constrói três imagens fechadas em CI, com base Node22 por digest. A publicação exige um marcador explícito e a branch exclusiva desta migração. O runner usa somente nomes aleatórios próprios, dados sintéticos e daemon Docker local; nunca recebe volumes existentes, contas corporativas ou segredos de produção. O ensaio verifica preflight/UID/cgroup, montagem RO e invariância do SQLite/WAL/SHM de origem, snapshot, cifra, recusa de replay, restauração e remoção dos recursos próprios. Seu leitor é uma fixture HTTP sem listener: TLS real deve ser validado no servidor separadamente.

Procedimento isolado usado e exigido para futuras capturas:

1. Concluir a CI real e conferir os digests/revisões das três imagens. Nenhum build ocorre no servidor compartilhado.
2. Medir capacidade novamente. Criar somente um serviço Compose temporário de preflight, sem rede: origem corporativa montada RO e volume de saída novo. Confirmar `Mounts.RW=false`, nomes/fontes corretos por MCP e health do guard, que verifica UID1000, diretórios 0700, arquivos 0600, raiz RO, limites de memória/CPU e ausência de credenciais/rede. O MCP não fornece Docker inspect completo; não afirmar que fornece.
3. Parar o hold. Executar o snapshot uma única vez, sem rede, limitado a 0,5 CPU/512MiB; exigir health que valida o snapshot. A marca de tentativa exclusiva impede execução automática repetida. Se a leitura WAL em RO falhar, parar sem alterar a origem.
4. Parar o snapshot. Cifrar em outro volume novo, com snapshot RO, limite 0,5 CPU/768MiB e somente chave pública/nonce na configuração. Parar a cifra antes de iniciar o leitor.
5. Leitor temporário limitado a 0,25 CPU/128MiB, HTTPS e Bearer privado com prazo curto, montando **somente ciphertext** em RO. Dois nomes fixos, tamanho limitado, sem credenciais de aplicação e sem logs de cabeçalhos. Validar TLS/host/negativas por requisições API; remover a rota e o leitor após o download.
6. Download privado no Mac; decifrar em diretório novo, verificar SQLite, hashes, chave da aplicação, contas e permissões. Exercitar a recuperação funcional somente na cópia. A senha do titular permanece definida por ele; uma senha de ensaio na cópia não comprova conhecimento da senha original.
7. Enviar apenas os dois arquivos cifrados para uma nova release privada draft, baixar e verificar novamente antes de torná-la imutável. Registrar versão, digests e procedimento de recuperação sem segredos. Definir custódia recuperável das chaves fora do mesmo armazenamento de backup.

## Provas concluídas em 02/10/2026

A CI real passou os **41 testes em Node22** e concluiu a prova Docker com as três imagens fechadas, base por digest e revisão conferida. O ensaio usou apenas dados sintéticos e volumes próprios: origem UID1000 com WAL, preflight, snapshot por montagem somente leitura, comparação de SQLite/WAL/SHM antes e depois, cifra sobre snapshot RO, leitor somente do ciphertext, download, recusa de nonce incorreto e restauração com hash/SQLite iguais. Essa prova é distinta dos testes locais de revisão, executados em Node24.19.0. Nenhum build foi executado no servidor compartilhado.

O snapshot **corporativo real** também foi concluído em recursos temporários isolados, com a origem montada RO e os limites definidos antes da execução. O guard e a inspeção dos mounts confirmaram a origem correta, leitura exclusiva nesse job, dono/permissões, volumes separados e isolamento; a marca persistente limitou a execução a uma tentativa. O snapshot foi parado antes da cifra. A chave privada RSA e a chave da aplicação permaneceram fora das imagens e do job de snapshot; o cifrador recebeu somente a pública e o hash do nonce novo, com o snapshot em RO.

O leitor temporário expôs somente os dois arquivos cifrados. O HTTPS real foi validado, o download corporativo concluiu e o envelope foi decifrado e verificado no Mac com o nonce previamente registrado. A autenticação GCM, o manifesto interno, o hash e a integridade SQLite passaram. Depois da captura, o leitor foi parado, sua rota retirada e o arquivo local com o Bearer removido. Os quatro jobs novos permaneceram desativados. A configuração do v13 corporativo e os 118 mappings anteriores foram comparados: continuaram idênticos; nenhum contêiner do leitor ficou ativo. Nenhum SQLite em claro foi publicado nesse endpoint.

## Recuperação funcional das contas

A cópia canônica restaurada foi verificada e usada somente em leitura. Um **clone privado novo** recebeu o ensaio funcional, com o código real de autenticação e gateway do worktree, primeiro em Node24.19.0 e depois em Node22.23.3, versão da mesma linha do servidor, com HTTP ligado apenas ao loopback. A chave da aplicação decifrou o verifier da identidade; as contas e grants restaurados foram comparados antes dos testes. O arquivo canônico, seu manifesto, os metadados e o hash original da senha mestre permaneceram idênticos ao final.

No clone, uma senha aleatória de ensaio foi atribuída somente ao mestre dessa cópia. Passaram login por e-mail/senha, leitura das três áreas, criação e ativação de gestores sintéticos com área única, uso único de convite, restrições de host/Origin/CSRF/domínio de e-mail, bloqueio de acesso cruzado, edição negada no gateway somente leitura, grant de edição em uma configuração isolada, redução de permissão e revogação com invalidação de sessões. Nenhum cadastro de ensaio foi criado na produção, nem convite enviado a pessoas reais.

Todos os transportes para upstreams foram bloqueados durante a prova funcional. A única consulta de recibo preparada no clone usou credencial falsa e foi recusada antes de conexão externa; nenhum rascunho, agendamento, sincronização ou mensagem foi submetido. Em ambos os runtimes, o clone foi removido e a chave apagada do Buffer após o ensaio. A limpeza também foi testada com uma falha sintética de fechamento: as etapas restantes continuaram e sucesso foi recusado.

O restore corporativo continha uma conta mestre e **zero credenciais upstream cadastradas**. Portanto o verifier comprova a correspondência da chave da aplicação, mas não existe prova de recuperação de uma chave upstream preexistente nesse snapshot. A senha de ensaio comprova o funcionamento do login na cópia; não comprova conhecimento da senha atual do titular, cujo hash foi preservado. O ensaio não prova TLS/cookies em navegador, navegação JavaScript ou funcionamento dos dados e ações dos backends.

## Cópia corporativa fora do servidor

Somente `cipherblob.json` e `public-manifest.json` da cópia corporativa foram enviados para uma **nova release privada**, inicialmente draft. Os assets foram baixados novamente do GitHub, decifrados e verificados; o SQLite recuperado teve hash idêntico ao canônico. Após essa prova, a release foi publicada e a API confirmou **`immutable=true`**. O backup corporativo externo está concluído; ele é separado da release do ensaio sintético anterior.

O repositório de recuperação continua privado, com Actions desativado. Nenhum banco em claro, segredo, chave RSA privada ou chave da aplicação foi enviado. O manifesto público descreve o ciphertext; sua hash confirma transporte e não constitui autenticação independente do produtor. A aceitação mantém nonce esperado, GCM, manifesto interno, integridade e proveniência do procedimento por imagens/mounts/HTTPS verificados.

## Limitações e próximo gate

As chaves estão em cofre privado local separado dos arquivos cifrados, mas a **custódia recuperável em local independente do mesmo Mac ainda não foi concluída**. A perda desse equipamento não é coberta apenas pela existência de uma release cifrada imutável. Definir e validar a recuperação independente da chave privada RSA e da chave da aplicação, sem enviá-las ao repositório de backup ou ao chat.

A tentativa de criar o novo destino S3 recebeu `AccessDenied`; consultas adicionais de metadados AWS também foram recusadas. Não foi possível confirmar por esse canal a configuração de recuperação/retenção necessária. Nenhum bucket existente, política IAM ou credencial foi modificado. O GitHub privado cifrado é o destino efetivamente comprovado nesta etapa; não atribuir ao S3 uma prova que não ocorreu.

**Estado atual:** CI Node22/Docker, snapshot corporativo RO, recuperação funcional do clone e roundtrip corporativo no GitHub privado imutável concluídos. Custódia independente das chaves, acesso individual real na origem e validações dos backends continuam pendentes. O corte definitivo e a alteração de produção permanecem **NO-GO** até os gates restantes serem satisfeitos. Essas provas de backup não autorizam DML no banco de produção, edição real ou desativação da hospedagem atual.
