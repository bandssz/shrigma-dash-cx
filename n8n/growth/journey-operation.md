# Confirmação e recuperação de controles de jornadas

Candidato CRM-10/11. Somente Growth; nenhum workflow, SQL ou arquivo de CX foi
alterado. Não instalado em produção por esta mudança. A leitura do serviço em
25/09/2026 UTC confirmou `shrigma_flow_api(text,jsonb,jsonb)` igual à base local;
SHA-256 da definição retornada por PostgreSQL:
`26d8256fd6822b2d945595388b757190b3e2dc7a54d4b258ab868d89ac3c3c55`.

## Comportamento do operador

- Publicar, pausar e retomar mostram uma confirmação com marca, jornada, versão e
  efeito. Cancelar não faz sequer preflight. Salvar continua sendo rascunho.
- A pausa não recolhe mensagens aceitas/em trânsito. As guardas de compra,
  descadastro e elegibilidade não são alteradas.
- Antes de cada POST, o navegador confirma acesso pela consulta de uma identidade
  nova e grava a tentativa, payload e rascunho no armazenamento local, com releitura
  de verificação. A chave de acesso não entra nesse registro.
- Há uma trava por origem, compartilhada entre abas, marcas, atores e jornadas.
  Uma tentativa pendente/sem recibo impede nova identidade e qualquer POST adicional.
- Timeout não é rejeição. **Consultar tentativa** faz somente GET do mesmo recibo.
  Ausente, identidade divergente, erro de rede ou 5xx continuam incertos. A interface
  preserva o rascunho, a versão original e oferece consulta/atualização da leitura.
- Um recibo definido (inclusive conflito/validação recusada) é aplicado localmente
  antes de liberar controles. Uma rejeição conserva a edição e a versão original;
  atualizar a lista não adota automaticamente a versão de outro operador.
- Após reload, a jornada oferece **Recuperar edição recusada** com a versão original,
  sem POST. Consultar uma tentativa de outra aba não sobrescreve uma edição local
  diferente. Origem da API, acesso e instância do journal são fixados no início da
  ação, mesmo que as capacidades do painel mudem durante a consulta.

O journal `shrigma_flow_operations_v1:grupo-shrigma` não expira ou apaga tentativas.
Falha de armazenamento/Web Locks impede novas escritas. Um registro corrompido ou
apagado exige conciliação; não há botão de limpeza como contorno. O armazenamento
é desta origem/perfil do navegador: esta mudança não promete coordenação entre
dispositivos ou recuperação após limpeza manual de dados. O CAS no servidor continua
protegendo a revisão entre atores. Navegadores antigos que já tenham apenas uma
tentativa em memória precisam preservar essa identidade; a ausência de recibo não
autoriza criar outra.

## Contrato do serviço

`GET ?acao=fluxo_operacao&operation_action=fluxo_salvar|fluxo_publicar|fluxo_estado&idempotency_key=…`
usa o mesmo acesso de escrita da tentativa no header Authorization; nunca na URL.
`shrigma_flow_operation_v1` é STABLE e executa apenas SELECT. Confere capacidade,
ator, identidade e ação. Retorna `flow_operation_v1`, ator, ação, idempotência,
payload exato e resposta persistida. Uma identidade de outro ator/ação devolve erro
sem conteúdo. `missing` não prova que uma transação concorrente não vai confirmar.

`journey-api.sql` mantém a trava de idempotência, comparação ator/payload e trava
da jornada. As rejeições definidas posteriores à reserva lógica são gravadas em
`shrigma_flow_request` na mesma transação, sem audit de sucesso nem mudança da
jornada. Repetir essa identidade continua devolvendo a rejeição antiga, mesmo que
outra versão posteriormente apareça. Exceções SQL, lock timeout e falhas de transporte
não são convertidos em rejeições. Sucessos históricos permanecem intactos.

`fluxo_estado` passa a exigir `confirm: pausar|retomar`, coerente com `enabled`.
Publicar mantém `confirm: publicar`. Atualizações de guardas de envio, templates,
login, credenciais e cache não fazem parte desta mudança.

## Integração pelo responsável pela publicação

1. Exportar novamente a função e o workflow, conferir diferenças/backup; aplicar
   `journey-api.sql` e `journey-operation.sql` após revisão dos candidatos.
2. Aplicar `journey-operation-workflow-patch.cjs` ao export fresco de
   `y6qJRcWcSfEZzwgZ`, passando o `expectedVersion` realmente observado. O patch é
   puro, exige âncoras únicas e a queryReplacement já existente. Só altera o trecho
   de jornadas de `Prepara`; não substitui o nó inteiro, auth, conexões ou settings.
   A versão inicial conferida foi `492cb46a-0755-4b99-861b-64f975271641`; outro patch
   de templates deve ser composto sequencialmente a partir de novo export.
3. Incluir `growth-flow-journal.js` antes de `growth-builder.js` no manifesto Growth,
   reconstruir apenas artefatos Growth e verificar CI. HTML/manifest/assets ficaram
   para integração pelo responsável, não foram alterados neste commit.
4. Conferir leitura e preflight sem mutação em produção. Uma prova de UI com mudança
   real de estado exige jornada/versão/efeito explicitamente revisados; cancelar a
   confirmação é o primeiro smoke sem alterar a operação.

Não implantar apenas a UI: ausência do contrato de consulta bloqueia o primeiro POST.
Backend novo + UI antiga recusam pausa/retomada sem confirmação; coordenar a entrega.
Nenhuma prova ao vivo de mutação foi executada nesta subtarefa.

## Testes

As suítes novas são descobertas pelo job de regressão Growth existente:
`growth-flow-journal.test.cjs`, `growth-flow-controls.test.cjs` e
`journey-operation.test.cjs`. Cobrem duas abas, reload/reselect/refresh, perda de
resposta de sucesso/409/422, armazenamento indisponível, confirmação cancelada,
payload/ator/revisão divergentes, ausência de recibo e preservação de legado.
O SQL candidato é executado sem substituição em PostgreSQL/PGlite isolado com
validador real e fixtures sintéticas. Isso não é prova de concorrência entre
backends PostgreSQL independentes; a trava existente foi preservada, e a suíte do
journal exercita contenção entre instâncias independentes do navegador.

O patch foi também aplicado localmente ao export fresco real: apenas `Prepara`
mudou; GET sintético produziu SELECT parametrizado e POST nessa rota devolveu 405.
O recibo privado fica em `flow-controls/workflow-patch-proof.json`, na auditoria CRM.
