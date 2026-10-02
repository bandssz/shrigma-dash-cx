# RFM — instalação selada OFF e reversão imediata

Este procedimento descreve os compiladores `segment-shopify-rfm-install.cjs` e `segment-shopify-rfm-rollback.cjs`. Ele não autoriza publicação, ativação do coletor, agendamento ou envio. O SQL bruto `segment-shopify-rfm.sql` recusa execução sem o marcador da instalação compilada. Use somente uma conexão dedicada ao PostgreSQL 17, com revisão da versão exata e janela operacional aprovada. Nenhum passo deste documento foi executado no banco de produção.

## Provas privadas antes da instalação

1. Confirme a revisão de código, os pins de `Install.sourcePins()`, os papéis efetivos e a ausência de produtor RFM, agendamento paralelo e fontes RFM existentes. `Install.validateSnapshot()` exige workers regulares e delivery desligados, duas fontes Shopify esperadas, papéis da API/coletor sem `CREATE` efetivo no schema, sem associação ao dono ou ao papel par e nenhum objeto RFM prévio. Uma flag OFF no processo não substitui essa leitura do banco. Com workers/delivery ativos, não execute; não desligue a operação atual só para fazer o compilador aceitar o plano, especialmente durante os envios programados.
2. Leia `Rollback.baselineSQL()` **antes** do install. Guarde privadamente o objeto `baseline` completo, inclusive as definições exatas das quatro funções que serão substituídas, e seu digest. O `baseline.snapshot` é também o snapshot esperado do instalador: seu SHA-256 canônico deve ser o `expectedSnapshotSha256`. Não coloque definições, snapshots, credenciais ou respostas do banco no Git, em logs ou neste documento.
3. Gere o plano com `Install.compile()` a partir desse snapshot, `Install.sourcePins()`, digest da revisão aprovada e janela `notBefore`/`expiresAt` de no máximo **10 minutos**. Confira o hash do SQL compilado e a identidade da conexão. O digest de revisão registra o artefato examinado; não substitui a revisão humana.

## Instalação e confirmação OFF

Execute o plano uma única vez na conexão dedicada. Ele usa **uma transação**, isolamento `read committed`, identidade `postgres`, locks de catálogo e das tabelas guardadas, `lock_timeout=500ms` e `statement_timeout=20s`. A captura pode envelhecer ou uma escrita concorrente pode impedir o lock ou mudar o snapshot; nesse caso, abandone a tentativa, faça `ROLLBACK` ou descarte a conexão e volte à leitura/revisão. Não afrouxe os limites para forçar a instalação.

Se a resposta do `COMMIT` for incerta, abra **nova conexão somente de leitura** e use `Install.readbackSQL()` com `Install.reconcileReadback()`. O recibo deve confirmar o mesmo marcador, pins, baseline, `enabled=false`, zero linhas em `rfm_source`, `rfm_batch` e `rfm_fact`, e as 13 funções esperadas. Não reenvie o plano por falta de ACK.

Após um commit confirmado, leia `Rollback.postSQL()` em até **120 segundos** de `installed_at`. Preserve privadamente o objeto `installedPost` e o SHA-256 de sua representação canônica como prova independente do estado recém-instalado. O resultado permanece OFF: nenhuma fonte, ingestão, worker, rota ou envio é ativado por este install.

## Reversão após commit, somente com estado intocado

Antes de compilar, confirme fora do banco que nenhum job ou workflow externo começou a usar RFM. Leia `Rollback.postSQL()` novamente para obter `currentPost`: a leitura deve ter no máximo **120 segundos** no momento da compilação e coincidir com a prova `installedPost` em snapshot, riscos, recibo e data de instalação. Passe ao `Rollback.compile()` o plano do install, `baseline`, `installedPost`, `currentPost`, o digest **guardado após o install** (`expectedInstalledPostSha256`), `Rollback.sourcePins()` e a revisão aprovada. Nunca derive esse digest da leitura atual.

A janela do rollback deve começar em ou após `installed_at`, durar no máximo **10 minutos** e terminar até **15 minutos** depois de `installed_at`. O compilador também recusa prova pós-install capturada mais de 120 segundos após a instalação. A transação recaptura catálogos, dados e recibo sob locks, com os mesmos `lock_timeout=500ms` e `statement_timeout=20s`; uma mudança interveniente aborta tudo. Durante os locks, escritores concorrentes podem esperar ou falhar. Execute apenas em janela quiescente e trate timeout como recusa, não como licença para repetir um plano antigo.

O estado exigido é OFF e vazio: workers/delivery desabilitados, zero fontes/batches/fatos RFM e nenhuma referência `relationship.rfm` em configuração, públicos, revisões, operações ou campanhas. O rollback restaura **exatamente quatro** definições anteriores, remove **13 funções e quatro tabelas** criadas pelo install, e usa `RESTRICT` em cada remoção, sem `CASCADE`. Dependências SQL externas impedem o rollback inteiro. Não apague dados nem dependências para fazê-lo passar sem uma nova revisão. Após `COMMIT`, leia `Rollback.readbackSQL()` em conexão nova e exija `Rollback.reconcileReadback()`: metadados iguais ao baseline, objetos RFM ausentes e estado OFF.

Falha antes do commit do install exige só desfazer a transação. Falta de ACK exige reconciliação de leitura. Depois do commit, falta de prova inicial, janela vencida, objeto/dado alterado, referência de público, job externo ou dependência tornam este rollback **inaplicável**; preserve o estado e prepare recuperação externa revisada a partir dos backups e funções anteriores. O compilador não comprova jobs n8n nem dependências construídas por SQL dinâmico fora do catálogo. Nenhum destes caminhos autoriza ativar RFM ou enviar mensagens.

## Evidência reproduzível

Na revisão de código `608664ef52c7de1771ac164270fe74f6e5773a7d`, os testes portáteis do instalador e rollback passaram **10/10**. A [execução CI 36977739211, job 110745137661](https://github.com/bandssz/shrigma-dash-cx/actions/runs/36977739211/job/110745137661), conferida no GitHub em 02/10, confirmou PostgreSQL **17.10** e reversão ao baseline. A PR desse head concluiu **25/25 checks**. Essa prova usa banco descartável; antes de qualquer instalação real ainda são necessários snapshot e revisão operacionais novos, no ambiente-alvo exato.
