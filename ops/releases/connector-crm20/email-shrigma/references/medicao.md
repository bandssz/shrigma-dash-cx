# Medição sem misturar entrega e atribuição

## Sempre declarar

Marca, iniciativa/disparo, intervalo e fuso, quando houve coleta, universo elegível, fonte, janela de maturação, modelo e denominador. Abertura/clique de campanha e receita de pedido são fontes distintas. Se a fonte não estiver acessível, mostrar a lacuna; não preencher com zero.

| Métrica | Leitura |
|---|---|
| Selecionados | Contatos na audiência elegível/materializada. Não prova envio. |
| Aceitos/enviados | Confirmação do transporte ou contador do emissor; identificar a fonte. |
| Entregues | Evento de entrega. Não confirma inbox nem leitura humana. |
| Abertura única | Assinantes identificados com pixel observado; sujeita a proxies/bloqueios. |
| Clique único | Assinantes identificados com clique observado; pode incluir scanners/bots. |
| CTR | Clicadores únicos / denominador declarado, por exemplo enviados. |
| CTOR | Clicadores únicos / abridores únicos; pode ultrapassar 100% se cliques não tiverem pixel de abertura. Investigar grão/coleta; não chamar matematicamente impossível. |
| Conversão de cadastro/VIP | Evento próprio e janela explícita; não é receita de compra. |
| Receita atribuída | Pedido pago elegível, valor líquido e vencedor do modelo/janela. |

## Envios de teste fora do resultado

Teste não é resultado de campanha. Excluir envios de teste de **selecionados, enviados, aberturas, cliques, CTR, CTOR, conversões e receita atribuída** — o time clica nos links para conferir, e isso infla justamente o denominador pequeno do início do disparo. No teste de template o transporte é separado da campanha; no teste de campanha ele usaria a identidade real do disparo. O ensaio isolado de 26/09 **provou** que o teste nativo de campanha incrementa aberturas e cliques da campanha real — não há `is_test` em `campaign_views`/`link_clicks` — e a separação para campanha **ainda precisa ser implementada e comprovada com dado real** (contrato pendente em `teste-controlado.md`). Até lá, ao ler uma campanha que teve teste por qualquer via, declarar a possível contaminação e o horário do teste em vez de presumir que o número está limpo.

## Atribuição atual do Growth

Identidade de compra por marca + pedido. Janela de 30 dias; `last_click` considera a última visita, inclusive direta; `last_non_direct` desconsidera retorno direto posterior conforme regras publicadas. Referências técnicas do checkout/modal não devem virar origem comercial. Pagamentos líquidos consideram reembolsos. Pendências de jornada/cobertura não viram certeza.

Iniciativa comercial agrupa e-mail e WhatsApp pelo mapa de aliases. Manter modelos separados. Deduplicar pedido no total da iniciativa e vencedor; assistência não é uma segunda receita para somar. Os disparos com UTMs compartilhadas ficam ambíguos; não ratear o total por base. Quinze disparos históricos sem UTM constavam do catálogo em 15/09; reconsultar o número quando reportar.

A expressão antiga `clicou na campanha AND tem atributo conversao` mede associação de pessoas, sem provar ordem temporal, pedido, valor ou último toque. Não usar como last click, receita atribuída nem conversão por posição.

## Posição do link

```sql
SELECT l.url, count(DISTINCT lc.subscriber_id) AS clicadores_identificados
FROM link_clicks lc JOIN links l ON l.id = lc.link_id
WHERE lc.campaign_id = :campaign_id AND lc.subscriber_id IS NOT NULL
GROUP BY l.url;
```

SQL ilustrativo: parametrizar conforme o cliente, confirmar schema e intervalo. Agregar por `utm_content` depois de resolver o destino rastreado/cupom. Receita por posição exige o vencedor/jornada contendo aquele `content`; se não houver, apresentar só cliques. Não repetir a conversão total da peça em cada linha.

## Provedor, comparação e maturação

A visão agregada é útil para total e tendência; também segmentar por provedor quando investigar entrega/audiência. Comparações entre Gmail e outros são diagnósticas, não um teste causal automático: composição, clientes e privacidade diferem. Abertura baixa isoladamente não prova spam.

Usar domínio do endereço com igualdade/terminação correta, incluindo `gmail.com`/`googlemail.com`; não `LIKE '%gmail%'`. MX de domínio corporativo pode ser necessário para identificar o provedor real. Registros anônimos/nulos ficam fora do único identificado, mas registrar sua quantidade e cobertura.

Leia query, snapshot e tamanho de cada braço antes de comparar. Teste A/B: braços disjuntos, mesma elegibilidade/janela, um fator alterado, desfecho e critério definidos antes. Razão 1,4× por si só não garante evidência suficiente. Não tratar diferença por provedor como certeza de causa.

Prática interna: segurança em T+3h, desempenho T+24h (até T+36h no fim de semana), remetente historicamente T+20h. Ajustar conforme início/fim real da fila e volume; uma falha grave não espera a janela. Postmaster pode estar atrasado ou sem amostra: ausência não é 0%.

## Fadiga e evidência

Contar envios efetivos por pessoa e janela quando disponíveis; estar em quatro listas não prova quatro recebimentos. “Quatro em oito dias” é um resultado histórico de uma coorte, não limite universal. Para cada aprendizado novo guardar data, campanha, público, comparação, enviados, cliques/evento, fonte, hashes/IDs e limitações.
