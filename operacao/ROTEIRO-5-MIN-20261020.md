# Roteiro de cinco minutos — recuperação E9 · 20/10
E9 recuperada, mesma imagem anterior, sem abertura de função nova aos editores.

1. **0:00–1:00 — Saúde comprovada.** [Recuperação](runtime/fish-bugs20/e9-recovery.safe.json): contêiner E9 saudável e8/8 DockerLinux serial, final12h54m24. [Prova após bootstrap](runtime/fish-bugs20/github-bootstrap-deploy.safe.json): CI verde e8/8 novamente após o delta do Secret, final13h08m53. Não repetir sem mudança.
2. **1:00–2:00 — O que foi removido.** O SQLite reconciliou468 frames e retirou WAL/SHM ao fechar. Backup cifrado no volume original; integridade/FKs, contagens, chaves e identidade preservadas. Comando/healthcheck e configuração originais restaurados.
3. **2:00–3:00 — Token GitHub.** Novo PAT salvo oculto/0600; GitHub confirmou expiração20/10/2027 00h BRT e escrita do Secret do bootstrap. CI39454642257 usou token efêmero do job e a URL atualizada para deploy da E9. Ação nativa terminou; contêiner continuou saudável, sem recriação nem deploy pendente.
4. **3:00–4:00 — Vencimentos.** [Lista em cinco linhas](CREDENCIAIS-VENCIMENTOS.md): grantTEST24/10, atestado03/11, PAT20/10/2027, tokensOAuth temporários e validade n8n desconhecida. Não confundir validade de autorização com a da chave.
5. **4:00–5:00 — Limite desta entrega.** Candidata209c87ae permanece em branch; regra Contato e personalização nova não foram instaladas. Percurso com editor Fish e decisão de abertura continuam pendentes. TEST284 do conector já recebido porWillians; próximos testes com ele. Nenhum envio comercial.
