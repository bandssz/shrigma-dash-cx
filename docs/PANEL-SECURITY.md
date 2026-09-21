# Acessos por área e segurança

Entradas independentes: `/cx/`, `/crm/`, `/organico/`, `/creators/`. O acesso mestre entra em `/gestao/`; apenas uma identidade mestre confirmada pela API recebe a navegação entre áreas. Creators e Afiliados TikTok permanecem juntos. São URLs distintas no mesmo domínio, não cinco origens ou instalações independentes.

Cada acesso humano novo tem um segredo aleatório próprio, uma área (ou `todos` para o mestre), prazo e revogação no servidor. O banco guarda o hash SHA-256, adequado a segredos aleatórios de 256 bits, não a senhas escolhidas por pessoas. O identificador da linha e o hash nunca são aceitos como chave. Não existe autenticação pelo nome da área ou por um campo alterado no navegador.

A consulta é o padrão; permissões de operação são concessões explícitas no servidor. O gestor CRM e o mestre receberam edição/validação/publicação nas APIs de campanhas, templates e configurações de fluxos já suportadas. O gestor Creators e o mestre receberam cadastro de influenciadores, cupons, termos e custos. CX/CS e Orgânico mantêm consulta. As mesmas chaves de entrada atendem essas operações, sem segunda chave na interface. Envio/agendamento e publicação continuam sujeitos às confirmações, recibos, revisão e guardas existentes; entrar nunca dispara uma operação comercial.

A/B mantém a autorização própria do registro atual; decisões de amostras TikTok não são concedidas por `creators_edit`. O editor de fluxos continua limitado ao motor existente: esta concessão não implementa execução de grafo livre. Revogar/expirar a credencial ou retirar uma concessão bloqueia as próximas operações no servidor, mesmo com uma aba antiga aberta. O mestre recebe concessões explícitas de CRM e Creators, sem promoção implícita de qualquer chave histórica. O acesso de serviço do cache CX fica em uma credencial do cofre n8n, separado dos gestores.

## Sessão e transporte

A entrada valida a identidade no servidor antes de abrir o painel. A chave vive somente na memória da aba; sair destrói o painel incorporado e o acesso, e a sessão local termina após 8 horas. Fechar ou recarregar a entrada exige novo login. O portal remove apenas antigos slots de credenciais do navegador; não apaga rascunhos, preferências, reservas ou operações incertas.

A navegação mestre usa comunicação entre janela e painel da mesma origem, conferindo janela emissora, origem, painel e caminho fixo. A API continua verificando o escopo em cada consulta. Alterar a navegação ou abrir o endereço de outra área diretamente não amplia a credencial.

Consultas do navegador usam `Authorization: Bearer` e não carregam segredo na URL. Respostas autenticadas são `no-store`; origem de navegador é restrita. O backend mantém compatibilidade explícita com integrações antigas até a transição das credenciais ser conferida. Logs de execução dos workflows afetados deixam de guardar entradas/saídas que contêm segredos; recibos e auditoria de negócio no banco permanecem.

## Defesa do frontend

As entradas usam CSP sem scripts inline. Os HTML de conteúdo permitem somente os scripts locais e os hashes dos blocos inline gerados pelo build, sem `unsafe-inline` para JavaScript. Estilos inline permanecem necessários ao código atual. Objetos incorporados, troca de base URL e submissão de formulário fora dos handlers são bloqueados. A política de referência é `no-referrer`.

GitHub Pages continua hospedando arquivos públicos. A proteção é dos dados e operações nas APIs; esta solução não torna HTML/JavaScript confidenciais nem constitui separação de origem entre painéis. Não publicar exports de runtime, credenciais, arquivos de acesso, snapshots ou relatórios privados.

## Verificação e manutenção

`node tools/panel-build/build.cjs` gera os cinco acessos, bundles e hashes CSP. A CI confere artefatos e executa regressões e `tests/panel-auth-postgres.cjs`: matriz de escopos, revogação, expiração, hash não reutilizável e preservação de consulta/escrita. Patches de runtime exigem export fresco, versão esperada, leitura após publicação e preservação dos demais nós/recibos. O coletor não escolhe mais uma chave de pessoa no banco. `tests/panel-operator-postgres.cjs` verifica concessões, revogação, expiração, fallback de leitura, preservação do escritor legado e replay da migração histórica. `panel-operator-patch.cjs` altera somente os pontos de autenticação/identidade em quatro workflows; o SQL de negócio permanece igual.

Não tratar esta revisão como um teste de invasão completo. MFA/SSO, limitação de tentativas na borda, cabeçalhos de hospedagem como `frame-ancestors`, revisão integral de XSS e rotação dos acessos externos/integradores têm aceites próprios. Mudança de gestor exige revogar a credencial anterior e emitir outra; nunca reutilizar a chave de outro operador para resolver uma operação incerta.

Referências: [OWASP — autorização por requisição](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html), [GitHub Pages — HTTPS e limites de hospedagem](https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https), [n8n — credenciais HTTP](https://docs.n8n.io/integrations/builtin/credentials/httprequest/).
