# Entrega essencial da equipe — 05/10/2026

Objetivo: Felipe administrar os acessos pelo painel e cada analista operar o setor e a marca autorizados. A equipe não está limitada a duas pessoas. O acesso mestre é `felipebandeira@oaristocrata.com`; sua identidade e senha atuais devem ser preservadas.

## Estado verificável

A candidata reúne as frentes CRM do Claude, o azul escuro da Fishermans, a limpeza administrativa após expiração e a autorização própria do mestre. O editor do mestre agora usa sua sessão e permissões efetivas, com recuperação separada por marca. Uma recusa de credencial do serviço mantém a sessão local; o Inventário de leitura explica as ações disponíveis. Os ajustes novos passaram em 53 casos de UI/cliente/Inventário e seis casos da distinção de sessão, com revisão independente. A revisão anterior 301ff13 passou nos 16 workflows, com 52 verificações aprovadas e três ignoradas. A revisão final terá suas próprias verificações; nenhum desses testes comprova instalação no portal.

A correção da biblioteca de mídia já foi instalada no backend CRM e o serviço está saudável. O portal gerencial continua na revisão anterior f58. Cadastro corporativo, novas permissões, ajustes visuais e demais correções da candidata precisam da instalação e do aceite real para serem considerados disponíveis.

Uma verificação real de leitura, isolada e sem banco, confirmou o conteúdo esperado do pacote de origem no instante da coleta. O auxiliar foi parado; identidade, chave, volume do portal e todos os encaminhamentos existentes foram preservados. Essa prova não confirma a migração, a custódia da chave ou uma sessão autenticada.

O formulário administrativo da candidata permite escolher email corporativo, setor (CRM, Orgânico ou Influs/Afiliados), marca (O Aristocrata ou Fishermans) e nível solicitado. A pessoa define sua senha por convite individual de uso único. Solicitar edição não concede automaticamente a autorização efetiva de escrita no backend.

Os registros de domínio informados são `gerencial.shrigma.com.br`, `crm.shrigma.com.br`, `organico.shrigma.com.br` e `influs.shrigma.com.br`. O inventário nativo do Easypanel ainda não mostrou encaminhamentos desses quatro nomes ao portal. Existe certificado listado para CRM; certificado e DNS não comprovam o encaminhamento. O portal atual responde pelo alias gerencial V24.

## Sequência da entrega

1. **Concluir o pente-fino e publicar o código no Git.** Conferir login, sessão expirada, convite, revogação, troca de marca, listas, templates, mídia e recuperação de tentativa incerta. Aplicar o azul escuro da Fishermans, preservar o verde do Aristocrata e verificar contraste, foco e os bundles das três áreas. Reusar os testes pertinentes; registrar achados reais e correções.
2. **Preparar a instalação preservando identidade.** A origem do pacote foi admitida para o instante da coleta; revalidá-la no clone. Preservar a chave original e a cópia consistente da identidade, e gerar uma imagem correspondente ao código final. A imagem anterior da candidata não contém todas as correções posteriores. Não reinstalar tentativas consumidas nem abrir uma nova tentativa para contornar resultado desconhecido.
3. **Instalar primeiro em uma instância isolada.** Usar volume próprio e migração revisada, provar a preservação da conta mestre e das credenciais cifradas e conferir saúde e comportamento. A reversão conserva o portal e volume originais; não executar a versão antiga sobre o banco com novas permissões.
4. **Liberar os acessos efetivamente suportados.** Validar a sessão legítima do mestre. Conferir disponibilidade individual de leitura/escrita e os contratos por marca. Em produção, o editor gerenciado ainda depende de comprovação de propriedade dos templates e das autorizações reais. Orgânico e Influs exigem aceite das suas fontes por marca. O painel deve explicar indisponibilidade, sem prometer edição por existir um seletor.
5. **Vincular os quatro subdomínios.** Conferir hosts aceitos, certificado, rota e serviço de destino imediatamente antes da troca. Publicar somente a instância aprovada; manter o acesso anterior disponível para reversão. Não mudar o domínio principal, email, CX ou fluxos já em operação.
6. **Aceitar o primeiro acesso individual no dia 05/10.** Felipe cria a pessoa no painel com email, setor, marca e nível escolhidos. Confirmar convite, primeiro login, dados da marca correta e recusa de acesso cruzado. Para CRM, verificar criar → salvar → reabrir → conferir público → agendar uma campanha controlada somente quando escopo, público e horário estiverem definidos. Resultado incerto exige consulta da mesma tentativa, sem reenvio.
7. **Entregar o estado final e o prompt da skill.** Informar o que está publicado e funcionando, o que está só no Git e qualquer pendência restante. Entregar o prompt de retrabalho da `email-shrigma` com referências ao código final e aos limites operacionais reais.

## Critérios para dizer “operável”

- O mestre entra com sua identidade preservada e administra várias pessoas.
- Cada convite, sessão e consulta respeita setor, marca e permissão efetiva.
- Revogação e expiração retiram os controles e dados administrativos da tela.
- A leitura das fontes essenciais foi aceita por marca; indisponibilidade é explícita.
- CRM evita duplicação após timeout e exige revisão/público conferidos para agendar.
- Os domínios de uso encaminham à versão validada com HTTPS.
- O relato distingue código testado, imagem publicada, instalação saudável e operação autenticada real.

## Pendências que impedem afirmar 100%

A instalação corporativa preservando identidade/chave, o aceite autenticado do mestre, as permissões reais por pessoa e marca e o encaminhamento dos quatro domínios ainda exigem prova operacional. Os testes de código não substituem essas provas.

Se a publicação no Easypanel não puder ser concluída com esses critérios, o código e o plano ficam no Git, como autorizado por Felipe. Esse fallback preserva o trabalho, mas não torna os novos acessos disponíveis no portal anterior. Não marcar a operação da equipe como pronta enquanto esses requisitos permanecerem abertos.
