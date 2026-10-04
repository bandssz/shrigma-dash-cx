# Compensação manual do estágio READ inativo

Fonte inerte por padrão. `manual-disable.cjs`, `observer.cjs` e `fence.cjs`
preparam planos, observação HTTPS fechada e intenções duráveis. Importar as
fontes ou executar a CLI padrão não consulta o Easypanel nem o PostgreSQL.

O plano conserva a intenção de credencial do estágio, monta suas nove fontes
originais somente para leitura e usa um diário exclusivo da compensação.
O inicializador atua uma vez apenas no diário novo; a criação Compose pode
iniciá-lo automaticamente, portanto não existe um segundo deploy do
inicializador. Na recuperação de resultado incerto, a intenção e o diário
da compensação são preservados, sem inicializador ou nova execução SQL.

As nove fontes em `runtime/` são cópias byte-exatas do runtime já validado.
O algoritmo SQL, a imagem por digest e o executor Stage permanecem intactos.
Parar o serviço e limpar o ambiente não comprovam a reversão no banco.
O sucesso exige a prova fechada de `disable` após a saída do processo.

A execução operacional depende do escopo concreto aprovado, estágio
original confirmado inativo, ausência de usuários/chaves/sessões e
verificações atuais dos volumes, recursos e destinos. A senha administrativa
só entra no DTO privado em memória e no conector nativo; não deve ser
serializada em arquivos, logs ou respostas. Resultado incerto exige
observação e reconciliação da mesma intenção, sem repetição automática.

## Verificação isolada

```sh
node --require ./tools/crm-manager-read-credential-custody/manual-disable/unit-guard.cjs \
  --test tools/crm-manager-read-credential-custody/manual-disable/manual-disable.test.cjs
CI=true MANUAL_DISABLE_OCI_PROOF=1 \
  bash tools/crm-manager-read-credential-custody/manual-disable/run-oci-preflight.sh
```

O ensaio OCI requer Linux, Node 22, Docker local e a imagem imutável já
disponível. Cria somente volumes e contêineres sintéticos com identificação
própria, testa inicializador, montagens e observador, e recusa o loader privado
sem senha/opt-in antes de acessar o banco. Não usa MCP, SQL, credenciais reais,
IDs reservados ou serviços existentes. Sem os dois opt-ins, fica OFF.
O materializador e o escopo operacional reservado ficam fora do Git.
