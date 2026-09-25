# Acesso do gestor CRM ao registro A/B

Candidato local; não publicado. A/B operacional (distribuição, envio e resultado) é outro contrato e não está concluído por esta ponte.

`ab-operator.sql` adiciona uma função Growth que consulta `shrigma_crm_operator_auth_v1`, sem alterar login, cache ou a função compartilhada. `read_content` permite capacidades/registro/recibo; `draft` permite gravar o registro descritivo de Fish e Aristo. A autoria deriva do identificador estável `who` autenticado (não o rótulo de apresentação), com domínio próprio, e continua igual após rotação da chave do mesmo operador. O chamador não escolhe o ator.

`ab-operator-workflow-patch.cjs` recebe export fresco + `expectedVersion`. Muda apenas os três nós Code da API dedicada `WjreLAEvwzDJnCoo`; mantém conexões, credencial Postgres e os recibos do contrato `ab_registry_v1`. O segredo de legado já presente no export continua privado. Uma chave igual à legada segue o principal antigo; outra chave é validada pelo auth CRM no banco. Chaves ausentes são recusadas antes de consulta; inválidas não gravam. Parâmetros transitórios exigem retenção `none`, manual false e progress false.

Integração do painel: para novas ações passar a chave já autenticada do CRM a `GABServer.create({endpoint,key,...})`. Não solicitar outro acesso. A chave fica no header de GET/corpo de POST, nunca no URL, recibo ou journal. O journal existente continua obrigatório. Uma tentativa antiga feita com o acesso legado só pode ser reconciliada com seu principal original; não trocar a autoria, não descartar a pendência e não repetir POST para converter o registro. Um resultado incerto continua consultável por GET apenas.

Implantação coordenada: instalar função → patch sobre novo export exato → provar GET capacidades/recibo inexistente com gestor e rejeição sem acesso → integrar UI. Nenhum destes passos autoriza um envio. A função antiga e as linhas de histórico não são reescritas. Nenhuma alteração em CX.

Verificado: 29 testes locais (PGlite + sandbox Code sem imports + regressões client/journal/SQL v1). O patch aplicou ao export lido em 25/09, versão `5dd5cc4a-4b8e-4444-b0e1-74b9b50e0d1c`, mudando só os três nós esperados; não foi enviado ao n8n. A consulta real de auth do gestor retornou acesso válido e capacidades esperadas; nenhum segredo foi incluído nesta evidência.
