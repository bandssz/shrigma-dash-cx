# Issues do CRM

- **Data:** 19/10/2026,23h27 BRT.
- **Tela:** Todas as frentes → inicialização do gateway após instalação/retorno.
- **Relato:** CI39356322567 passou1558testes e QA nas duas marcas, mas instalação e retorno ficaram sem contêiner/HTTP502.
- **Causa:** Atestado local da escrita expirou19/10 22h40m11 BRT; verificador original recusa com CONTINUITY_WRITER_REFUSED. Proprietário/credencial/vínculos conferidos; nenhum WAL/SHM/journal; Compose/env originais preservados.
- **Correção + hash:** Felipe aprovou14dias e exceção após05h30 somente para recuperar855. Operação991b90e7 executada uma vez: COMMIT e continuidade original confirmados,3campos alterados, mesma chave/principal/grants/demais registros, backup cifrado durável SHA7eadaf4a; vence03/11 05h40 BRT. Compose/env originais restaurados, gateway855748c1/envelope2c86f215 saudável;8/8 autenticado DockerLinux serial às05h43m56, nenhuma escrita de negócio/objeto QA. Retorno b65d9c88 pronto, mas repõe validade vencida. Evidência runtime/freeze-scale20/recovery855-final.safe.json.

- **Data:** 19/10/2026.
- **Tela:** Campanhas → Nova campanha / editar rascunho → 2. O quê.
- **Relato:** Avisos de campanha nos links e cupom sem destino impediam salvar a peça “Email Captação 01 - Black 30/10”.
- **Causa:** Conferência estrita no CRM e no serviço tratava avisos de links como erro editorial.
- **Correção + hash:** Rascunho aceita os avisos; ajuste de links explícito e destino de cupom exigido ao agendar. Instalado `5e8fbe50e08b88cc5f413732cd6f46a1c60eba65`; serviço `a1e0f8c327135f6497206d1d89f8a83adc98cedb`. Provas e retorno originais em [histórico](historico/ISSUES-20261019-antes-agenda-real.md).

- **Data:** 19/10/2026.
- **Tela:** Campanhas → 4. Quando / agenda nativa.
- **Relato:** Base inteira não cabe no teto de 10 mil; amanhã 10h fica fora da janela de 2h.
- **Causa:** Janela no gateway/UI; limite de membros/páginas, uma consulta por pessoa e transporte/armazenamento de 2MiB no consentimento.
- **Correção + hash:** Gateway `855748c1b270820c5f4ed368bb47abb5a0c92a94` e fonte `0647df71` instalados: 20min–7dias, sem teto10mil, estimativa60mil/h, restritos QA/gerencial. Prévia aprovada; CI39337656056 verde1554/0 com imagem real; saúde nativa e HTTP8/8. QA263/264 (1destinatário) agendadas amanhã10h, canceladas/reagendadas/canceladas: ambas Draft/null/sent0. Aceite ≥100mil NÃO concluído: público Aristo195617 confirmado, congelamento202/GET404, nenhuma campanha grande criada/agendada. Retorno compatível `0701899c`, pedido `739d00e9`, imagem pronta; bloqueio detalhado abaixo.

- **Data:** 19/10/2026.
- **Tela:** Modelos → Campanhas.
- **Relato:** Auditoria solicitada para permitir a peça e avisar por linha, bloqueando só script, redirect e destino fora da loja.
- **Causa:** Além desses bloqueios, seletor/importador recusam tags interativas, fontes, documentos fora de regex e expressões; prévia no navegador precede validação no gateway, repetida no writer.
- **Correção + hash:** Candidata c3448ea6073e761ca3f66032613bbef2c7b8c49c em codex/crm-policy-links-20261020, NÃO instalada. Política única no gateway: só script/redirect/fora da loja bloqueiam; demais avisos por linha. Expressões nativas preservadas e TrackLink literal inspecionado sem execução; writer mantém controles técnicos/legado. Focais104/0, retorno9/0 e pré-publicação41/0 por candidata, DockerLinux em série. CI39368706361 verde1690/0 com duas imagens reais; retorno aeb50ad7/CI39368708129 verde1567/0, envelopebc4eef10 pronto. Oito prévias inspecionadas; Prévias aprovadas por Felipe; instalação/percurso pendentes de nova janela e aceite principal. Antecessoras verdes preservadas.

- **Data:** 19/10/2026.
- **Tela:** Campanhas → Ajustar links / identificação da campanha.
- **Relato:** Uma fonte única de campanha nos links para o botão e o futuro P02.
- **Causa:** Campo atual deriva do nome do rascunho; a identificação nativa real chega depois da criação.
- **Correção + hash:** Candidata c3448ea6, NÃO instalada: campaignValue(id)→lm-ID nativo exato é a fonte única de Ajustar links e do futuro P02. Botão só após CREATE; alteração explícita do campo/links, preservando utm_term e expressões dinâmicas, ajustando TrackLink literal sem reescrita automática de antigas. Proposta registrada antes da instalação, restrita QA/gerencial. CI39368706361 verde1690/0; retorno aeb50ad7 pronto. Prévias aprovadas por Felipe; Produto instala após aceite principal e nova janela, preservando o limite05h30.

- **Data:** 19/10/2026.
- **Tela:** Gestão → Acessos de André e Willians.
- **Relato:** Conferir marcas e papéis reais das duas contas.
- **Causa:** A sessão QA legítima é manager e recebe403 em `/auth/simple/users`; o MCP retorna seis perfis sem nome/e-mail e não identifica André/Willians.
- **Correção + hash:** Nenhuma conta alterada; conferência não concluída na base `5e8fbe50`. Felipe destrava pela lista no gerencial ou por sessão administrativa legítima; evidência saneada em `runtime/agenda-real19/reads/accounts.safe.json`.

- **Data:** 19/10/2026.
- **Tela:** CRM → observação de tempo da origem.
- **Relato:** Instalar telemetria6407322 restrita, sem mudar comportamento.
- **Causa:** O gateway não preservava o grupo de tempos e bytes retornado pela origem de leitura.
- **Correção + hash:** Origem `640732231cf06e1ce3c8da82a7fabd0edce6a0ed` e captura `855748c1` instaladas, restritas QA/gerencial. Consultas/corpos/ambiente preservados; 9/0 Linux e headers reais confirmados nas duas marcas. Série Início3por marca: medianas Aristo1569ms/Fish1229ms; consulta da origem446/448ms;7308016bytes eram do FULL separado. A composição do corpo na abertura ainda não foi medida. Sem série anterior comparável. Retorno da origem por ref `codex/crm-home-reader-20261016`.

- **Data:** 19/10/2026.
- **Tela:** Campanhas → confirmar público Aristo de195617 destinatários.
- **Relato:** Congelamento retornou202 `NATIVE_FREEZE_UNCONFIRMED`; consulta GET da mesma intenção retornou404 `NATIVE_FREEZE_NOT_OBSERVED`.
- **Causa:** Caminho anterior não suporta a escala: enumera membros, consulta por inscrito e transporta/guarda o público no consentimento, limitado a2MiB. O202/GET404 antigo não confirma commit; a leitura pontual da Infra não encontrou evidência causal. Felipe determinou resolver no servidor, sem esperar diagnóstico externo.
- **Correção + hash:** Fontes `5e550aff833ac7c1e0ab95ba1546659eb9f9abf3` e duas funções existentes instaladas: congelamento síncrono por INSERT…SELECT e consentimento compacto; CI39354914816 verde55/0 com imagens reais. Público QA `ec582f4b-4c95-48ce-9402-442c64f70cdd` e nonce `96a78546-72fd-4380-87d5-a278df0b5115` preservados. Produto conclui a mesma intenção pela ação explícita de reconciliação, sem repetir o POST antigo, após gateway AAC instalado; aceite real≥100mil nas duas marcas ainda pendente. Nenhum envio comercial.

- **Data:** 20/10/2026,01h18 BRT.
- **Tela:** CRM → abertura do Início / corpo de7,3MB.
- **Relato:** Medir a composição do corpo na abertura, sem otimizar.
- **Causa:** Os7308016bytes registrados eram de GET FULL separado após a série Home; o harness guardou só tempos/headers, sem corpo bruto. Esse registro não mede a composição da abertura.
- **Correção + hash:** Instrumentação agregada e coleta serial preparadas em c3448ea6, NÃO instaladas; CI39368706361 verde1690/0 com imagens reais. Mede bytes/contagens por grupo na origem e respostas cache_growth da abertura; FULL separado identificado. Nenhuma consulta/corpo otimizado. Gateway recuperado855 e prévias aprovadas; medição real pendente de nova janela, aceite principal e instalação restrita. Produto executa a coleta. Evidência histórica: .private/provas-agenda-real19/performance.safe.json.
