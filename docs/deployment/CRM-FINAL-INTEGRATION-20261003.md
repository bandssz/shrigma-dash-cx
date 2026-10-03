# Integração da entrega CRM — 02/10/2026 BRT

Base de publicação: main `565ab590ecbbaf021a05fdaa31bb570246ad52b3`. Entrega Claude: PR #216, head `e91e44ab49f6bbee79c715860bb549c3d45c5682`. A integração usa worktrees exclusivos; a pasta original, a branch de produção e a branch do Claude foram preservadas.

## Fonte revisada

Os seis commits da entrega foram incorporados à branch `codex/dashboard-candidate-crm-fix-20261002`. O bundle Growth foi recompilado para conservar a configuração do portal. A revisão adicional de mídia está no commit `70f914c3f235f56f14fc15d66144ae8a8e551b4d`, da branch separada `codex/crm-final-integration-20261003`, e foi incorporada à candidata do portal.

Esse ajuste adicional interrompe o scan antes de cada nova página e reconhece UUID válido em maiúsculas no nome do arquivo. Conserva o limite de quatro páginas, a identidade exata da recuperação e o filtro por marca. A origem de produção observada pelo MCP ainda informa `03a02b4c98f471e6739c8a7cbe46e49aa4cbf285`; a comparação dos quinze arquivos da imagem mostra alteração apenas em `services/crm-campaign/media.cjs`. Não houve atualização do serviço ativo.

O portal continua removendo exatamente o módulo legado de mídia e fornecendo sua biblioteca somente de leitura. A assinatura do bloco gerado foi revisada e atualizada para `02e3d5a1d7457aadb99858e36c156b3fdf760651c4ca043b45a314c885972e95`. Um teste novo recusa bytes não revisados. O manifesto privado do gateway registra o snapshot candidato `4517cc3d3060a75e9d11c360479054cb0bd4d459` e o SHA `2f288ef9d38160fe5363c478eb43ea84886a84367deaf991bdc56a32034b8ffc` de `media.cjs`; as três fontes do manifesto foram conferidas nesse mesmo snapshot. Esse registro não comprova que a origem já recebeu a imagem.

## Validação

- Os seis arquivos de testes Claude, as regressões existentes de mídia e os três casos novos passaram em 105 resultados locais, sem falhas ou pulados, com Node22 e integrações sintéticas. As chamadas externas foram bloqueadas; os sockets permitidos foram somente de loopback.
- O build Growth passou em modo `--check`. O pacote fechado do portal foi gerado com 28 arquivos públicos e 12 módulos privados, sem dados, banco ou credenciais.
- A regressão conjunta do portal passou em 315 resultados locais, sem falhas ou pulados, incluindo login por e-mail/senha, convite, CSRF, restrição de área e fluxo automático de identidade CRM em banco descartável. Os testes de volume exigem o diretório temporário do usuário no Mac para conservar seu GID; não houve redução da checagem de proprietário do runtime.
- A CI exclusiva executa explicitamente os seis arquivos Claude e os testes de mídia, além das provas existentes do portal, gateway e SQL. A matriz PostgreSQL16/17 deve estar verde antes de qualquer publisher. O resultado dessa revisão será registrado na PR após conclusão.

Não foram executados salvamento real de template n8n, persistência Listmonk, agendamento/cancelamento de campanha ou upload. Os testes não comprovam paridade comercial completa no portal instalado.

## Imagens e publicação

Há três publishers separados, limitados à branch/repositório candidatos, a push com seu marcador específico e à CI verde. O publisher de campanhas usa um diretório vazio com apenas os quinze arquivos literais necessários à Dockerfile. Constrói antes do login, importa somente servidor/mídia sem iniciar `main.cjs`, verifica UID1000 e os bytes revisados de mídia, publica uma tag inédita no package candidato público existente e confere pull anônimo por digest. O artefato contém somente a referência imutável. Publicação de imagem não instala serviço, SQL, configuração ou domínio.

Antes de iniciar qualquer serviço no Easypanel, repetir a consulta de capacidade. Portal: uma réplica, 0,5 CPU/512 MiB, heap128 MiB, UID1000, raiz somente de leitura e volume próprio. Emissor: uma réplica, 0,25 CPU/128 MiB, desligado até revisão e instalação autorizada da origem. O serviço CRM de campanhas ativo já tem uma réplica e limite de 0,5 CPU/512 MiB; suas configurações, rotas e credenciais permanecem preservadas.

## Ordem de liberação e reversão

1. Conferir jobs do commit final e digests/componentes exatos. O frontend GitHub Pages e o backend de mídia são liberações independentes; as correções visuais funcionam com o backend anterior.
2. A publicação do frontend usa uma PR revisada no GitHub, com fontes, bundle e CSP juntos. Reversão por nova PR que reverta o commit publicado; nenhuma troca/reset da pasta original.
3. Validar primeiro a imagem CRM em isolamento com HTTP e provedores sintéticos. A conferência real da biblioteca deve limitar-se a GET das duas marcas. Não expor uma cópia com POST habilitado às credenciais reais. Atualizar o backend existente somente após o aceite da revisão/digest e preservação da configuração anterior; nenhum agendamento, worker, webhook ou migração faz parte dessa atualização.
4. Instalar novo portal canário por digest e volume próprios, preservando V22 e uma cópia consistente da identidade cifrada. Login mestre não deve ser redefinido. O provisionamento individual permanece desligado até a exceção SQL, autenticação PostgreSQL, credencial privada e permissões serem aprovadas e validadas.
5. Confirmar navegação, leitura real e isolamento com duas contas, manutenção dos acessos de 14 dias, permissões de edição por operação e recuperação da identidade. Depois apresentar o corte dos quatro domínios finais para aprovação explícita.

No canário, reverter para imagem/volume anteriores se login, leitura ou isolamento falhar. Se houver gerações individuais reais na origem, reconciliar/revogar seus lifecycles antes de desativar o emissor; conservar contas e credenciais legadas. A hospedagem atual e os envios programados continuam preservados.

## Limitações conhecidas

Operações de agendamento/cancelamento com resultado incerto continuam exigindo reconciliação da mesma tentativa. A revisão não descarta o diário nem repete envios automaticamente. A validade fixa de 14 dias requer política de renovação; o comando de reservar renovação ainda não está na UI. Edição de gestores, fontes individuais de Orgânico/Influs, custódia externa das chaves de recuperação e o corte final continuam pendentes.

Os novos objetos/roles/grants propostos para o provisionamento não foram aplicados ao PostgreSQL atual. A consulta fechada de metadados confirmou compatibilidade estrutural e identificou uma concessão default adicional e regras HBA que precisam de classificação antes da instalação. Nenhuma credencial ou conteúdo de cliente foi retornado nessa consulta.
