# Extensão TX da retenção já instalada

Candidato de instalação para os seis eventos de pedido mapeados de Fish e Aristo. Não inclui popup, VIP, CX, alteração de gate, reinício ou envio de teste. A migração adiciona somente objetos `tx_*`; o produtor e o consumidor CART ficam byte a byte e na mesma versão. O consumidor TX nasce desligado. Instalação não comprova entrega real.

O `prepare` usa o driver privado existente (`api` n8n e `sql`), exports frescos e um arquivo de aprovação previamente conferido:

```json
{
  "producer":{"version":"...","workflowHash":"sha256 do export inteiro","connectionsHash":"sha256 das conexões"},
  "retention":{"seal_sha256":"sha256 do JSON canônico do selo anterior","shape":"md5 do catálogo atual","control_version":2},
  "cart":{
    "producer":{"id":"ekQxu1pUFyab8Iyd","version":"...","workflowHash":"..."},
    "consumer":{"id":"ID conferido do consumidor CART instalado","version":"...","workflowHash":"..."}
  }
}
```

Os hashes de workflow usam `maintenance-tx-popup-patch.digest`. O hash do selo usa `deploy.sha(JSON.parse(metadata.seal))`. O instalador não aprova sozinho export, selo ou consumidor desconhecido. Exige selo original `maintenance-cart-install-v1` íntegro, banco `listmonk`, dependências exatas, projeto/credencial PG iguais e gate `enabled=true`, `mode=open`, versão **2**. Outra versão exige revisão do plano; não há fallback nem adoção de objetos existentes.

CLI (todos os caminhos do driver, estado e guard devem ser absolutos):

```text
node tools/maintenance-tx-deploy/cli.cjs prepare DRIVER STATE GUARD
node tools/maintenance-tx-deploy/cli.cjs install DRIVER STATE PLAN_HASH
node tools/maintenance-tx-deploy/cli.cjs create DRIVER STATE PLAN_HASH
node tools/maintenance-tx-deploy/cli.cjs patch DRIVER STATE PLAN_HASH
node tools/maintenance-tx-deploy/cli.cjs publish DRIVER STATE PLAN_HASH
node tools/maintenance-tx-deploy/cli.cjs activate DRIVER STATE PLAN_HASH PLAN_HASH:activate
node tools/maintenance-tx-deploy/cli.cjs verify DRIVER STATE
```

O driver exporta `async ({root,store}) => createAPIAdapter({api,sql})`; credenciais ficam no driver privado/memória. O diretório privado contém exports, definições SQL e plano com permissões `0600`, nunca deve ser versionado. O CLI imprime somente versões, hashes, estados e contagens. Não imprime SQL, código de autenticação, corpos de eventos ou destinatários.

`install` executa um único `DO` atômico, com limite de 15 s/lock de 3 s, conferência de funções nativas, selo/estrutura anteriores e gate sob `FOR SHARE`. São fixados os onze corpos das dependências: claims CART/engagement/wrapper TX/Fish/Aristo, `shrigma_flow_slot` e seu resolver `shrigma_flow_slot_wa_versioned_v1`, finishes CART/Fish/Aristo e classificador de transporte. Assim, mudar o claim chamado pelo wrapper também invalida o plano. O novo selo `maintenance-tx-install-v1` contém o selo anterior integral em `previous` e o novo hash de estrutura. Qualquer erro desfaz DDL e novo selo juntos, conservando filas e recibos. **O verificador antigo CART passa a rejeitar o selo novo por desenho.** Use este verificador combinado; não recoloque o selo antigo e não reinstale a base para silenciar o erro. A sequência de governança fica registrada no próprio selo.

Cada fase grava um intent durável antes da escrita. Resposta perdida ou timeout não autorizam repetir: `reconcile DRIVER STATE PHASE [CONSUMER_ID]` faz somente leituras. Em criação incerta, encontre o ID pela identidade única do nome no plano e confira o export; ausência não comprova falha. Sem prova exata a fase continua bloqueada. O script nunca reenvia uma escrita incerta nem procura outro consumidor por nome para ativar.

Antes do PUT há GET fresco do produtor TX, conferindo versão, conteúdo, credenciais, projeto e publicação. O PUT do n8n 2.0.2 pode publicar imediatamente: `publish` confirma o corpo publicado exato e não reativa se já estiver correto. Quando necessário, ativa somente a versão salva. A API não oferece CAS de versão no PUT: exige janela sem outro editor, e o readback não elimina a corrida de um administrador entre GET e PUT. O consumidor só é ativado após confirmação do produtor e nova conferência de selo/gate/CART.

`halt DRIVER STATE PLAN_HASH` desativa somente o consumidor TX novo, preservando entrada durável, fila, tokens e carrinho. Não significa drenagem e não restaura o produtor antigo que desviaria da retenção. Fechamento de manutenção e comprovação de execução/entrega continuam separados desta instalação.

Testes usam apenas fixtures sintéticas. O runner PostgreSQL exige `MAINTENANCE_TEST_DATABASE_ISOLATED=1`, PG **17.10**, usuário `synthetic`, `127.0.0.1:5432`, banco exclusivo `maintenance_tx_install_test`, sem senha. Execute `tests/maintenance-tx-deploy-postgres.cjs` na CI descartável; nenhum endpoint real é chamado.
