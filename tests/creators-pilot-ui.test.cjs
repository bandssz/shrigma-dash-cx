const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{parseHTML}=require('linkedom'),crypto=require('node:crypto').webcrypto;
function setup({mode='ok',storage=new Map(),pilot={},revoke=true}={}){
 const {document,window}=parseHTML('<html><body><div id="area-partners"></div><div id="area-meta-creators"></div></body></html>');
 let data={influs:[],pilot:{schema:'creator_pilot_v1',programs:[{marca:'fish',rate:0.07,payment_day:5,link_base:'https://fishermans.com.br/'}],candidates:[],sources:[],ads:[],coupon_by_creator:[],links:[],partner_orders:[],commission_payable:false,...pilot}},k='synthetic-area-key',posts=[],locks=false;
 const context=vm.createContext({window,document,crypto,TextEncoder,navigator:{locks:{request:async(_name,_opts,cb)=>{if(locks)return cb(null);locks=true;try{return await cb({});}finally{locks=false;}}}},localStorage:{getItem:x=>storage.get(x)||null,setItem:(x,v)=>storage.set(x,v)},fetch:async(_url,opts)=>{const b=JSON.parse(opts.body);posts.push(b);if(mode==='uncertain'&&b.acao==='piloto_salvar')throw Error('offline');const j=b.acao==='piloto_operacao'?{ok:true,state:'confirmed',receipt:{ok:true,request_id:b.request_id,version:1}}:{ok:true,request_id:b.request_id,version:1};return {ok:true,status:200,json:async()=>j};}});
 vm.runInContext(fs.readFileSync(require.resolve('../creators-meta.js'),'utf8')+'\n'+fs.readFileSync(require.resolve('../creators-pilot-ui.js'),'utf8'),context);
 const api=window.CreatorsPilotUI.bind({document,getData:()=>data,getMarca:()=> 'fish',getPeriod:()=>({fim:'2026-09-20'}),key:()=>k,endpoint:()=> 'https://synthetic.invalid',reload:async()=>{},confirmRevoke:()=>revoke});api.render();
 return {api,document,storage,posts,drop:()=>{data=null;api.render();},changeKey:()=>k='other-key'};
}
const command={id:'10000000-0000-4000-8000-000000000001',marca:'fish',name:'Synthetic',source:'manual',state:'novo'};
test('pilot entry renders confirmed rules without auto writes and stores no credential or candidate data',async()=>{
 const x=setup();assert.equal(x.posts.length,0);assert.match(x.document.body.textContent,/7%/);assert.match(x.document.body.textContent,/Não liberado/);await x.api.save('candidato',command,0);assert.equal(x.posts.length,1);const text=[...x.storage.values()].join('');assert(!text.includes('synthetic-area-key'));assert(!text.includes('Synthetic'));assert.equal(JSON.parse([...x.storage.values()][0]).phase,'confirmed');
});
test('uncertain response blocks repeated edits and another actor cannot reconcile its receipt',async()=>{
 const x=setup({mode:'uncertain'});await x.api.save('candidato',command,0);await x.api.save('candidato',command,0);assert.equal(x.posts.length,1);assert(x.document.querySelector('[data-pilot-save]').disabled);x.changeKey();await x.api.reconcile();assert.equal(x.posts.length,1);assert.equal(JSON.parse([...x.storage.values()][0]).phase,'uncertain');
});
test('receipt reconciliation reads the original identity without resending the write',async()=>{
 const x=setup({mode:'uncertain'});await x.api.save('candidato',command,0);await x.api.reconcile();assert.deepEqual(x.posts.map(p=>p.acao),['piloto_salvar','piloto_operacao']);assert.equal(x.posts[0].request_id,x.posts[1].request_id);assert.equal(JSON.parse([...x.storage.values()][0]).phase,'confirmed');
});
test('missing current data removes edit controls and blocks direct save during read refresh',async()=>{
 const x=setup();x.drop();assert.equal(x.document.querySelectorAll('[data-pilot-save]').length,0);await x.api.save('candidato',command,0);assert.equal(x.posts.length,0);
});

// --- Link de parceiro (21/09/2026) -------------------------------------------------
// O link só existe porque a persistência até o pedido pago foi medida em pedido real.
// O que a tela NÃO pode fazer: prometer valor a pagar, ou mostrar endereço de link pausado.
const cand=(o={})=>({id:'10000000-0000-4000-8000-00000000000a',marca:'fish',name:'Parceiro sintético',handle:'@p',source:'manual',source_reference:'',state:'aprovado_piloto',note:'',version:1,...o});
const link=(o={})=>({ref:'p-0123abcd',candidate_id:'10000000-0000-4000-8000-00000000000a',marca:'fish',state:'pausado',version:1,candidate_name:'Parceiro sintético',candidate_state:'aprovado_piloto',url:null,updated_at:'2026-09-21T12:00:00Z',...o});

test('parceiro sem aprovação não ganha botão de link', () => {
 const x=setup({pilot:{candidates:[cand({state:'em_analise'})]}});
 assert.equal(x.document.querySelector('[data-link-new]'),null);
 assert.match(x.document.body.textContent,/Só parceiro aprovado recebe link/);
});

test('parceiro aprovado ganha o botão, e gerar link pede estado pausado na versão zero', async () => {
 const x=setup({pilot:{candidates:[cand()]}});
 const botao=x.document.querySelector('[data-link-new]');
 assert.ok(botao,'aprovado precisa poder gerar link');
 await botao.onclick();
 assert.equal(x.posts.length,1);
 assert.equal(x.posts[0].kind,'link');
 assert.equal(x.posts[0].expected_version,0);
 assert.deepEqual(x.posts[0].data,{marca:'fish',candidate_id:cand().id,state:'pausado'});
});

test('link pausado mostra o código mas nunca o endereço', () => {
 const x=setup({pilot:{candidates:[cand()],links:[link()]}});
 assert.match(x.document.body.textContent,/p-0123abcd/);
 assert.match(x.document.body.textContent,/Endereço aparece quando o link estiver ativo/);
 assert.equal(x.document.querySelector('.cp-link-url'),null,'link pausado não pode exibir endereço copiável');
 assert.ok(x.document.querySelector('[data-link-state="10000000-0000-4000-8000-00000000000a:ativo"]'));
});

test('link ativo mostra o endereço com as UTMs de parceiro e o botão de copiar', () => {
 const url='https://fishermans.com.br/?utm_source=parceiro&utm_medium=parceiro-site&utm_campaign=fish-parceiros&utm_content=p-0123abcd';
 const x=setup({pilot:{candidates:[cand()],links:[link({state:'ativo',url})]}});
 const campo=x.document.querySelector('.cp-link-url');
 assert.ok(campo);
 assert.equal(campo.getAttribute('value'),url);
 assert.ok(x.document.querySelector('[data-link-copy="p-0123abcd"]'));
 assert.ok(x.document.querySelector('[data-link-state="10000000-0000-4000-8000-00000000000a:pausado"]'),'ativo oferece pausar');
});

test('mudar o estado do link envia a versão vigente, não zero', async () => {
 const x=setup({pilot:{candidates:[cand()],links:[link({version:4})]}});
 await x.document.querySelector('[data-link-state="10000000-0000-4000-8000-00000000000a:ativo"]').onclick();
 assert.equal(x.posts[0].expected_version,4);
 assert.equal(x.posts[0].data.state,'ativo');
});

test('revogar só sai depois da confirmação', async () => {
 const x=setup({pilot:{candidates:[cand()],links:[link()]},revoke:false});
 await x.document.querySelector('[data-link-state="10000000-0000-4000-8000-00000000000a:revogado"]').onclick();
 assert.equal(x.posts.length,0,'recusar a confirmação não pode gravar');
 const y=setup({pilot:{candidates:[cand()],links:[link()]},revoke:true});
 await y.document.querySelector('[data-link-state="10000000-0000-4000-8000-00000000000a:revogado"]').onclick();
 assert.equal(y.posts[0].data.state,'revogado');
});

test('link revogado sai da tela e o parceiro pode receber um novo', () => {
 const x=setup({pilot:{candidates:[cand()],links:[link({state:'revogado'})]}});
 assert.ok(x.document.querySelector('[data-link-new]'),'revogado libera a emissão de um novo link');
 assert.doesNotMatch(x.document.body.textContent,/p-0123abcd/);
});

test('pedidos atribuídos aparecem por link e sem virar valor a pagar', () => {
 const x=setup({pilot:{candidates:[cand()],links:[link({state:'ativo',url:'https://fishermans.com.br/?utm_content=p-0123abcd'})],
  partner_orders:[{ref:'p-0123abcd',marca:'fish',pedidos:3,receita_liquida_com_frete:'450.00'}]}});
 assert.match(x.document.body.textContent,/3 pedidos atribuídos/);
 assert.match(x.document.body.textContent,/Não liberado/,'saldo continua não liberado');
 assert.doesNotMatch(x.document.body.textContent,/a pagar.{0,20}R\$/,'a tela não pode anunciar valor a pagar');
});

test('sem pedido atribuído a tela diz ausência, não zero', () => {
 const x=setup({pilot:{candidates:[cand()],links:[link()]}});
 assert.match(x.document.body.textContent,/Nenhum pedido atribuído ainda/);
});

test('uma gravação pendente trava também os botões de link', () => {
 const storage=new Map([['shrigma_creator_pilot_operation_v1',JSON.stringify({phase:'uncertain',actor:'x',request_id:'r'})]]);
 const x=setup({storage,pilot:{candidates:[cand()],links:[link()]}});
 for(const b of x.document.querySelectorAll('[data-link-new],[data-link-state]')) assert.ok(b.disabled,'nada de novo link enquanto há recibo pendente');
});
