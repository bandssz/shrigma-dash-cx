# Piloto interno de parceiros e Meta Ads

O acesso `/creators/` reúne Creators, Parceiros do site, Conteúdo em anúncios e Afiliados TikTok. Gestor Creators e mestre podem operar o piloto com a chave de entrada. As regras confirmadas para o novo programa são 7% sobre produtos após descontos, sem frete, cancelamentos e estornos, com pagamento até o dia 5 do mês seguinte. Isso não altera contratos atuais.

## Operação disponível

- Cadastrar um candidato vindo do formulário existente ou de revisão manual; editar perfil, referência e situação. A aprovação é interna ao piloto. CPF, Pix e dados bancários não fazem parte desta ficha.
- Consultar anúncios reais por marca/período, filtrar UGC/IA/GR e revisar o vínculo ao cadastro do criador. Salvar vínculo não altera o anúncio, o orçamento nem a comissão.
- Comparar receita de cupom do ledger de pedidos pagos com valor atribuído pela Meta em colunas separadas. Nenhum total combina essas lentes.
- Recibo de gravação com identidade própria, versão e autoria de servidor. Conflitos exigem nova leitura. Resposta incerta bloqueia novas escritas; conferir o recibo usa a mesma chave e não reenvia a alteração.

## Identificação e métricas

A referência de nomenclatura fornecida usa a segunda posição `[UGC-…]`, categorias UGC/IA/GR e rótulos de pessoa/peça depois do bloco de marca. Reedições e códigos `AD-` permanecem intactos. O parser preserva o nome original; sugestão de correspondência exata nunca é associação automática.

A leitura real também encontrou rótulos UGC em **conjuntos**, com nomes curtos nos anúncios. A interface identifica a origem do rótulo e sinaliza o formato legado. O vínculo confirmado usa marca + conta + anúncio; não depende de o nome continuar igual.

Grão do fato Meta: conta × anúncio × dia × modelo. A coleta solicita clique de sete dias, data de conversão, moeda BRL e fuso America/Sao_Paulo. Usa somente `offsite_conversion.fb_pixel_purchase`; não soma tipos `purchase`, `omni_purchase` e compra no site. A janela solicitada é declarada, sem inferir equivalência com qualquer configuração não verificada do Ads Manager.

Métrica ausente permanece desconhecida. Quando parte dos dias tem compras/valor informado, a soma dessas parcelas é mostrada como **parcial**. ROAS de mídia só é calculado com valor completo e gasto positivo. Isto não é lucro, incremento causal nem base de pagamento de afiliados.

## Coleta e desempenho

Coletor diário às 06:17 de Brasília, janela dos sete dias completos anteriores. Contas são lidas em sequência; paginação tem limite e intervalo. Credencial fica no cofre. A nova base só substitui a janela de uma conta depois de todas as páginas validadas; erro/paginação incompleta preservam a leitura anterior e marcam a fonte. Execução antiga não sobrescreve uma coleta mais nova. Os fatos históricos fora da janela ficam preservados, sem alegação de atualização contínua de todo o passado.

A API entrega o payload novo apenas quando `pilot: true`; as leituras habituais de Creators permanecem leves. A interface apresenta 25 anúncios por página e carrega a área visível. A cobertura refere-se às contas mapeadas e ao período, não atesta inventário completo da empresa. `Atualizar leitura` relê o banco; não dispara chamadas Meta em massa.

## Limites do piloto

Páginas “Seja um Influenciador” e formulários existentes preservados. Importação automática dessas candidaturas, emissão de link individual rastreável, persistência no carrinho/checkout, reconciliação pedido pago/estorno, portal individual e liquidação são próximos aceites. Não há saldo disponível, saque, reembolso automático de compra própria ou envio de mensagens neste piloto. Mínimo/máximo de saque ainda não definidos. Pagamento Appmax/Shopify existente não foi substituído.

## Verificação

`tests/creators-meta.test.cjs`: exemplos fornecidos, rótulos legados, grão, ausência versus zero e não adição das lentes. `creators-meta-collector.test.cjs`: paginação, erros, moeda/conta e limites. `creators-pilot-postgres.cjs`: permissões, versões, replay, vínculo por marca, recibos, snapshots atômicos e coleta fora de ordem. `creators-pilot-ui.test.cjs`: ação explícita, ausência de credencial persistida, bloqueio incerto e conciliação sem reenvio. Testes e snapshots são privados/sintéticos; catálogo, tokens e relatórios reais não devem entrar no Git público.

Fontes oficiais: [Meta Marketing API — Insights](https://developers.facebook.com/docs/marketing-api/insights/), [SDK Meta — AdsInsights](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/adsinsights.py), [n8n — paginação HTTP](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.httprequest/#pagination).
