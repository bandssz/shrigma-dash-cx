# CRM23 — prévia nativa e teste de templates existentes

Candidato Growth Fish/Aristo. Depende do parser `growth-email-expressions.js` e do contrato GEC atualizado. Não substitui nem modifica os templates nativos originais. A derivação continua criando um rascunho e, após validação/publicação explícitas, um novo ID transacional.

## Contrato do operador

Mesmo endpoint autenticado de templates, sem alteração no login compartilhado:

- `GET ?acao=email_capacidades`, Bearer gestor: `{contract:"crm_email_native_preview_v1",policy_version:1,brands:["fish","aristo"],native_email_preview:true,native_email_derive:true,native_email_test:true}`. A UI deve exigir essa resposta antes de permitir a nova operação; parser local disponível não comprova backend publicado.
- `POST {acao:"email_previa",rascunho}`: prévia ilustrativa, sem reserva ou transporte. Retorna `eligible`, `code`, `subject`, `body_html`, `data`, `source_hash`, `subscriber_context`, `brand`, `contract` e `profile` quando elegível. Dados e identidade de assinante são fictícios. Não é recibo de envio nem prova de todos os ramos condicionais.
- O cadastro/validação/publicação de sintaxe estendida exige gestor por Bearer. Antes de qualquer escrita ou reserva de publicação, o backend compila/renderiza a fonte em `/api/templates/preview` e verifica novamente o HTML renderizado com GEC. Falha grava recusa 422 na identidade original, sem criar/editar template ou rascunho. Consulta de tentativa permanece o caminho de recuperação.
- `GET email_teste_previa` estendido mantém `contract:crm_email_test_v1` e acrescenta `render_policy:crm_email_native_preview_v1`, `preview_token` e `source_hash`. A UI congela token, versão e dados enquanto confirma. O `POST email_teste` estendido inclui esse token além dos quatro campos existentes. Destinatário, prefixo e dados não são parâmetros livres.
- Os testes simples anteriores continuam usando o protocolo e `subscriber_mode:external` anteriores. O modo nativo `default` só é usado quando a fonte depende de Subscriber.Name/UUID; exige correspondência exata do endereço fixo já cadastrado, status habilitado e ausência de opt-out da marca. Não cria, reinscreve ou modifica assinantes/listas. Nome e UUID entram no snapshot e são relidos sob lock antes da reserva.

Somente `felipebandeira@oaristocrata.com`, assunto com prefixo `✅ FINAL — `, confirmação explícita e uma reserva global por rascunho/versão. A versão estendida usa a mesma tabela, locks, dedupe, finalização e recibos CRM05. Resposta HTTP aceita continua distinta da confirmação SES; uma tentativa incerta nunca autoriza repetição. O único transporte continua sendo o nó CRM05 `/api/tx`, sem retry.

## Segurança e limites

O parser aceita o subconjunto observado/revisado; o wrapper de contexto é gerado pelo backend, sem executar Go em JavaScript. HTML original, literais do template e resultado renderizado passam pelas guardas GEC. Metadados passivos não ampliam permissão para scripts, formulários, redirecionamentos ou recursos ativos.

`source_hash` usa JSON canônico com política, perfil, marca, assunto, envelope, corpo e contexto. `preview_token` é uma identidade de snapshot, vinculada também ao ator e identidade do destinatário; não é autorização. O claim compara novamente snapshot, política, dados sintéticos e token. Nenhuma credencial, recipient_key ou claim_token vai para prévias/recibos públicos.

A prévia nativa retorna corpo HTML e não assunto: o subconjunto simples de assunto é resolvido de forma determinística com os mesmos dados; expressões avançadas em assunto/rodapé permanecem recusadas. A amostra determinística não prova todos os ramos condicionais ou o payload real de uma jornada.

O transporte nativo relê o template pelo ID e pode usar cache. O painel publica IDs novos para revisões; esta mudança não instala trigger global contra edição direta no Listmonk. Uma edição administrativa externa após o claim continua sendo uma limitação de concorrência conhecida. A reserva não prova entrega.

## Implantação faseada pelo responsável

1. Exportar o workflow Growth de templates fresco e guardar versão ativa, configuração, conexões e hashes de cada nó. Guardar definições das funções CRM05, suas permissões/donos e tipos de `subscribers.name/uuid`, além do estado de existência das três funções novas. Não usar o candidato produzido de export histórico como payload de publicação.
2. Conferir que as funções novas não existem. Aplicar `email-native-test.sql` em transação; `CREATE FUNCTION` falha fechado se houver colisão. Não substituir silenciosamente uma versão existente. A migração não altera funções, tabelas ou recibos CRM05. Confirmar que o papel real da API tem EXECUTE nas funções novas, concedendo apenas a esse papel se necessário; PUBLIC permanece sem EXECUTE.
3. Gerar candidato com `patchWorkflow(fresh,{expectedVersionId,expectedNodeHashes})`. Revisar os seis nós existentes declarados, oito nós novos e suas conexões. Credenciais são referências clonadas do mesmo Listmonk; settings, retenção e transporte existentes devem ficar idênticos. O patch exige retenção de payload já desativada. Sem credencial embutida.
4. Imediatamente antes do PUT, reexportar e comparar versão/hash do workflow revisado. Publicar o candidato e ativar a versão quando necessário. Ler a versão publicada/ativa e comparar os corpos e grafo; não tratar sucesso do PUT como publicação comprovada.
5. Conferir `email_capacidades` com gestor, recusas de perfil sem gestor, uma prévia ilustrativa sintética e o GET de prévia de teste. Nenhuma dessas verificações envia mensagem. Só depois liberar a UI dependente da capability. Envio de teste permanece uma ação explícita da UI.
6. CI deve executar os testes focados e `tests/email-native-concurrency-postgres.cjs` em PostgreSQL descartável loopback, banco vazio `crm_email_native_test*`, `EMAIL_TEST_DATABASE_ISOLATED=1`. O runner usa dados sintéticos e não possui transporte.

Rollback: retirar a capability/UI nova por restauração da versão anterior do workflow, preservando todas as operações/dispatches já criados e a consulta CRM05. Não apagar tentativas, não reenviar e não reutilizar versões já reservadas. As três funções aditivas podem ficar instaladas sem rota pública; não precisam ser removidas para restaurar o comportamento anterior.

## Verificação local deste recorte

Testes focados cobrem render inseguro/não confirmado, fonte nativa divergente, token antigo, identidade alterada, opt-out/disabled, dados arbitrários, reserva única entre versões do protocolo, recibo incerto, método/autorização, preservação de transporte/credenciais e recusa durável sem escrita de template. O ensaio de sessões PostgreSQL reais depende da CI; PGlite não prova concorrência entre conexões.
