# Conferência privada de chave individual do backend

`verify-backend-credential.cjs` é uma ferramenta local de operador, fora do pacote HTTP do dashboard. Ela chama **diretamente** a identidade do backend aprovado: CRM em `crm-panel-read /read?action=identity&painel=growth`; Orgânico e Influs no webhook `cx` com `access=1&painel=<área>`. As respostas de identidade em `/api/cx` e `/api/crm-read` do dashboard são geradas pelo próprio dashboard e **não** verificam a chave upstream.

O operador deve fornecer, por uma entrada padrão privada, um único objeto JSON com **exatamente** `slot`, `expectedOwner` e `bearer`. O `expectedOwner` deve ser o rótulo exato `dono` atribuído à chave no backend, conferido fora deste chat. A chave não deve aparecer em argumento de processo, URL, histórico do terminal, Git, logs ou nesta conversa. A ferramenta recusa stdin interativo e arquivo regular legível por grupo/outros; usar um pipe privado do cofre ou um arquivo temporário 0600 sob diretório privado. Exemplo de invocação, sem qualquer valor de chave:

```sh
node services/dashboard-operational/verify-backend-credential.cjs < /caminho/privado/entrada-0600.json
```

Slots aceitos: `growth-read`, `growth-campaign-read`, `growth-audience-read`, `growth-ab-read`, `growth-flows-read`, `organico-read`, `influs-read` e `tts-read`. Os demais falham antes da rede. Em especial, **não** cadastrar `organico-links` a partir desta prova: seu endpoint de leitura usa a mesma chave que `salvar` e `arquivar`, sem capability de escrita separada no SQL atual. `growth-templates-read` também permanece sem destino revisado. Chaves de escrita exigem auditoria própria e não são verificadas por este utilitário.

Uma resposta positiva confirma somente: endpoint direto HTTPS fixo, autenticação da chave naquele momento, `role=manager`, área única esperada, ausência de CX/`todos`, correspondência exata de `owner` e ausência de capacidades de escrita *conhecidas* na resposta. A saída contém apenas slot, área e `status: "partial"`; `readOnlyProven` é sempre `false`. O backend n8n pode omitir capacidades, e a identidade do CRM não atesta todos os serviços auxiliares ou caminhos legados. Antes de cadastrar a credencial no banco do dashboard ou liberar integração real, conferir concessões efetivas e revogação no backend, unicidade por pessoa/área e o serviço ativo contra o catálogo revisado. Esta conferência de identidade altera somente a telemetria de uso da chave no backend; não consulta dados de negócio nem aciona mensagens, workers ou sincronizações.

O utilitário usa GET com `Authorization: Bearer`, sem Origin, sem redirects, sem credencial em query, timeout de cinco segundos e resposta limitada a 8 KiB. Toda falha retorna somente `Backend credential verification refused.`; não imprimir corpos HTTP nem erros internos ao investigar. O teste local usa `fetch` simulado e não chama o servidor: `node --test services/dashboard-operational/verify-backend-credential.test.cjs`.
