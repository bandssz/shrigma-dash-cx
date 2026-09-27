# Instalação faseada — retenção CART Fish/Aristo

Instalador preparado; esta entrega não instala, publica, ativa, pausa ou envia em produção. Não muda o motor PR129/132, o ramo Olivas, TX/popup, CX, login ou infraestrutura. Uma ativação posteriormente revisada pode enviar carrinhos reais já elegíveis: o consumidor reutiliza exatamente o transporte/finish original; não é um smoke sem envio.

## Contrato operacional

`deploy.cjs` recebe I/O e armazenamento por injeção. `api-adapter.cjs` implementa somente as rotas documentadas n8n e consultas SQL agregadas. Não há endpoint, chave ou credencial no código versionado. A ponte privada reutiliza o driver CRM23 (sem redirects, resposta limitada, timeout), usando as credenciais existentes somente em memória. O nó PG do util é lido apenas para conferir a referência/configuração da mesma conexão; seu auth, workflows CX e credenciais não são alterados.

`prepare` exige o guard de um export já revisado. Não recalcula uma autorização a partir de um export desconhecido. O plano privado contém backup completo do emissor, funções originais, projeto, referências PG, candidatos e SQL; seu hash sela esses dados e os arquivos do instalador. Todos os arquivos de evidência usam criação exclusiva, fsync e modo 600. Planos contêm configuração privada: nunca comitar ou imprimir os exports. A CLI imprime somente o resumo selecionado ou códigos estáticos.

A primeira instalação aceita **schema ausente**. Se PR129 já estiver instalada, o instalador para: não adota nem substitui silenciosamente um schema existente. Instala PR129 + CART num único `DO`, sob lock de instalação, guardas do banco/papel/definições originais e timeouts definidos antes do `DO`. Não usa `BEGIN/COMMIT` externo no pool. O comentário do novo schema guarda o identificador da instalação, hash DDL e impressão do catálogo (definições/ACL/colunas/constraints/triggers/índices/sequência). Cada fase posterior confere esse selo e as dependências. Ele detecta drift, não representa uma credencial ou um controle de acesso contra o próprio administrador do banco. Não há grants novos, funções SECURITY DEFINER ou alteração de originais.

## Fases e revisão

A CLI recebe caminhos absolutos para o adaptador privado e diretório de recibos. Exemplo estrutural:

```
node tools/maintenance-cart-deploy/cli.cjs prepare ADAPTER_ABSOLUTO DIRETORIO_PRIVADO GUARD_ABSOLUTO
node tools/maintenance-cart-deploy/cli.cjs install ADAPTER_ABSOLUTO DIRETORIO_PRIVADO HASH_DO_PLANO
```

Cada fase é uma chamada separada; nunca um comando encadeado de implantação.

| Fase | Precondição e efeito |
|---|---|
| `prepare` | Somente GET/SELECT. Confere versão editável/publicada, corpo publicado, projeto, PG e guard revisado. Gera plano e backups privados. |
| `install` | Fonte original ainda exata, dependências iguais, schema ausente. Uma escrita SQL atômica; readback OFF/closed, zero eventos, selo intacto. |
| `create` | Instalação confirmada, OFF/closed e vazia. Cria consumidor inativo com nome único do plano. Readback exige projeto e grafo exatos. Não transfere projeto nem concede acesso. |
| `open` | Consumidor confirmado OFF; fonte ainda original; zero eventos. `control_v1` com UUID durável e CAS versão 1 → 2, enabled/open. Confere recibo original e estado. |
| `patch` | Gate ainda open na mesma versão, consumidor OFF, fonte/versão/projeto/PG exatos. PUT dos três SQL apenas, seguido de readback. **O PUT de workflow ativo no n8n 2.0.2 pode publicar imediatamente.** |
| `publish` | Corpo candidato e versão salvos exatos. Se o PUT já publicou, apenas confirma; caso contrário ativa a versão explícita e confere corpo ativo. |
| `activate` | Publicação confirmada + gate aberto + aprovação separada `HASH_DO_PLANO:activate`. Ativa somente o consumidor e sua versão revisada. Não executa manualmente o workflow. |
| `verify` | Somente GET/SELECT: corpos ativos, versão/projeto, selo, gate e contagens agregadas. Não afirma drenagem nem aceite funcional do n8n. |
| `halt` | Desativa somente o consumidor conhecido, preservando emissor, gate, eventos e claims. Interrompe triggers futuros, não execuções ou grants já iniciados. |
| `reconcile FASE [ID_CONSUMIDOR]` | Só leitura remota para resolver uma resposta perdida. Exige identidade/corpo/recibo exatos; grava conclusão local. Nunca repete a escrita. |

O endpoint público de criação n8n 2.0.2 força `active=false` e usa o projeto pessoal do usuário da API. Se o readback não corresponder ao projeto do emissor, o instalador para com o workflow ainda OFF; não tenta transferência. Em perda da resposta de criação, obter o ID por consulta exata ao nome único e revisar o export; informar esse ID a `reconcile create`. Ausência em uma consulta não autoriza criar outra cópia.

O PUT público do n8n 2.0.2 usa `forceSave` e não oferece CAS de versão. Por isso é necessária edição exclusiva do emissor durante a pequena janela: GET fresco imediatamente antes de PUT, export/intent persistido e readback depois detectam drift, mas não prometem impedir uma edição de outro administrador no intervalo. Ativação usa `versionId` explícito. Fonte oficial: [handler n8n 2.0.2](https://github.com/n8n-io/n8n/blob/n8n%402.0.2/packages/cli/src/public-api/v1/handlers/workflows/workflows.handler.ts).

## Interrupção e retorno

Qualquer tentativa gravada bloqueia repetição, mesmo se ocorreu timeout antes da escrita. Primeiro consultar o mesmo resultado. Resposta perdida de SQL, create, PUT ou ativação nunca dispara retry, transporte, novo UUID de gate ou novo consumidor. Se a confirmação não for inequívoca, permanece bloqueada para revisão.

Antes do readback da publicação, **não fechar o gate para uma janela de manutenção**: o emissor original ou execuções iniciadas com a versão antiga ainda podem contorná-lo. Abrir antes do PUT mantém o comportamento normal e evita que a instalação retenha indevidamente novos eventos. A implantação não inclui fechar o gate nem declarar o corte T0. Para um corte posterior, conferir que execuções anteriores do emissor terminaram e coordenar os outros produtores.

A reversão segura imediata é `halt`, seguido de leitura das execuções já iniciadas. Não restaurar o emissor antigo durante gate fechado nem com eventos queued/claimed/review_required/outcome_unknown ou grants sem conciliação: ele contornaria a retenção. Este instalador deliberadamente não oferece restore/delete/cleanup automático. Fila, recibos, identidades e dispatches são preservados. `pending_count=0` ou HTTP aceito não prova fila Listmonk drenada.

## Aceite após revisão

A CI prova o driver inteiro com API simulada, respostas perdidas, versões/corpos/projetos alterados e instalação atômica em PostgreSQL 17.10 descartável. PGlite cobre a mesma montagem SQL. Isso não substitui o readback no n8n real nem prova funcionamento da ligação de itens no serviço. Após publicação/ativação autorizadas, observar um ciclo normal do produtor e consumidor pelos estados/recibos agregados, sem forçar envio ou criar destinatários; falha de finish exige conciliação SQL pela evidência HTTP original, nunca repetir transporte.

CART não contém os emissores TX/popup ou outros produtores. Não é autorização para trocar/reiniciar Listmonk nem uma prova de drenagem global. A janela do serviço continua reservada ao responsável.
