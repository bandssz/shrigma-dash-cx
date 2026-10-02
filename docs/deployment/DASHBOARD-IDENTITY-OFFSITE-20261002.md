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

Antes de qualquer conta real:

1. Concluir a CI real e conferir os digests/revisões das três imagens. Nenhum build ocorre no servidor compartilhado.
2. Medir capacidade novamente. Criar somente um serviço Compose temporário de preflight, sem rede: origem corporativa montada RO e volume de saída novo. Confirmar `Mounts.RW=false`, nomes/fontes corretos por MCP e health do guard, que verifica UID1000, diretórios 0700, arquivos 0600, raiz RO, limites de memória/CPU e ausência de credenciais/rede. O MCP não fornece Docker inspect completo; não afirmar que fornece.
3. Parar o hold. Executar o snapshot uma única vez, sem rede, limitado a 0,5 CPU/512MiB; exigir health que valida o snapshot. A marca de tentativa exclusiva impede execução automática repetida. Se a leitura WAL em RO falhar, parar sem alterar a origem.
4. Parar o snapshot. Cifrar em outro volume novo, com snapshot RO, limite 0,5 CPU/768MiB e somente chave pública/nonce na configuração. Parar a cifra antes de iniciar o leitor.
5. Leitor temporário limitado a 0,25 CPU/128MiB, HTTPS e Bearer privado com prazo curto, montando **somente ciphertext** em RO. Dois nomes fixos, tamanho limitado, sem credenciais de aplicação e sem logs de cabeçalhos. Validar TLS/host/negativas por requisições API; remover a rota e o leitor após o download.
6. Download privado no Mac; decifrar em diretório novo, verificar SQLite, hashes, chave da aplicação, contas e permissões. Exercitar a recuperação funcional somente na cópia. A senha do titular permanece definida por ele; uma senha de ensaio na cópia não comprova conhecimento da senha original.
7. Enviar apenas os dois arquivos cifrados para uma nova release privada draft, baixar e verificar novamente antes de torná-la imutável. Registrar versão, digests e procedimento de recuperação sem segredos. Definir custódia recuperável das chaves fora do mesmo armazenamento de backup.

**Estado desta revisão:** destino externo e roundtrip sintético concluídos; helpers/testes preparados. CI das imagens, snapshot corporativo, recuperação funcional e custódia adicional das chaves ainda pendentes. O corte para os domínios finais permanece NO-GO enquanto essas provas e o acesso real por pessoa não estiverem completos. Nenhum worker, agenda, sincronização ou envio é iniciado por esse processo.
