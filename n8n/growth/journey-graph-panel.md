# Construtor no painel — rascunhos

O painel carrega o construtor apenas quando o helper declara `journeys.graph_drafts = journey_graph_draft_api_v1` e fornece `endpoints.journey_graph`. A aba aparece em **Automações → Construir fluxo**, exclusivamente para Fishermans e O Aristocrata. Sem essa capacidade, as jornadas atuais continuam funcionando como antes e o novo cliente não faz requisições.

O operador monta entrada, espera, condições E/OU, e-mail e saída; salva, reabre e simula. As opções vêm do catálogo atual da marca. A etiqueta **Rascunhos** informa que a ativação dos novos fluxos ainda não está disponível. O catálogo de planejamento não atesta compra atualizada, consentimento ou ligação das variáveis de cada template. Esses requisitos permanecem necessários antes de implementar publicação e execução.

## Salvamento e recuperação

O navegador guarda a preparação por marca e registra a tentativa antes do POST. A API atribui o operador; o cliente conserva marca, endereço, payload e UUID, sem armazenar a chave no registro. Somente uma tentativa pendente por origem é admitida entre abas. Após uma resposta perdida, a consulta usa o mesmo UUID. A opção explícita **Retomar gravação** repete exclusivamente aquela gravação de rascunho, nunca um envio.

Um recibo só libera a próxima operação depois de o navegador guardar a identidade e a revisão recebidas. Uma resposta atrasada não pode substituir a edição de outra marca. Conflito de versão conserva a edição atual. Trocar ou substituir um rascunho com alterações exige confirmação; trocar de marca preserva a preparação correspondente.

## Implantação

1. Conferir main, testes de cliente/DOM e CI PostgreSQL real.
2. Exportar os workflows e suas versões atuais; validar dependências do catálogo e do helper gestor no banco.
3. Instalar o schema candidato original uma única vez, depois catálogo e ponte HTTP. As funções novas não concedem publicação ou envio; `control.enabled` permanece falso.
4. Criar workflow Growth exclusivo a partir do gerador, usando a credencial PostgreSQL existente. Conferir a versão ativa e autenticação, marca, catálogo, criação e recuperação de rascunho sintético nas duas marcas.
5. Publicar o cliente e somente então anunciar a capacidade no helper, com export fresco, guarda de versão e conferência do conteúdo ativo. Conferir o endpoint e os arquivos realmente publicados.

Rollback: retirar apenas o anúncio da capacidade, desativar o novo workflow e conservar schema/revisões/recibos. Não apagar tentativas nem reverter tabelas das jornadas atuais. Nenhum procedimento deste recorte troca serviço, inicia emissor ou modifica CX.

## Evidência

Os testes locais usam dados sintéticos. O workflow de CI `Candidate journey graph` acrescenta PostgreSQL 17.10 para concorrência, autorização após espera, versões e recuperação. A descrição do PR deve separar resultados executados de verificações ainda pendentes; arquivo no repositório não comprova instalação em produção.
