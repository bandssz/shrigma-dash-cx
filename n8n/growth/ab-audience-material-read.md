# Leitura do material A/B — candidato em sombra

`ab-audience-material-read.cjs` captura uma ou duas campanhas CRM da mesma marca (`fish` ou `aristo`) e aplica o contrato de [material declarado](ab-audience-material.md). Não instala tabelas, autentica operadores, expõe rota, agenda, seleciona assinantes ou envia. `ENABLED=false`; todas as saídas mantêm `authorizes_selection=false`, `authorizes_send=false`, `execution_blocked=true` e `external_dependencies_complete=false`.

## Fronteira exigida do chamador

O futuro serviço de admissão deve autorizar operador/marca/ação antes da chamada, abrir uma transação `READ COMMITTED` em uma conexão exclusiva e fornecer a função confiável `query(sql, parameters, {signal})`. São obrigatórios `session_replication_role=origin`, `TimeZone=UTC`, `DateStyle='ISO, YMD'`, `statement_timeout` positivo de até 30 segundos e `lock_timeout` positivo de até 500 ms. Fixar UTC/ISO também antes de capturar o MD5 legado usado pela operação. O leitor verifica essas condições; não as configura silenciosamente.

Identidades de backend/transação são conferidas antes e depois. Isso detecta autocommit e mudanças comuns de conexão, mas não substitui um adaptador confiável que mantenha **todas** as consultas na mesma transação. Um adaptador que intercala conexões e devolve ao backend original nas duas verificações não está coberto. PID zero é aceito para PGlite; o PostgreSQL servidor fornece PID positivo. A função de consulta não pode ser escolhida pelo cliente HTTP.

O chamador mantém a transação aberta para suas conferências seguintes e a encerra explicitamente. Falha exige rollback; o módulo nunca repete a operação. O prazo local (25 s padrão, máximo 30 s) e o sinal de aborto interrompem o resultado e impedem novas consultas, mas não provam que uma consulta já enviada parou. O adaptador deve concluir cancelamento/rollback antes de reutilizar a conexão.

## Consistência do material

As campanhas são bloqueadas em ordem crescente com `FOR UPDATE`. Relações atuais, listas, templates e mídias são lidos e bloqueados com `FOR SHARE`, também em ordem determinística. Não é uma política global contra deadlocks entre todos os escritores existentes; um conflito ou timeout torna a captura indisponível, sem retry.

Antes e depois da captura são exigidas FKs imediatas, validadas, de `campaign_lists.campaign_id` e `campaign_media.campaign_id` para `campaigns.id`, com triggers de integridade ativos. Com essas condições, inserir ou retargetar uma relação precisa do lock da campanha; alterar/excluir uma relação existente encontra o lock da própria linha. As dependências conhecidas permanecem bloqueadas até o chamador encerrar a transação. DDL ou intervenção de superusuário/owner não compõem essa garantia e precisam da janela de manutenção normal.

Não são aceitos campanha fora da marca, campanha ausente, template implícito, referência apagada, relação incompleta ou mais de 1.000 relações no conjunto lido. O contrato individual também limita a soma de template, listas e mídias a 1.000 dependências por campanha.

O snapshot usa as linhas completas de `campaigns`, `templates`, `campaign_lists`/`lists` e `campaign_media`/`media`. É retornado pelo SQL como **texto**, limitado a 8 MiB por campanha, e analisado pelo parser próprio antes de qualquer conversão numérica do driver. Isso impede que um decimal preciso do JSONB seja confundido com outro número após arredondamento JavaScript. Frações e inteiros inseguros são recusados nesta versão.

Há duas capturas sob os mesmos locks; os hashes do material devem coincidir. Só os sete campos operacionais definidos no contrato são excluídos. Um avanço de envio ou atualização de `campaigns.updated_at` pode mudar o MD5 legado sem mudar o hash material. Alterações em assunto, corpo, remetente, relações, templates ou metadados de dependências mudam esse hash. A dupla captura é uma defesa adicional e não substitui os locks.

## Saída privada e limites

O retorno contém `contract`, `brand`, `checked_at`, `materials` e as quatro flags bloqueadas. `checked_at` é obtido do banco e fica fora do material hashado. `materials` contém corpo, headers e atributos completos: deve permanecer no serviço/armazenamento privado. A futura API deve projetar somente o recibo mínimo necessário; não devolver nem registrar automaticamente esse snapshot no painel ou em logs.

O hash identifica **material SQL declarado**. Não fixa os bytes do arquivo anexado, dados personalizados de assinantes, configuração global, transporte, relógio nem funções do template. Templates podem consultar `.Campaign.Status`/`.Campaign.Sent`, que variam durante execução. Por isso um hash igual não garante bytes renderizados iguais; a admissão/seleção futura precisa resolver ou bloquear as dependências relevantes antes de autorizar envio. Nenhuma condição desse leitor muda os contratos existentes de edição, preparo, consentimento ou opt-out.

## Provas locais

`ab-audience-material-read.test.cjs` usa banco PGlite com os guards CRM e a forma completa das colunas nativas. Verifica as duas marcas, conteúdo de template, ausência de mutações, FKs/replicação inválidas, transação incorreta, rollback por deriva, aborto/falha, HTML grande, precisão decimal e timezone.

`ab-audience-material-postgres.cjs` exige banco PostgreSQL 17.10 vazio e descartável em loopback, porta diferente de 5432 e flag explícita de isolamento. Usa quatro conexões independentes mais observação: mudança de template antes do lock é vista após commit; nova relação e edição de mídia aguardam a transação leitora; depois mudam o hash. A alteração exclusiva de `campaigns.updated_at` muda o MD5 real e preserva o material. As campanhas permanecem rascunhos, runtime OFF e nenhum transporte participa.

Essa prova de relação concorrente usa também os guards CRM existentes; não isola o comportamento da FK como único mecanismo. Resultados de execução ficam no checkpoint privado da rodada, separados do código. Nada aqui comprova implantação ou aceite operacional.
