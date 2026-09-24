# Holdout do carrinho WhatsApp — candidato de 24/09/2026

**Preparado, desabilitado e não publicado.** A preferência recebida foi testar com poucos;
este candidato usa probabilidade de 5% para retirar **os dois** toques WhatsApp, 30min e 24h,
mantendo e-mails. Isso estima o efeito do conjunto WhatsApp; não separa o efeito de cada toque.

## Decisão operacional

- Escopo estrito: seletores `Monta SQL elegíveis` de Aristo `APG7xy5uY4YzU6vA` e
  Fish `4YidT1MdzugL4wWB`, e quatro tabelas novas `growth_wa_cart_holdout_*`.
- Nenhum nó de envio, reserva, opt-out, login, cache, entrada WhatsApp, CX, Orgânico ou Influs é editado.
- `whatsapp-cart-holdout.sql` cria o protocolo com `enrollment_enabled=false` e datas nulas.
  Não contém comando de ativação. A função não tem permissão pública de execução;
  o papel da credencial PG deve ser conferido antes de conceder somente o acesso necessário.
- O gerador local exige versão ativa e conteúdo idênticos ao export recém-lido, hash do nó,
  workflow permitido e ocorrência única dos trechos de substituição. Sua saída é somente candidato.

## Alocação e denominador

As guardas atuais rodam primeiro: assinante ativo, abandono ainda válido, telefone válido,
compra, opt-out, silêncio, espera, flags dos toques e deduplicação por carrinho. A alocação
ocorre depois da deduplicação e **antes do limite de 500 envios**. Toda pessoa elegível nos dois
braços entra no registro, inclusive tratamento cujo envio depois falhar ou não couber na fila.

O braço é estável por telefone normalizado/marca, com chave pseudonimizada; telefone não é
copiado para as novas tabelas. A probabilidade é 5%, não uma quota exata por lote pequeno.
Carrinhos repetidos da mesma pessoa/marca ficam no mesmo braço. Uma jornada já registrada
preserva seu braço se o telefone ou assinante do carrinho mudar posteriormente.

Somente carrinhos novos a partir do início do protocolo, elegíveis no toque 30min e sem
qualquer reserva anterior de ambos os toques entram. Carrinho anterior ao início e t24 sem
jornada alocada seguem a operação normal e ficam fora da análise. Não classificar quem já
recebeu 30min como controle de ambos os toques. O gate registra o primeiro instante elegível
de cada toque, sem chamar o motor nem marcar holdout como enviado.

Retries usam as mesmas chaves únicas. A função relê o vencedor após conflitos de inserção.
O sal, início e percentual ficam imutáveis após a primeira alocação. Interromper novas
entradas mantém os toques já alocados retidos até o vencimento normal; não existe disparo
retroativo automático de holdout. Desinstalar o gate cedo pode causar esse disparo e exige
plano de drenagem explícito, superior à maior janela vigente de carrinho.

## Bloqueio antes de ativar: medir compras de todos os alocados

A receita por UTM não responde se WhatsApp adiciona receita. O resultado primário precisa
ser compra paga/receita líquida de **todos** os alocados durante uma janela fixa madura,
com agregação por pessoa/marca, sem restringir a quem recebeu, clicou ou foi atribuído ao CRM.
Repetições de carrinho da mesma pessoa não podem duplicar o mesmo pedido na receita.

Leitura agregada de produção em 24/09:

- `crm_attribution_order_v2` guarda 32.573 pedidos Fish/Aristo e tem `order_id`,
  `created_at`, `net_amount`, status e toques. Não contém identidade de cliente,
  e-mail/telefone ou `subscriber_id`. `customer_order_index` é contagem, não identidade.
- Os logs WhatsApp `transacional` / `pedido-pago` possuem `ref`, e-mail e telefone,
  mas nenhum dos 4.269 registros dos últimos sete dias preenche `subscriber_id`.
- O vínculo pelo `ref` com pagos elegíveis dos últimos sete dias cobre Aristo
  3.674/3.768 e Fish 574/598. Os **118 pedidos restantes não são zero conversão**.
  Logs de envio não demonstram cobertura completa, nem ausência de viés entre braços.
- `ftnB71CoYwZdt2jr` resolve carrinho pelo e-mail e atualiza `last_order_at`;
  não persiste identidade do pedido nem valor. Esse marcador mutável não substitui
  um livro de pedidos para janela madura, múltiplas compras ou reembolsos.

Pré-requisito concreto: nova fonte exclusiva Growth com chave `(brand, order_id)`,
`subscriber_id` ou identidade pseudonimizada compatível com a coorte, `created_at`,
`paid_at`, situação financeira, valor líquido, moeda, atualização da fonte e evidência de
cobertura de todos os pedidos pagos, inclusive sem UTM. Reconciliação diária por marca
deve separar pedidos sem identidade; não os imputar como zero. Definir a janela de resultado
e o fim das novas entradas antes de iniciar. O candidato não inventa poder estatístico ou
conclusão com uma fatia pequena.

## Silêncio: correção separada já publicada

O seletor anterior usava tetos de idade de 11h/34h quando o horário nominal caiu no silêncio.
Isso não equivale à janela 08h–12h descrita no handoff:

- t1: carrinho 21h30, elegível 22h, reabre 08h, mas `idade<11h` vence às 08h30.
- t24: carrinho 23/09 22h, elegível 24/09 22h, reabre 25/09 08h com idade exatamente
  34h; `idade<34h` já é falso. Esse toque nunca é adiado para a manhã.

Reparo publicado separadamente às19h38 BRT: calcular a próxima 08h a partir da elegibilidade nominal
no fuso São Paulo, e usar essa abertura +4h como teto absoluto para os casos de silêncio.
Fora do silêncio, preservar tetos normais 4h/27h e a guarda global de silêncio. O máximo
do t1 passa a 14h30, ainda menor que 24h; os ramos continuam sem colisão. Este holdout foi
regenerado dos exports publicados, preservando o reparo: Aristo versão
`77bff157-7fa6-4e21-9670-81472f759441`; Fish versão
`210be1a1-e50f-4cde-8522-e7f0fad21886`. Continua desabilitado e não publicado.

## Validação realizada

`node --test tests/whatsapp-cart-holdout.test.cjs` com PGlite: 6 testes aprovados.
Inclui protocolo desabilitado, restrição de 5%, 2.000 alocados sintéticos nos dois braços,
persistência t1/t24/retry/novo carrinho, mudança de identidade, reserva preexistente,
parada de entradas, protocolo imutável e todos os 600 elegíveis registrados antes do limite500.

Os dois exports privados pós-correção do silêncio geraram candidatos com JavaScript
compilável e SQL sem interpolação pendente. Não houve SQL de escrita, publicação n8n
ou envio em produção referente ao holdout.
Ainda faltam cobertura de resultado, datas do protocolo, revisão independente e teste
de concorrência real do banco antes de ativação.
