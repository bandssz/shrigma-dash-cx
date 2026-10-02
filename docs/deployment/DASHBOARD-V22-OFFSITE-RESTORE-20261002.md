# Recuperação externa da identidade V22 — 02/10/2026

O snapshot consistente já importado no portal V22 foi cifrado, baixado para o Mac, gravado em uma nova versão privada no GitHub, baixado novamente do GitHub e restaurado em isolamento. Nenhuma senha corporativa, permissão original, campanha, envio ou serviço operacional foi alterado durante o ensaio. Não repetir snapshot/importação para reapresentar esta prova.

## Proveniência e arquivos externos

- Portal instalado: commit `10fee73e150b5685e18ab0ff1d9abc41da4e1cdd`, imagem `ghcr.io/bandssz/shrigma-dash-operational-canary@sha256:07a5ea4f3be76f15b36f2fd58199b51d9ea5fb44543d2207d91bce3493053cdc`.
- Snapshot consistente: 110.592 bytes; SHA256 `1999b6a83b54e7e1b0c1cfef54fdebe1c7bb9932fb6cbeac3e58c6aecdbb075c`. A identidade recuperada tem uma conta corporativa e uma credencial de integração cifrada; não registrar seus valores.
- [Versão privada do backup](https://github.com/bandssz/shrigma-dashboard-identity-backups/releases/tag/offsite-corporate-v22-20261002-ddc11f66b8e7), ID `402199323`, publicada com `draft=false` e `immutable=true`, confirmados por leitura da API. Versões anteriores preservadas.
- Somente dois assets: `cipherblob.json`, 148.888 bytes, SHA256 `f109a378322c620395de13c6278a5405b6da8a54cf3fc4f24cbade0e292815a3`; `public-manifest.json`, 157 bytes, SHA256 `b4d8eb63e10563223e4c4b7b2b97377435e80e9bbe7395e4e4edab3f6a65bc1d`.
- O repositório é privado. O banco legível, a chave RSA, a chave da aplicação e os tokens não foram enviados ao GitHub. Os dois assets baixados dele foram comparados byte a byte por SHA256 antes da publicação.

## Transferência e limpeza

O cifrador já validado permanece parado. O leitor temporário usa imagem fixada `ghcr.io/bandssz/shrigma-dash-identity-reader@sha256:486703a276b882337a6028a93460f55ec44c5bb97ebfd3e86fb46fd7093ed7d0`, apenas o volume de ciphertext em leitura, UID/GID 1000, raiz somente leitura, capabilities removidas, no-new-privileges, 0,25 CPU, 128 MiB, 32 processos e tmpfs de 32 MiB. Não recebeu banco legível, chave RSA, chave da aplicação, credenciais CRM ou GitHub. O guard saudável verificou controles efetivos, envelope e negação anônima; o download exigiu TLS válido, hostname exato e Bearer temporário com somente o hash no servidor.

A primeira tentativa de roteamento retornou 502 apesar de o leitor estar saudável. O nome combinado projeto/serviço/componente tinha 85 caracteres. Um alias foi corrigido, mas a rota continuou falhando. Como a API confirmou que Compose ainda não pode ser renomeado, o leitor original foi parado e um serviço temporário com nome combinado de 60 caracteres foi criado, usando a mesma imagem, arquivo cifrado e controles. O download então passou. Manter nomes internos abaixo do limite de um componente DNS nas próximas preparações.

Após a transferência, a rota temporária foi removida antes da parada do leitor. Consultas nativas confirmaram zero containers em execução nos dois leitores e os mesmos 126 registros de domínio anteriores. O Bearer temporário local foi apagado. Os volumes de origem e ciphertext foram preservados. Nenhum build foi executado no servidor; havia mais de 20 GiB de RAM livre, CPU abaixo de 60% e mais de 309 GB de disco livre antes da execução.

## Recuperação funcional local

O envelope baixado do GitHub foi aberto usando as chaves locais protegidas e a proveniência privada esperada. SHA, integridade SQLite e chaves estrangeiras passaram. A ferramenta usou uma cópia descartável, uma senha aleatória apenas nessa cópia e origem sintética; nenhuma credencial, senha ou linha de banco foi impressa.

Node `22.23.3`; código do ensaio sobre candidato `5ec3653c4a822a2d22e38fc4778f4094dad8768d`. Auth, envelope e backup desse candidato são iguais aos do commit instalado `10fee73`; o servidor possui a preparação posterior de elegibilidade documentada no sprint. Portanto, o ensaio não comprova que essa preparação está implantada.

Passaram: preservação do hash da senha mestre e dos grants originais; verificador da chave da aplicação e decifragem da credencial armazenada; login mestre com senha exclusiva da cópia; convite, uso único, login de gestor e isolamento por área; negativas CSRF/Origin/domínio de e-mail; bloqueio de edição somente leitura; grant/downgrade sintéticos; revogação de sessões. Uma tentativa de origem foi bloqueada pela ferramenta; **zero chamadas externas**. O backup original e seu manifesto permaneceram iguais e a cópia de trabalho foi removida. O sandbox recusou inicialmente o bind local; liberar somente o ensaio em 127.0.0.1 resolveu, sem correção no aplicativo.

## Limites e próximo passo

Essa recuperação confirma a identidade e a credencial cifrada do snapshot usado pelo V22. Não comprova conhecimento da senha real, login humano atual, leitura ou edição reais por gestores, nem integração de Orgânico/Influs. O cadastro e renovação individuais também passaram em fixtures independentes; continuar com credenciais próprias e atestação por usuário antes de habilitar acesso real.

A custódia independente das duas chaves continua pendente: o backup externo não basta para uma perda simultânea do servidor e deste Mac. Não colocar as chaves na mesma versão do backup ou em Git. O corte dos domínios definitivos permanece condicionado ao [sprint e aceite](DASHBOARD-SPRINT-FINAL-20261002.md).
