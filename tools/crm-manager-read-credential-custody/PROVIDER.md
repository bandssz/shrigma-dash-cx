# Provider READ — preparação pública, OFF por padrão

`provider-factory.cjs` fornece `bindScopes`, `admission` e `observeStatus` ao driver existente. Importar ou usar a configuração OFF não abre arquivo, socket, ambiente ou credencial. O componente fica fora do pacote do dashboard e não instala SQL nem concede autorização.

O opt-in aceita somente execute no projeto fixo `crm-manager-stage-20261004`. A configuração contém caminhos, SHA de plano/evidência, binding público e vetores ordenados de SHA. Não contém senha, verifier, env ou PEM. `buildCliSource` materializa a mesma implementação com essa configuração literal e um único export `createProviders`; o arquivo resultante deve ser privado, pinado e passado ao driver pelo SHA exato.

O operador deve instalar previamente no relay as quatro consultas e dez mutações literais derivadas do mesmo plano/bootstrap em RAM. `bindScopes` confere o binding e os vetores exatos; não instala o relay, não aceita primeiro DTO observado como autorização e não comprova que a instalação externa ocorreu. O bootstrap privado continua no canal TTY revisado do driver.

`admission` relê a evidência com SHA, propriedade do operador, modo 0600, um único link, diretório canônico 0700 e NOFOLLOW. Confere plano reconstruído, quatorze pins de módulos, nove fontes, imagem, projeto vazio observado, domínio ausente e margem conservadora de capacidade. O recibo deve ser V2: existência de volumes não observada, ausência global false e namespace novo derivado dos IDs. Recibo V1 ou alegação de ausência global é recusado.

A evidência vale dez segundos desde a coleta mais antiga; coleta futura, alteração posterior, substituição, expiração e reset da validade são recusados. A factory não coleta o MCP, reserva recursos, atualiza recibos nem repete ações. Antes de uma execução autorizada, o operador precisa coletar e publicar a evidência fresca dentro desse prazo. Uma amostra arquivada não serve para execução.

`observeStatus` reutiliza o reader HTTPS do plano, somente os GET/status admitidos e saída validada. Não envia credenciais. Expiração da admissão não impede observar/limpar uma tentativa iniciada. Reconcile continua recusado por esta factory: exige o contrato distinto de fonte, ledger, volumes e quiescência do alvo original, sem regenerar IDs após resultado incerto.

Os onze testes usam fixture explicitamente sintética, sem o plano reservado ou observação MCP real. O guard permite somente o subprocesso Node do CLI fechado e recusa rede/PG. Executar no checkout:

```sh
node --require ./tools/crm-manager-read-credential-custody/unit-guard.cjs --test ./tools/crm-manager-read-credential-custody/provider-factory.test.cjs
```

Isso valida contratos e recusas em isolamento. Não comprova transporte de credencial real, mutação MCP privada, execução PostgreSQL, GET remoto, gestor criado ou funcionamento do portal. LOGIN/issuer, ativação, usuários, edição e corte continuam escopos críticos separados.
