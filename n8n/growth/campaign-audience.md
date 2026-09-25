# CRM-06 — revisão do público

Esta mudança está preparada em código e testes. Não representa implantação ou prova de envio. O backend e o cliente precisam entrar juntos na publicação final: o cliente anterior não envia a identidade da revisão e será impedido de agendar. Consulta de campanhas, operações e recibos antigos continua disponível.

## Regra e limites

A contagem usa a união dos inscritos das listas salvas na campanha, deduplicada por `subscribers.id`. Segue a seleção de campanhas regulares do [Listmonk 6.1.0](https://github.com/knadh/listmonk/blob/v6.1.0/queries/campaigns.sql): bloqueados globalmente são excluídos; lista double opt-in exige vínculo confirmado; lista single opt-in aceita confirmado ou não confirmado, excluindo descadastro. Um vínculo elegível basta, mesmo que outro vínculo esteja descadastrado. As listas precisam estar ativas e pertencer à mesma marca, Aristo ou Fish.

O estado global `disabled` integra o público nativo do Listmonk. O resultado o informa em `native_disabled_count`, incluído em `eligible_count`, e o agendamento é recusado quando essa quantidade é maior que zero. Não há alteração de contatos nem filtro inventado que prometa um público diferente do worker. Histórico de bounce não é um filtro independente nessa consulta nativa; um bounce só se reflete aqui quando resulta em bloqueio ou descadastro. Olivas e campanhas não geridas pelo contrato ficam fora desta etapa.

O total é uma fotografia do momento. A revisão dura cinco minutos, e a mesma transação que agenda recalcula a composição. Isso detecta uma troca de destinatários mesmo com total idêntico. Não congela o público até a data futura: alterações posteriores, inclusive opt-out, continuam possíveis; o worker nativo seleciona novamente no início e por lote. O total efetivamente enviado pode diferir. Não há bloqueio das tabelas de inscrições durante a espera pelo envio.

Só quantidades, metadados da campanha e horários saem do SQL. A composição é identificada por SHA-256 de IDs e estados elegíveis ordenados, em blocos de 1.024, e o digest permanece na validação privada do banco. Nenhum nome, endereço ou identificador de inscrito entra no runtime, no navegador ou no recibo público. Ordenação e materialização ocorrem no PostgreSQL, com a gestão de memória/disco do próprio banco; não há afirmação de custo constante para bases grandes.

## Contrato público

`campanha_validar` preserva `{campaign, tracking, validation}`. A validação passa a conter:

```json
{
  "policy": "crm-campaign-v1",
  "version": "versao-da-campanha",
  "ok": true,
  "validated_at": "2026-09-24T15:00:00.000Z",
  "audience": {
    "policy": "listmonk-6.1-regular-v1",
    "review_id": "00000000-0000-4000-8000-000000000001",
    "campaign_id": 100,
    "campaign_version": "versao-da-campanha",
    "brand": "fish",
    "list_ids": [3, 17],
    "eligible_count": 20,
    "unique_members_count": 25,
    "excluded_blocklisted_count": 2,
    "excluded_subscription_count": 3,
    "native_disabled_count": 0,
    "checked_at": "2026-09-24T15:00:00.000Z",
    "expires_at": "2026-09-24T15:05:00.000Z",
    "frozen": false
  }
}
```

Os valores acima são sintéticos. Público vazio ou com `disabled` ainda pode ser conferido e exibido; `ok:true` significa que a validação foi concluída, não que existe autorização para agendar. O contrato `audienceReview` só permite ambos no modo de exibição `allowBlocked:true`.

`campanha_agendar` exige `audience_review_id` além de marca, ID, versão esperada, chave de idempotência e `confirm:'agendar'`. A resposta confirmada contém `{campaign, operation_id, audience}`; `audience` acrescenta `rechecked_at`. O recibo persistido atomicamente contém esse mesmo objeto. O ID e a versão da audiência descrevem a revisão anterior ao agendamento; `campaign.version` representa o estado já agendado.

`AUDIENCE_REVIEW_REQUIRED`, `AUDIENCE_STALE`, `AUDIENCE_CHANGED`, `AUDIENCE_EMPTY` e `AUDIENCE_DISABLED` são recusas definitivas HTTP 409. Uma perda de resposta continua incerta e exige consulta da operação original, sem repetição automática ou troca da chave. A revisão é emitida exclusivamente pelo SQL; `validation_set` legado não aceita fabricar `audience` ou seu digest.

Horários públicos da revisão saem do banco em UTC com milissegundos e `Z`. A duração é exatamente 300.000 ms e o SQL usa seu próprio relógio. O contrato de data de envio exige fuso explícito e rejeita datas de calendário ou horas inválidas; mantém a antecedência mínima de 15 minutos. O relógio do navegador só ajuda na apresentação, não substitui as verificações do servidor.

## Integração e implantação

A tela mostra elegíveis, descartes, desativados, horário da conferência e validade antes de confirmar. Explica a deduplicação e o opt-out por lista. A confirmação captura a mesma marca, revisão e versão da campanha; edição, expiração, mudança de marca ou conflito exige nova validação. O cliente confere a validade novamente ao aceitar o diálogo e sob a proteção entre abas antes de enviar a solicitação. Conteúdo local sem revisão remota não pode ficar agendável. A consulta de recibos antigos não deve depender do novo campo.

A integração combinada anuncia `campaigns.audience_review:'listmonk-6.1-regular-v1'` nas capacidades e exige esse valor para conferir público e realizar novos agendamentos. Sem a capacidade nova, leitura, consulta de recibos, salvar rascunhos e cancelamento continuam disponíveis. O gerador de patch admite somente o contrato legado conhecido ou o novo; preserva as capacidades das demais frentes e recusa contratos ou endpoints divergentes. O código do cliente e do patch faz parte desta mudança, mas a capacidade não foi publicada no ambiente. Não anunciar suporte antes de concluir backend, cliente, testes e conferências do ambiente.

Para instalação já existente, `campaign-audience.sql` é incremental, transacional e idempotente. Exige as versões anteriores de cancelamento e recibo atômico; compara os corpos conhecidos do provider/store e, se presente, do helper antes de substituir. Drift interrompe a transação. Não reinstala tabelas, altera campanhas, apaga validações antigas, reconcilia operações incertas ou modifica as seis guardas. Em instalação nova, usar os arquivos canônicos `campaign-store.sql` e `campaign-provider.sql`.

A migração SQL precede o novo runtime, e o cliente compatível/capacidade entra somente após a conferência de ambos, dentro de uma implantação coordenada. Não publicar uma metade funcional. Validações antigas permanecem registradas, mas não autorizam novo agendamento: é preciso validar novamente. Cancelamento e consulta de recibos antigos preservam o contrato anterior.

As funções continuam `SECURITY INVOKER`, sem concessões públicas. Confirmar a identidade da credencial do runtime e seus privilégios existentes no ambiente antes de instalar: a leitura precisa abranger `subscribers(id,status)`, `subscriber_lists(subscriber_id,list_id,status)` e `lists.optin`, além dos objetos já usados; o chamador precisa executar o novo helper. Se a instalação usar papel distinto do proprietário, uma concessão mínima ao papel identificado deve ser revista separadamente. Não presumir superusuário, ampliar privilégios globais ou contornar as guardas.

## Evidência de testes

Os testes locais usam exclusivamente dados sintéticos: união e double/single opt-in, bloqueio e desativados, zero elegíveis, troca de composição sem mudar total, limite entre blocos de hash, revisão expirada ou forjada, fuso e data inválidos, recibo atômico, perda de resposta, recuperação e preservação das versões antigas. A migração é aplicada duas vezes, comparada à instalação canônica e testada contra drift; campanhas, reservas e guardas permanecem iguais.

`campaign-audience-concurrency-postgres.cjs` exige três conexões independentes a um PostgreSQL descartável em localhost com banco/usuário sintéticos explícitos. O agendamento espera uma trava de campanha; outra conexão confirma um opt-out ou troca de membros; ao prosseguir, a transação precisa rejeitar a revisão antiga. O workflow de CI provisiona esse banco sem segredos, SMTP ou produção. Essa prova real de sessões é obrigatória antes de aprovar o agendamento; PGlite local não a substitui.

A integração do cliente resolve a incompatibilidade anterior sem relaxar o contrato. Testes cobrem revisão trocada em outra aba, público vazio ou com desativados, expiração durante a confirmação, recibo de agendamento divergente, capacidade ausente e recuperação de recibos legados sem revisão de público. A publicação final exige regressão verde, prova concorrente em CI e verificação da implantação. Nenhum teste aqui comprova entrega de e-mail.
