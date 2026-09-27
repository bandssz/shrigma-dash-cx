# Entrega privada do primeiro e-mail CART — candidata

Escopo: primeiro e-mail de carrinho (30 minutos) de Fish e Aristo. Não libera outros passos, WhatsApp, campanhas, CX ou uma régua inteira. `ENABLED=false`; nenhuma capacidade pública de ativação é anunciada.

`createDelivery` recebe dependências confiáveis do servidor: claim, leitura do dispatch, finish original, aplicação do recibo e transporte para a instância Listmonk fixa. O pedido contém apenas marca, intenção e versão esperada. Não aceita URL, conteúdo, destinatário, template ou resultado HTTP do operador.

Sequência: preparar e reservar atomicamente → conferir grant e prazo → um POST sem retry → finish original → consultar estado durável → aplicar recibo ao participante. O transporte tem timeout máximo de 40 segundos, abort local, redirects recusados e resposta limitada. O adaptador HTTP também deve impor esses limites durante a leitura. Resposta 2xx com `data=true` significa aceitação pelo Listmonk; não prova entrega SES. Recusa 400/401/403/404/422 é terminal; demais resultados, perda da resposta e timeout ficam incertos.

Somente o vencedor da reserva recebe token e payload. Grant expirado depois do COMMIT não envia nem inventa resultado: permanece reservado para conciliação. COMMIT incerto não inicia HTTP. Finish incerto é resolvido pela leitura do dispatch, nunca por repetir o POST. `reconcile` só consulta e aplica recibo; não reserva nem transporta. O retorno externo contém IDs e estados, sem e-mail, HTML, dados do contato ou token.

O adaptador de recibo deve persistir a operação/ator/payload antes da chamada e reutilizá-los se a resposta se perder. Uma mudança comprovada de estado do dispatch usa outra operação e a versão atual do participante. Não gerar uma operação nova para repetir um resultado incerto. O ledger e a transição são atômicos: aceito avança uma vez; rejeitado falha; incerto permanece fechado; em andamento aguarda. Recibos podem ser registrados durante pausa, sem autorizar o próximo envio.

## Provas e limites

Testes locais usam o SQL real e transporte sintético nas duas marcas: fonte → clone → reserva original → finish → recibo, duplo clique, CAS antigo, COMMIT perdido, resposta HTTP perdida e finish perdido antes/depois de persistir. A CI PostgreSQL usa conexões independentes para concorrência, opt-out, manutenção, prazo e ledger. Nenhum teste envia e-mail ou usa clientes reais.

Ainda não instalado em produção. A implantação depende da retenção CART, migrações de ownership/recibo/coexistência, worker compatível, adaptadores privados, release/cache nativo conferidos e controle pelo painel. O n8n 2.0.2 observado não anuncia `pg` nos módulos externos do Code node; este módulo Node não deve ser colado ali ou ativado por suposição. Não requer nem autoriza reinício nesta entrega.

Reversão antes de instalar: reverter o código. Após uma futura ativação: interromper novas admissões e workers, preservar ownership/claims/recibos e conciliar tentativas em curso. Não devolver coorte ao legado, apagar dispatch, fechar como falha um resultado desconhecido ou reconstruir identidade para tentar de novo.
