# Pacote nativo regular — candidato OFF

`build.py` recompila as fontes oficiais fixadas do Listmonk6.1.0 e a dependência
smtppool2.0.2 com os overlays de `tools/listmonk-regular-build`. Não inicia o
Listmonk, não acessa banco/SMTP, não cria imagem e não publica em registro.

Entradas: arquivo de fonte Listmonk, ZIP oficial do módulo SMTP, diretório com
release Linux/amd64 e checksums oficiais, executável Go1.26.1 e diretório de
saída novo. `--target` aceita `linux_amd64` (servidor) ou `darwin_arm64` (ensaio
local). O cache Go deve estar previamente preenchido; a compilação usa
`GOPROXY=off`, `GOSUMDB=off`, `GOTOOLCHAIN=local`, `CGO_ENABLED=0` e verifica os
módulos com `go mod verify`. Nenhuma dependência é baixada por esse comando.

O Go compila um prefixo executável novo. A ferramenta oficial stuffbin1.3.0
embute os130 assets verificados da distribuição oficial; só a consulta
`/queries/campaigns.sql` muda. Uma leitura independente confere o prefixo, a
plataforma, o conjunto completo dos assets, a consulta exata e o binário final.
Não reutilizar a suposição do pacote A/B antigo de que o prefixo é inalterado.

A saída conserva `candidate/listmonk`, os dois diretórios de fontes modificadas,
o workspace Go relativo, os manifests de dependências, receitas/compositor,
licenças, `BUILDINFO.txt`, `manifest.json`, `SHA256SUMS` e o release original para
referência de rollback. As demais dependências continuam fixadas em `go.sum`;
não são vendorizadas. A reconstrução usa o mesmo Go e os módulos verificados.

Compilação local não substitui CI, prova do processo completo, carga, autoridade
de agenda, revalidação das fontes, permissões ou janela coordenada para trocar
o serviço. A manifestação `CANDIDATE_OFF_NOT_DEPLOYED` não autoriza ativação. O
binário Darwin serve apenas a provas locais; somente Linux/amd64 corresponde à
arquitetura identificada no serviço. Nenhuma troca/reinício foi executada.

## CI Linux e imagem candidata

`bootstrap.py` baixa os arquivos públicos fixados por SHA256 e preenche/verifica
o cache de módulos antes da etapa de compilação offline. O workflow
`crm-regular-worker-tests.yml` usa Go1.26.1, PostgreSQL17.10 descartável, testes
com race detector e o processo nativo completo com SMTP de loopback.
`postgres_proofs.py` repete admissão HTTP, permissões, lease, guard, entrega e
recuperação em bancos novos, registrando o encerramento do cluster.

`image.py` só aceita um pacote Linux cujo binário corresponda a uma prova nativa
aprovada e encerrada. Preserva a configuração de runtime da imagem base fixada,
exporta OCI, reimporta e confere digests, configuração e o binário extraído. A
imagem contém fontes correspondentes e licença; a versão é conferida com rede
desativada. A saída inclui `image-proof.json`, `native-proof.json`, manifesto do
pacote, fontes e layout OCI. O workflow conserva esse material como artefato por
30 dias. Não autentica em registro, não publica imagem e não troca serviços.

A ativação depende da conferência da configuração SES por marca, dos papéis do
banco, da identidade efetiva do processo e de todos os emissores, além da janela
coordenada para serviços existentes. CI verde não habilita os gates.
