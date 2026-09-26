# Editor local candidato — OFF

`growth-journey-graph-editor.js` e seu CSS não estão no manifest nem montados no painel. O módulo permite construir etapas, escolher conexões, configurar condições E/OU e simular sem JSON, terminal, rede ou persistência. Não publica, não ativa e não envia. Esta peça ainda não entrega o construtor operacional completo.

## Injeção pelo host

Carregar primeiro `JourneyGraphContract`, depois `JourneyGraphEditor`. Chamar:

```js
const editor = JourneyGraphEditor.mount({
  root, brand, catalog, definition, server,
  labels, readOnly: false, simulationNow
});
```

- `brand`: `fish` ou `aristo`, fixa durante a montagem. `catalog`: catálogo do servidor no contrato existente; não há controle para alterá-lo. Sem catálogo compatível, edição, simulação e revisão ficam bloqueadas com orientação visível.
- `definition`: documento estruturalmente válido do grafo, opcional para começar uma nova jornada local. Forma incompatível é recusada antes de renderizar; caminhos incompletos podem ser reparados. Sem catálogo, mostra somente etapas indisponíveis e não tenta interpretar seus controles. Etapas usam IDs locais; nenhum ID de jornada, revisão ou flag operacional entra no documento.
- `server`: opcional, exatamente `{journey_id,brand,version,revision,published_revision,paused}`, recebido do serviço autenticado. O editor copia e conserva esses valores. Nunca fabrica ID do servidor nem incrementa versões.
- `labels`: mapa opcional de nomes legíveis fornecido pelo host. Textos são escapados; não aceitam HTML.
- `readOnly`: impede alteração da definição, conservando consulta e simulação fictícia. `simulationNow`: instante UTC com milissegundos; omitido, o início é a hora da montagem. O operador pode mudar apenas o relógio fictício da simulação.

## Contrato local

`getDefinition()` e `getServerIdentity()` retornam cópias separadas. `validate()` reutiliza o contrato puro e restringe mensagens ao e-mail. `prepareReview()` devolve erros ou `{ok:true,contract,definition,server,authorizes_publish:false,authorizes_send:false}`. Não é payload de uma API nem autorização: a integração futura autentica o ator, confere catálogo/versão novamente e cria a identidade durável da operação no servidor. A revisão anterior some ao editar qualquer campo do grafo.

`contextStatus()` informa marca, alterações locais, confirmação aberta, modo de leitura e `publicationAvailable:false`. O host precisa usar esse estado para preservar o rascunho e confirmar saída/troca de marca antes de `destroy()` ou remontagem; não há salvamento automático nem armazenamento local neste módulo. `getSimulation()` retorna a simulação pura; não há callbacks de envio/publicação.

Há entrada única, até 32 blocos e condições limitadas pelo contrato. Conexões Sim/Não são explícitas. Remoção usa confirmação HTML e apaga somente as conexões da etapa removida, exigindo reparar caminhos. Os campos disponíveis e modelos são filtrados pelo gatilho, marca e disponibilidade; não há SQL, código ou ajuste para desativar opt-out. Valores fictícios ausentes continuam desconhecidos. A simulação usa observação no início: uma espera pode tornar o dado antigo, sem fabricar atualização de fonte. Aceites de mensagem no simulador são explicitamente hipotéticos.

Teste focal: `node --test tests/journey-graph-editor.test.cjs` com a dependência `linkedom` já existente na CI. Cobre construção por controles em ambas as marcas, grupos/tipos, espera, caminhos inválidos, edição sem reconstruir inputs de texto, confirmação, versões, catálogo ausente, isolamento, limites e equivalência exata da simulação com o core. Não comprova aceite visual do navegador nem integração de publicação, fonte real ou transporte.
