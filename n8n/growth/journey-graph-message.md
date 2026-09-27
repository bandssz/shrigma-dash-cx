# Preparação privada da mensagem do grafo — candidata

`createMessagePreflight` liga uma intenção persistida à revisão publicada, fonte revalidada e clone nativo imutável. Só aceita marca e ID da intenção; HTML, destinatário, release e template nunca vêm do operador. Não reserva dispatch, altera participante, chama HTTP ou concede permissão de envio.

Dependências de servidor: pool PostgreSQL; `readSource` com orçamento e abort definidos pelo adaptador Shopify; `resolveNative({brand,release_id,material_sha256,query})` ligado ao `native_resolve_v1` na mesma transação; `cacheTarget` da instância comprovada. Não usar uma resposta de catálogo/client como confirmação nativa. O relógio vem do PostgreSQL.

A ordem de locks acompanha o runtime: controle, jornada, participante e inscrito. O inscrito fica protegido durante a revalidação. A revisão/hash, estado `waiting_message`, tentativa, nó, release e recibo nativo precisam corresponder. Depois dos callbacks, a fonte nativa é lida novamente para detectar opt-out, supressão ou compra; prazo de cinco segundos é conferido no relógio final. A guarda de mensagem é repetida pelo mesmo contrato puro do construtor, mesmo que a condição seja omitida do desenho. O material é ligado aos campos tipados e UTMs da marca.

O retorno privado contém os dados indispensáveis ao futuro claim e `authorizes_send:false`, `transport:false`. Seu `expires_at` não é licença de envio. Não armazenar/logar nem reutilizar depois: a reserva final deve executar novamente as guardas, manter a identidade legada e conferir a revisão nativa antes do transporte. A transação somente leitura termina em rollback; resultado não é um recibo durável. Falha no rollback descarta a conexão.

A integração de transporte ainda precisa do hook de ownership/release no claim original e do vínculo atômico intent→dispatch. O claim atual escolhe o template do slot vigente; passar o ID do clone por fora não basta. Não ligar este preflight diretamente a `/api/tx` nem usar seu payload para contornar esse hook.

Provas: ambas as marcas em integração SQL (fonte→release→intenção→clone→preflight), isolamento, pausa, fonte alterada, observação vencida, compra/opt-out, identidade de cache, clone imutável e original editável, falha de rollback. CI PostgreSQL real verifica retirada de consentimento em conexão independente durante a resolução do clone. Transporte só sintético nos testes de criação de template; zero envio de e-mail.

Implantação atual: nenhuma. Arquivos são candidatos; catálogo público permanece de rascunhos. Instalar futuramente somente com export/guarda de versões e ensaio do claim completo. Rollback desta entrega é reversão de código, sem estado novo de produção. Clones/recibos criados em ensaios devem ser preservados; nunca apagar para repetir uma operação incerta.
