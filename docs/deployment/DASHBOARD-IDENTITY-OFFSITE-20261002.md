# Recuperação externa das contas: destino e próximo ensaio

O titular delegou a escolha do destino e mencionou GitHub. O repositório atual é público; bancos de contas, credenciais, chaves de criptografia, links de convite e backups sensíveis não serão publicados nele, em imagens ou em logs.

## Destino durável

A opção preparada é um bucket S3 exclusivo, privado e versionado, fora do Easypanel, com acesso restrito ao prefixo de backup e chave da aplicação guardada separadamente. O transporte já exige versões exatas, cifra em repouso, leitura de volta, hashes e validação SQLite antes de emitir recibo. Sua imagem por digest e as provas simuladas estão em [BACKUP-S3.md](../../services/dashboard-operational/BACKUP-S3.md).

Em 02/10, a identidade AWS existente no cofre autenticou, mas uma tentativa única de criar bucket **novo**, com nome aleatório, recebeu `403 AccessDenied`. Nenhum upload foi feito e nenhum bucket existente, política IAM ou credencial foi alterado. A ausência de permissão de criação é um impedimento concreto para esse destino; as recusas de ListBuckets/IAM, por si sós, não provariam ausência de bucket. Ainda falta autorização técnica do provedor para o bucket novo e uma identidade de backup restrita. Nenhuma chave deve ser enviada por chat.

## Primeira prova fora do servidor

Uma cópia cifrada e privada no Mac pode comprovar um primeiro transporte fora do Easypanel. Essa alternativa está **em preparação**, sem snapshot de conta corporativa nem execução remota. Não substitui retenção/versionamento duráveis ou recuperação funcional.

O protótipo local, somente com dados sintéticos, usou Node 22 e o backup SQLite consistente com WAL ativo; cifrou em chunks com RSA-OAEP-SHA256/AES-256-GCM e restaurou/validou o SQLite. A adulteração do ciphertext, mesmo com hash público recalculado, foi recusada sem deixar destino. Uma prova de roundtrip passou; imagem fechada, leitor HTTPS, mais casos de segurança e recuperação de login continuam pendentes. A chave privada do envelope ficará somente no Mac, em arquivo privado fora de Git; o servidor receberá apenas a pública. A chave da aplicação é separada e não integra o backup.

Sequência antes de usar qualquer conta real:

1. Revisar e testar o envelope, leitor e imagens no CI, sem rede e com identidades sintéticas.
2. Conferir o volume corporativo por MCP e provar mount Docker `RW=false`, UID/permissões e capacidade antes de executar o snapshot consistente. Se a leitura WAL em mount RO falhar, parar sem alterar a origem.
3. Snapshot sem rede em volume novo; cifra em outro volume novo, com snapshot montado RO. Nenhuma porta, worker comercial ou agenda de envios.
4. Leitor temporário com HTTPS/Bearer privado montando **somente ciphertext** em RO; dois nomes fixos, limites de bytes, sem chaves nem logs de cabeçalhos. Retirar o leitor e sua rota depois do download.
5. Guardar arquivos cifrados no Mac privado, restaurar em outro diretório/volume e comprovar integridade, login, permissões e navegação com a mesma chave da aplicação. A chave privada RSA sozinha garante confidencialidade; a proveniência precisa de TLS, imagem pinada e origem/mounts conferidos.
6. Concluir o destino durável versionado, retenção e ensaio de recuperação. Até lá, não declarar backup de produção concluído nem liberar o corte apenas pelo protótipo.
