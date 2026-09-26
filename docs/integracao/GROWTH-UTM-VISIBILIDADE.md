# Consulta de UTMs no CRM

O painel mostra as cinco UTMs e a origem de `utm_source` em campanhas e etapas das automações de Fishermans e O Aristocrata. A consulta não altera links, templates, automações ou envios.

## Fontes e limites

- **Campanha no histórico:** padrões retornados pela atribuição, que reúne links da campanha e cliques históricos. São valores registrados; a consulta não recupera a expressão que os gerou.
- **Campanha no editor:** conteúdo da versão selecionada, incluindo expressões do template sem executá-las. Edições locais são identificadas.
- **Automação, links do template:** conteúdo atual do template selecionado, isolado por marca, canal e identificador.
- **Automação, regra do envio:** conferência datada dos emissores publicados. `growth-runtime-utm.js` contém apenas parâmetros e vínculos comprovados, sem endereços de clientes ou credenciais. Não é uma consulta ao vivo do código dos emissores. O painel identifica a data da conferência.

Os parâmetros acrescentados pelo envio não representam necessariamente a URL completa. Carrinho preserva os parâmetros já presentes; os contratos de status do pedido só acrescentam cada UTM ausente. O WhatsApp do carrinho usa a variante efetivamente enviada. Botão PIX nativo não é um link com UTM.

Ausência de regra comprovada não significa ausência de rastreamento. O painel mantém essa limitação explícita e exibe os parâmetros disponíveis no template. Não deriva `source`, campanha ou conteúdo apenas do nome da marca/canal/etapa.

## Manutenção

Ao alterar um emissor de Growth, revisar também o catálogo de leitura. Conferir a versão publicada e o trecho que efetivamente monta o parâmetro enviado, não apenas helpers ou rascunhos. Guardar hashes e prova privada da leitura; atualizar data, tuplas e condições de vínculo no mesmo PR. Se não houver prova, manter o caso como desconhecido. Nunca copiar eventos reais, URLs autenticadas ou tokens para o catálogo público.

As regras de status do pedido exigem template exato e versão publicada mínima. Novos vínculos não herdam regras por semelhança de nome. Os links literais dos templates são relidos pela interface, sem manter uma cópia histórica como configuração atual.

## Validação

Testes cobrem extração de parâmetros, expressões não executadas, marca e vínculo exatos, condições de versão/template, PIX, valores ausentes, escape de HTML e agrupamento sem inventar combinações. Depois de publicar, abrir uma campanha e o carrinho nas duas marcas; conferir e-mail, WhatsApp e data da regra. Nenhum envio de teste é necessário para essa alteração de consulta.
