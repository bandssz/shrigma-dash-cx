# Teste da peça e o que ele prova

## Três provas diferentes

| Prova | Onde | O que mostra |
|---|---|---|
| Pré-voo | `scripts/checklist.py --modelo` | Regras locais: links, UTMs, descadastro, alt, pixel, conteúdo ativo. Não prova renderização nem entrega. |
| Prévia | Modelos, no CRM | Como a peça aparece dentro do sistema. Bloqueia recursos externos. |
| Teste interno | Campanha, no CRM | Mensagem real no endereço interno autorizado informado; assunto "[TESTE] ". |

A skill pode acionar `crm_campaign_test` com pedido específico, conta QA liberada e destinatário interno autorizado. Faça uma chamada; o Listmonk executa. O analista também pode testar pela tela do CRM. Aceite da API não comprova recebimento físico.

## Regras

- Destinatário de teste é sempre interno; nunca um cliente real.
- No relato, diga exatamente qual versão foi vista e se houve mensagem real. Se não houve teste real, diga isso.
- Não repita um teste para obter um resultado mais bonito. Teste com resultado incerto: consultar a mesma tentativa.
- Confira no celular e no modo escuro a mensagem recebida, não só a prévia.

## Teste contamina métrica

Abertura e clique do teste de campanha podem entrar nos números da campanha real, porque o time clica para conferir. Ao ler o resultado de uma campanha que teve teste, declare o horário do teste e a possível contaminação, em vez de presumir que o número está limpo.
