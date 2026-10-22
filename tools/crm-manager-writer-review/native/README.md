Esta pasta prepara uma prova nativa PostgreSQL17 em CI Linux descartável. Nada foi executado no Mac, Easypanel, n8n ou banco real. Copiar o pacote inteiro, sem segredos, para `tools/crm-manager-writer-review/`; root integra o job proposto após revisão. O harness usa os3arquivos WRITER exatos no diretório pai, policy fixa e quatro fontes READ públicas já pinadas, sem alterar nenhuma delas.

Comandos após inclusão na candidata:

```sh
npm ci --prefix services/crm-manager-provisioner --ignore-scripts --no-audit --no-fund
CRM_MANAGER_WRITER_NATIVE_PROOF=1 NODE_PATH="$PWD/services/crm-manager-provisioner/node_modules" bash tools/crm-manager-writer-review/native/run-native-writer-proof.sh
```

O runner cria somente um container novo, tmpfs/data,512MiB+swap512MiB,CPU1,128PIDs,porta publicada apenas127.0.0.1:5440 e remove seu próprioID no trap. Docker é fixado ao socket Unix local do runner. Usa postgres:17.10,pg8.13.1,Node22 e senha sintética literal exclusiva da fixture. A imagem é tag conhecida, ainda sem digest neste plano. Nenhum servidor existente é selecionado; nenhuma variável PG* escolhe destino. SQL/log de servidor nunca são impressos.

Antes de qualquer DDL, a conexão verifica host/port/db/user/password/application_name/options no cliente e current_database/current_user/session_user/major17/serverport/cluster_name reais no banco. Recusa banco com qualquer relação pública, função ou papel conhecido de fixture. HBA nativo tem4regras, trust local/loopback e SCRAM para o restante; isso é configuração sintética de teste, não uma conclusão sobre autenticação da produção. NOLOGIN é provado via psql em loopback TRUST dentro do container, para distinguir a recusa do papel da ausência de senha.

A prova inclui instalação vazia→perfil07eb fixo→reversão exata, autenticaçãoNEGantescommit/POSapóscommit, READ/caps3 preservados, DTO/caps4/escopo fechados, ACLs reais, idempotência/STATUS,2conexões concorrentes com pg_stat_activity Lock observado, CAS e renewalcommit↔revokelife nas2ordens. O componente nunca ativa o novo papel de serviço. Apenas papéis sintéticos da fixture recebem os4RPCs para o teste. Depois, limpa somente as linhas sintéticas WRITER criadas pelo próprio teste, retira essas concessões sintéticas, retorna ao perfilEMPTY e prova4recusas da reversão. Essa limpeza não é uma estratégia de reversão de consumidores em produção.

O fingerprint esperado07eb é literal; divergência nativa é reportada apenas como fase/hashes e bloqueia, sem aprender/adotar outro hash. O SQL é um componente inativo; nem um CI verde autoriza instalar no banco atual. Ainda faltam admissão final pinada listmonk/postgres/17, metadados/autenticação/HBA/logging reais recentes, autorização explícita, credencial privada segura, issuer e integração de runtime/UI. Este pacote não modifica READ, pipelines vigentes, envs, domínios ou serviços.
