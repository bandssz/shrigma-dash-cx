# A peça no CRM

Para operar pelo chat com a conta individual liberada, use [operação pelo CRM](operacao-crm.md). Este arquivo descreve o percurso pela tela; contas fora do rollout conservam seus limites. Nas editor-qa do fluxo nativo, salve a data antes de Agendar e confira o mesmo instante após reabrir; janela de 20 minutos a 7 dias, abertura geral só com “passou” de Felipe.

O CRM fica em https://crm.shrigma.com.br/app/crm/. Cada analista entra com o próprio e-mail e senha; só aparecem as marcas liberadas para ele. A senha do CRM não é a do Listmonk. Nunca compartilhe senha, chave ou sessão, nem cole contatos de cliente no Claude.

## Levar a peça para Modelos

1. Abra **Modelos → Importar peça pronta**.
2. Cole o conteúdo ou abra o arquivo (UTF-8, até 200 KB). Escolha **Formato**, preencha **Nome da peça**, **Assunto** e **Conteúdo**.
3. Clique **Conferir prévia**, confira marca, assunto, links, imagens e descadastro, e marque a conferência. A prévia bloqueia recursos externos: imagem que não aparece ali não prova que o endereço está quebrado; confira o link da imagem.
4. Use **Salvar novo rascunho → Reabrir rascunho** e aguarde a confirmação para ver que voltou do servidor.

Salvar modelo não envia nada.

## O que o CRM opera

| No CRM | Observação |
|---|---|
| Público | Montar, contar e salvar. Contagem indisponível não é zero. |
| Campanha | **1. Para quem:** público salvo e contagem; **2. O quê:** nome, assunto e Peça com prévia. Iniciativa, links e padrões ficam em **Avançado**; a identidade do disparo (`utm_term`) é conferida aqui antes do agendamento. |
| Teste | No percurso anterior: **3. Teste → Preparar teste → Enviar teste para minha caixa**. No QA nativo: **Enviar teste interno**, para o endereço interno informado; assunto "[TESTE] ". Não repetir teste aceito ou incerto. |
| Agendamento e cancelamento | **4. Quando → Horário de envio · Brasília**. QA nativo: salve a data e depois **Agendar**, entre 20 min e 7 dias. Demais editores conservam a janela anterior de 20 min–2 h. Confira **Agendada**; **Cancelar agendamento** devolve **Rascunho**, sem data. |
| Jornadas | Criar, **Salvar jornada**, editar, testar na própria caixa e **Pedir ativação** em Gestão; ativação real **em breve**. |
| Resultados | Marca e período no alto da tela; indisponível não é zero; receita atribuída não é receita incremental. |

## Regras de convivência

- **"Em breve" identifica a ativação real de jornada.** As operações de campanha estão disponíveis no CRM; não use controle antigo, API ou atalho para contornar.
- **Resultado incerto:** consulte a mesma tentativa. Repetir pode duplicar envio.
- **Marca primeiro:** confira a marca antes de importar ou montar qualquer coisa. Troca de marca invalida o que foi lido antes.
- **O que vale é a tela de hoje.** Este arquivo envelhece; capacidade nova só conta depois de aparecer liberada no CRM.
