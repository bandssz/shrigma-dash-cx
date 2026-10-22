'use strict';
// All data below is synthetic. These tests never contact a production service.
const test=require('node:test'),assert=require('node:assert/strict');
const R=require((process.env.DASHBOARD_ACCESS_TEST_RUNTIME||require('node:path').resolve(__dirname,'../services/dashboard-operational'))+'/dashboard-individual-read.cjs');
const stamp='2026-10-11T19:00:00-03:00',query={ini:'2026-10-01',fim:'2026-10-11'};
const org=()=>({_escopo:'organico',_cache_gerado_em:stamp,cx_post:[{marca:'fish',post_id:'fixture-1',publicado_em:stamp,formato:'reel',impulsionado:true,alcance:42,salvos:3,compartilh:2},{marca:'aristo',post_id:'fixture-2',publicado_em:stamp,formato:'foto',impulsionado:false,alcance:99}],cx_story:[{marca:'fish',story_id:'fixture-story',publicado_em:stamp,ultima_coleta:stamp,link_clicks:null}],cx_organico_receita:[],cx_conta_dia:[{marca:'fish',dia:'2026-10-11',conta:'fixture-account',seguidores_total:40,seguidores_novos:2,website_clicks:1}]});
const creators=()=>({janela:{...query},gerado_em:stamp,influs:[{marca:'fish',influ:'fixture-creator',nome:'Fixture',ativo:true,comissao_pct:null}],roi:[{marca:'fish',influ:'fixture-creator',receita:10,pedidos:1,custo_lancado:null,comissao:null,patrocinio:null,investimento:null,investimento_total:null,roi:null,roi_total:null}],cupons:[{marca:'fish',influ:'fixture-creator',codigo:'FIXTURE',tipo:'percentual',usos_lifetime:null,desconto_pct:null,influ_comissao_pct:null}],custos:[{marca:'fish',influ:'fixture-creator',competencia:'2026-10',fixo:5,produto:null,frete:null,patrocinio:null}],receita_cupom:[{marca:'fish',codigo:'FIXTURE',receita:10,pedidos:1}],termos:[{marca:'fish',influ:'fixture-creator',modelo:'fixture',comissao_pct:null,vigente_desde:'2026-10-01',autor:'Fixture'}]});
const projectOrg=value=>R.project(value,{area:'organico',brand:'fish'});
const projectCreators=value=>R.project(value,{area:'influs',brand:'fish',query});
test('explicit read allowlist admits only existing data actions',()=>{
 for(const [route,method,action,area]of [['crm-read','GET','cache_growth','growth'],['cx','GET','','organico'],['cache','GET','','organico'],['influ','POST','listar','influs']])assert.equal(R.allowed(route,method,action,area),true);
 for(const [route,method,action,area]of [['crm-read','POST','cache_growth','growth'],['influ','POST','piloto_operacao','influs'],['tts','POST','','influs'],['organico-links','POST','listar','organico'],['campaigns','POST','campanha_agendar','growth']])assert.equal(R.allowed(route,method,action,area),false);
});
test('organic keeps paid marker and exact metrics used by the original screen',()=>{const out=projectOrg(org());assert.equal(out.cx_post.length,1);assert.equal(out.cx_post[0].impulsionado,true);assert.equal(out.cx_post[0].compartilh,2);assert.equal(out.cx_post[0].formato,'reel');assert.equal(out.cx_story[0].ultima_coleta,stamp);assert.equal(out.cx_story[0].link_clicks,null);assert.equal(out.cx_conta_dia[0].seguidores_total,40);});
test('organic accepts original singleton/payload envelopes',()=>{assert.equal(projectOrg([{payload:org()}]).cx_post.length,1);assert.equal(projectOrg({payload:org()}).cx_post.length,1);assert.throws(()=>projectOrg([org(),org()]));});
test('unrelated known brand stays out of the returned organic data',()=>{const value=org();value.cx_story.push({marca:'olivas',story_id:'fixture-other'});assert.equal(projectOrg(value).cx_story.length,1);});
test('missing paid marker refuses instead of classifying paid post as organic',()=>{const value=org();delete value.cx_post[0].impulsionado;assert.throws(()=>projectOrg(value),e=>e.code==='BRAND_READ_CONTRACT_NOT_READY');});
test('invalid paid marker refuses',()=>{const value=org();value.cx_post[0].impulsionado='false';assert.throws(()=>projectOrg(value));});
test('missing row brand refuses instead of guessing ownership',()=>{const value=org();delete value.cx_post[0].marca;assert.throws(()=>projectOrg(value),e=>e.code==='BRAND_RESPONSE_UNSCOPED');});
test('conflicting brand markers refuse',()=>{const value=org();value.cx_post[0].brand='aristo';assert.throws(()=>projectOrg(value));});
test('extra data and credentials are not copied',()=>{const value=org();value.crm_credencial=[{token:'fixture-hidden'}];value.cx_post[0].customer_email='fixture-person@synthetic.invalid';assert.doesNotMatch(JSON.stringify(projectOrg(value)),/fixture-hidden|customer_email/);});
test('returned credential embedded in an admitted caption refuses',()=>{const value=org();value.cx_post[0].legenda='fixture-private-read-key';assert.throws(()=>R.project(value,{area:'organico',brand:'fish',credential:'fixture-private-read-key'}));});
test('duplicate post IDs refuse ambiguous frontend Maps',()=>{const value=org();value.cx_post.push({...value.cx_post[0]});assert.throws(()=>projectOrg(value),e=>e.code==='BRAND_RESPONSE_AMBIGUOUS');});
test('source timestamps are never invented from the cache timestamp',()=>{const value=org();delete value.cx_story[0].ultima_coleta;const out=projectOrg(value);assert.equal(Object.hasOwn(out.cx_story[0],'ultima_coleta'),false);assert.equal(out._cache_gerado_em,stamp);});
test('stale timestamps are retained so the original screen can label old cache',()=>{const value=org();value._cache_gerado_em='2026-09-01T00:00:00Z';assert.equal(projectOrg(value)._cache_gerado_em,value._cache_gerado_em);});
test('invalid cache timestamp refuses',()=>{const value=org();value._cache_gerado_em='not-a-date';assert.throws(()=>projectOrg(value));});
test('explicit empty organic arrays remain legitimate empty data',()=>{const out=projectOrg({_escopo:'organico',cx_post:[],cx_story:[],cx_organico_receita:[]});assert.deepEqual(out.cx_post,[]);});
test('source failure is never turned into empty arrays',()=>{assert.throws(()=>projectOrg({_escopo:'organico',erro:'fixture failure'}));assert.throws(()=>projectOrg({_escopo:'organico'}));});
test('creators maintains original window, relationships, costs and terms order',()=>{const value=creators();value.termos.push({...value.termos[0],vigente_desde:'2026-09-01'});const out=projectCreators(value);assert.deepEqual(out.janela,query);assert.equal(out.termos[0].vigente_desde,'2026-10-01');assert.equal(out.custos[0].fixo,5);assert.equal(out.custos[0].frete,null);assert.equal(out.roi[0].investimento_total,null);assert.equal(out.receita_cupom[0].pedidos,1);});
test('creators excludes records of another brand',()=>{const value=creators();for(const key of ['influs','roi','cupons','custos','receita_cupom','termos'])value[key].push({...value[key][0],marca:'aristo'});const out=projectCreators(value);assert.equal(out.influs.length,1);assert.equal(out.roi.length,1);});
for(const key of ['influs','roi','cupons','custos','receita_cupom','termos'])test('creators requires original array '+key,()=>{const value=creators();delete value[key];assert.throws(()=>projectCreators(value));});
test('creators requires exact requested window',()=>{const value=creators();value.janela.fim='2026-10-10';assert.throws(()=>projectCreators(value));});
test('creator metrics without brand refuse',()=>{const value=creators();delete value.roi[0].marca;assert.throws(()=>projectCreators(value));});
test('unknown creator relationship refuses',()=>{const value=creators();value.roi[0].influ='unknown-fixture';assert.throws(()=>projectCreators(value));});
test('unknown coupon relationship refuses',()=>{const value=creators();value.receita_cupom[0].codigo='UNKNOWN';assert.throws(()=>projectCreators(value));});
test('duplicate creator or coupon refuses',()=>{for(const key of ['influs','cupons']){const value=creators();value[key].push({...value[key][0]});assert.throws(()=>projectCreators(value));}});
test('identical term and cost granularities refuse',()=>{for(const key of ['termos','custos']){const value=creators();value[key].push({...value[key][0]});assert.throws(()=>projectCreators(value));}});
test('NaN metrics refuse',()=>{const value=creators();value.roi[0].receita=NaN;assert.throws(()=>projectCreators(value));});
test('unknown requested brand refuses',()=>assert.throws(()=>R.project(org(),{area:'organico',brand:'other'})));

test('missing creator revenue is refused instead of becoming zero',()=>{const value=creators();delete value.roi[0].receita;assert.throws(()=>projectCreators(value));});
test('organic attribution keeps its own revenue and classification schema',()=>{const value=org();value.organico_attribution={schema_version:1,window_days:30,source_system:'shopify',currency:'BRL',daily:[{marca:'fish',dia:'2026-10-11',model:'last_non_direct',classification:'organico',superficie:'story',pedidos:2,receita_liquida:10}],quality:[{marca:'fish',dia:'2026-10-11',jornada_pendente:1,jornada_parcial:null,ultima_sessao_conhecida:2,ultima_sessao_desconhecida:null,origem_nao_direta_desconhecida:null}],coverage:[{marca:'fish',dia:'2026-10-11',checked_at:stamp}]};const out=projectOrg(value).organico_attribution;assert.equal(out.daily[0].receita_liquida,10);assert.equal(out.daily[0].superficie,'story');assert.equal(out.quality[0].ultima_sessao_desconhecida,null);assert.equal(out.quality[0].jornada_pendente,1);assert.equal(out.quality[0].jornada_parcial,null);});

// Synthetic original-Master composition; no real issuer or network invocation.
const S=require((process.env.DASHBOARD_ACCESS_TEST_RUNTIME||require('node:path').resolve(__dirname,'../services/dashboard-operational'))+'/server.cjs'),P=require((process.env.DASHBOARD_ACCESS_TEST_RUNTIME||require('node:path').resolve(__dirname,'../services/dashboard-operational'))+'/proxy.cjs');
function masterEnv(){
 const routes={'crm-read':P.FIXED_DESTINATIONS['crm-read'],campaigns:P.REVIEWED_DYNAMIC.routes.campaigns,segments:P.REVIEWED_DYNAMIC.routes.segments};
 return {DASHBOARD_MODE:'operational',DASHBOARD_UPSTREAM_PROFILE:'production',DASHBOARD_CRM_CAMPAIGN_WRITER_PROFILE:'own-master-production-v1',DASHBOARD_CRM_CAMPAIGN_SUBMIT_WRITE:'enabled',DASHBOARD_CRM_MASTER_AUDIENCE_READ:'enabled',DASHBOARD_MANAGER_HOST:'gerencial.shrigma.com.br',DASHBOARD_AREA_HOSTS:JSON.stringify({growth:'crm.shrigma.com.br',organico:'organico.shrigma.com.br',influs:'influs.shrigma.com.br'}),DASHBOARD_EMAIL_DOMAINS:JSON.stringify(['oaristocrata.com','shrigma.com.br','fishermans.com.br']),DASHBOARD_ADMIN_EMAIL:'felipebandeira@oaristocrata.com',DASHBOARD_UPSTREAMS:JSON.stringify(routes),DASHBOARD_UPSTREAM_HOSTS:JSON.stringify([...new Set(Object.values(routes).map(s=>new URL(s).hostname))]),DASHBOARD_DYNAMIC_ROUTE_MANIFEST:JSON.stringify({schema:P.DYNAMIC_MANIFEST_SCHEMA,sourceRevision:P.REVIEWED_DYNAMIC.sourceRevision,routes:{campaigns:routes.campaigns,segments:routes.segments}})};
}
test('absent READ flag stays disabled through string-valued startup environment',()=>{const before=masterEnv(),out=S.environmentForOriginalMasterIndividualRead({},before);assert.equal(out.DASHBOARD_INDIVIDUAL_READ,'disabled');assert.equal(S.settingsFromEnv(out).dashboardIndividualRead,undefined);assert.deepEqual(before,masterEnv());});
test('READ opt-in adds only pinned read destinations and preserves Master writer properties',()=>{const before=masterEnv(),out=S.environmentForOriginalMasterIndividualRead({DASHBOARD_INDIVIDUAL_READ:'enabled',DASHBOARD_CRM_CAMPAIGN_SUBMIT_WRITE:'disabled'},before);const routes=JSON.parse(out.DASHBOARD_UPSTREAMS);for(const key of ['cx','cache','influ'])assert.equal(routes[key],P.FIXED_DESTINATIONS[key]);for(const key of ['DASHBOARD_CRM_CAMPAIGN_WRITER_PROFILE','DASHBOARD_CRM_CAMPAIGN_SUBMIT_WRITE','DASHBOARD_CRM_MASTER_AUDIENCE_READ','DASHBOARD_DYNAMIC_ROUTE_MANIFEST'])assert.equal(out[key],before[key]);assert.equal(S.settingsFromEnv(out).dashboardIndividualRead,true);assert.deepEqual(before,masterEnv());});
test('unknown READ startup flag is refused',()=>assert.throws(()=>S.environmentForOriginalMasterIndividualRead({DASHBOARD_INDIVIDUAL_READ:'true'},masterEnv())));
test('preserved old runtime can import server while optional READ helper is absent',()=>{
 const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),root=process.env.DASHBOARD_ACCESS_TEST_RUNTIME||path.resolve(__dirname,'../services/dashboard-operational'),file=path.join(root,'server.cjs'),m=new Module(file,module);
 m.filename=file;m.paths=Module._nodeModulePaths(root);m.require=id=>{if(id==='./dashboard-individual-read.cjs')throw Error('helper absent from preserved legacy pack');return id.startsWith('./')?require(path.join(root,id)):require(id);};
 assert.doesNotThrow(()=>m._compile(fs.readFileSync(file,'utf8'),file));assert.equal(typeof m.exports.createServer,'function');
});
test('READ opt-in preserves existing managed lifecycle under writer coexistence configuration',async()=>{
 const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),A=require((process.env.DASHBOARD_ACCESS_TEST_RUNTIME||require('node:path').resolve(__dirname,'../services/dashboard-operational'))+'/auth.cjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dashboard-read-coexistence-')),token=crypto.randomBytes(32).toString('base64url'),password='Synthetic-password-2026!',host='gerencial.shrigma.com.br',origin='https://'+host;
 const opts={dbPath:path.join(dir,'identity.sqlite'),managerHost:host,areaHosts:{growth:'crm.shrigma.com.br',organico:'organico.shrigma.com.br',influs:'influs.shrigma.com.br'},allowedEmailDomains:['oaristocrata.com','shrigma.com.br','fishermans.com.br'],bootstrapAdminEmail:'felipebandeira@oaristocrata.com',bootstrapTokenSha256:crypto.createHash('sha256').update(token).digest('hex'),encryptionKey:crypto.randomBytes(32).toString('hex'),crmCampaignWriterProfile:'own-master-production-v1',crmCampaignSubmitWrite:true,crmIndividualCoexistence:true,crmManagedRead:{issuerId:'00000001-0000-4000-8000-000000000000',namespaceId:'00000002-0000-4000-8000-000000000000'},crmManagedWriter:{mode:'corporate-read-writer-v1',issuerId:'00000003-0000-4000-8000-000000000000',namespaceId:'00000004-0000-4000-8000-000000000000'}};
 let auth=A.createAuth(opts);
 try{
  await auth.completeBootstrap({email:opts.bootstrapAdminEmail,token,password,host,origin});const login=await auth.login({email:opts.bootstrapAdminEmail,password,host,origin}),context={method:'POST',host,origin,cookieHeader:login.cookie.split(';')[0],csrf:login.csrf};
  const invite=auth.createInvite({context,email:'synthetic-analyst@shrigma.com.br',areas:['growth'],brand:'fish',permissions:{growth:{read:true,edit:false}}});
  const find=a=>{const all=a.users({context}),rows=Array.isArray(all)?all:all.users;return rows.find(u=>u.id===invite.userId).crmAccess;},before=find(auth);assert(before);assert.equal(before.readOnly,undefined);auth.close();auth=A.createAuth({...opts,dashboardIndividualRead:true});assert.deepEqual(find(auth),before);
 }finally{auth.close();fs.rmSync(dir,{recursive:true,force:true});}
});

// Simple login keeps legacy identity off while completing fixed READ destinations.
test('simple startup adds only fixed READ routes and preserves writer, identity and private source bindings',()=>{
 const before={...masterEnv(),DASHBOARD_SIMPLE_READ_LOGIN:'enabled',DASHBOARD_INDIVIDUAL_READ:'disabled',DASHBOARD_SERVICE_READ_CRM_KEY:'synthetic-read-key'},snapshot=JSON.stringify(before),out=S.environmentForSimpleDashboardRead(before,before);
 const routes=JSON.parse(out.DASHBOARD_UPSTREAMS);for(const key of ['cx','cache','influ'])assert.equal(routes[key],P.FIXED_DESTINATIONS[key]);
 assert.equal(JSON.stringify(before),snapshot);assert.equal(out.DASHBOARD_INDIVIDUAL_READ,'disabled');assert.equal(S.settingsFromEnv(out).simpleReadMode,true);assert.equal(S.settingsFromEnv(out).dashboardIndividualRead,undefined);
 for(const key of Object.keys(before).filter(k=>!['DASHBOARD_UPSTREAMS','DASHBOARD_UPSTREAM_HOSTS'].includes(k)))assert.equal(out[key],before[key]);
 assert.equal(out.DASHBOARD_CRM_MANAGER_ISSUER_ID,undefined);assert.equal(out.DASHBOARD_CRM_MANAGER_PROVISIONER_TOKEN,undefined);
});
test('simple READ projection is idempotent and refuses an existing different destination',()=>{
 const before={...masterEnv(),DASHBOARD_SIMPLE_READ_LOGIN:'enabled'},once=S.environmentForSimpleDashboardRead(before,before);assert.deepEqual(S.environmentForSimpleDashboardRead(once,once),once);
 for(const key of ['cx','cache','influ']){const value={...before,DASHBOARD_UPSTREAMS:JSON.stringify({...JSON.parse(before.DASHBOARD_UPSTREAMS),[key]:'https://synthetic.invalid/unapproved'})};assert.throws(()=>S.environmentForSimpleDashboardRead(value,value),/Simple READ destination invalid/);}
});
test('disabled simple READ is unchanged; sandbox, synthetic and unknown flags refuse',()=>{
 const before=masterEnv();assert.equal(S.environmentForSimpleDashboardRead({},before),before);assert.equal(S.environmentForSimpleDashboardRead({DASHBOARD_SIMPLE_READ_LOGIN:'disabled'},before),before);
 assert.throws(()=>S.environmentForSimpleDashboardRead({DASHBOARD_SIMPLE_READ_LOGIN:'enabled'},{...before,DASHBOARD_MODE:'synthetic'}));
 assert.throws(()=>S.environmentForSimpleDashboardRead({DASHBOARD_SIMPLE_READ_LOGIN:'enabled'},{...before,DASHBOARD_UPSTREAM_PROFILE:'crm-sandbox'}));
 assert.throws(()=>S.environmentForSimpleDashboardRead({DASHBOARD_SIMPLE_READ_LOGIN:'true'},before));
});

test('organic preserves the published detailed UTM classification and original account/video metrics',()=>{
 const v=org();v.cx_post[0].views=10;v.cx_conta_dia[0].profile_views=4;v.cx_conta_dia[0].alcance_conta=12;
 v.organico_attribution={schema_version:1,window_days:30,source_system:'shopify',currency:'BRL',rule_version:'organico-utm-20260927-v2',default_model:'last_click',daily:[{marca:'fish',dia:'2026-10-11',model:'last_click',classification:'editorial',detail_level:'utm',rule_reason:'controle_utm_instagram_story',pedidos:1,receita_liquida:10}],quality:[],coverage:[]};
 const out=projectOrg(v);assert.equal(out.cx_post[0].views,10);assert.equal(out.cx_conta_dia[0].profile_views,4);assert.equal(out.cx_conta_dia[0].alcance_conta,12);assert.equal(out.organico_attribution.rule_version,v.organico_attribution.rule_version);
 const O=require('../organico-attribution.js'),selected=O.select(out,'fish','2026-10-01','2026-10-11');assert.equal(selected.detailRows.length,1);assert.equal(selected.detailRows[0].rule_reason,'controle_utm_instagram_story');
});
test('optional creator blocks preserve brand, unknowns and actual collection time without personal rows',()=>{
 const v=creators();v.clientes=[{marca:'fish',influ:'fixture-creator',pedidos:3,novos:1,recorrentes:1,sem_indice:1,customer_email:'private@synthetic.invalid'},{marca:'aristo',influ:'other',pedidos:1,novos:1,recorrentes:0,sem_indice:0}];v.conciliacao=[{marca:'fish',codigo:'FIXTURE',influ:'fixture-creator',relatorio_pedidos:null,pagos:1,receita_paga:10,nao_pagos:0,receita_nao_paga:0,diferenca:null,relatorio_cobertura:'sem_coleta',situacao:'relatorio_indisponivel'}];v.saude=[{marca:'fish',lane:'coleta_pedidos',ok:false,em:stamp,ultimo_ok_em:null,itens:null,detalhe:'private provider error'}];v.coleta={fish:stamp,aristo:'2026-10-10T00:00:00Z'};v.conciliacao_pedidos=[{email:'private@synthetic.invalid'}];
 const out=projectCreators(v);assert.equal(out.clientes.length,1);assert.equal(out.clientes[0].sem_indice,1);assert.equal(out.conciliacao[0].diferenca,null);assert.equal(out.saude[0].ok,false);assert.deepEqual(out.coleta,{fish:stamp});assert(!JSON.stringify(out).includes('private'));assert(!Object.hasOwn(out,'conciliacao_pedidos'));
 const absent=projectCreators(creators());for(const k of ['clientes','conciliacao','saude','coleta'])assert(!Object.hasOwn(absent,k));
});
test('invalid client denominator makes the whole optional block unavailable, retaining core metrics',()=>{const v=creators();v.clientes=[{marca:'fish',influ:'fixture-creator',pedidos:3,novos:1,recorrentes:1,sem_indice:0}];const out=projectCreators(v);assert(!Object.hasOwn(out,'clientes'));assert.equal(out.roi[0].receita,10);assert.deepEqual(out.read_issues,[{section:'clientes',reason:'contract_invalid'}]);});
test('organic diagnostic exposes a field name and reason without its value',()=>{const v=org();v.cx_post[0].impulsionado='private-value';assert.throws(()=>projectOrg(v),e=>{assert.deepEqual(e.projectionIssue,{section:'cx_post',reason:'field_type_invalid',field:'impulsionado'});assert(!JSON.stringify(e.projectionIssue).includes('private-value'));return true;});});
test('creator health screen does not fabricate another brand under individual scope',()=>{
 const F=require('../influs-conferencia.js'),p={brand:'fish',brandAccess:'single',saude:[{marca:'fish',lane:'coleta_pedidos',ok:true,em:stamp}]};const rows=F.saude(p,Date.parse(stamp));assert(rows.length>0);assert(rows.every(x=>x.marca==='fish'));assert.equal(F.saude({saude:[]}).length,6);
});

test('missing reconciliation numerators refuse before the screen can manufacture zero',()=>{
 const value=creators();value.conciliacao=[{marca:'fish',codigo:'FIXTURE',relatorio_cobertura:'completa',situacao:'igual'}];assert(!Object.hasOwn(projectCreators(value),'conciliacao'));
 const complete={marca:'fish',codigo:'FIXTURE',relatorio_cobertura:'completa',situacao:'igual',pagos:1,receita_paga:10,nao_pagos:0,receita_nao_paga:0,relatorio_pedidos:1,relatorio_vendas_liquidas:10};
 for(const k of ['pagos','nao_pagos','receita_paga','receita_nao_paga','relatorio_pedidos','relatorio_vendas_liquidas']){value.conciliacao=[{...complete,[k]:null}];const out=projectCreators(value);assert(!Object.hasOwn(out,'conciliacao'));assert.equal(out.roi[0].receita,10);assert.deepEqual(out.read_issues,[{section:'conciliacao',reason:'contract_invalid'}]);}
 value.conciliacao=[complete];assert.equal(projectCreators(value).conciliacao[0].nao_pagos,0);
});

test('complete report legitimately absent or outside the lens retains exactly the null pair',()=>{for(const situacao of ['ausente_no_relatorio','fora_da_lente']){const v=creators();v.conciliacao=[{marca:'fish',codigo:'FIXTURE',pagos:1,receita_paga:10,nao_pagos:0,receita_nao_paga:0,relatorio_cobertura:'completa',situacao,relatorio_pedidos:null,relatorio_vendas_liquidas:null}];assert.equal(projectCreators(v).conciliacao[0].relatorio_vendas_liquidas,null);v.conciliacao[0].relatorio_pedidos=1;assert(!Object.hasOwn(projectCreators(v),'conciliacao'));}});
test('success flag without a confirmed source time remains unknown on the health screen',()=>{const F=require('../influs-conferencia.js'),out=F.saude({brand:'fish',brandAccess:'single',saude:[{marca:'fish',lane:'coleta_pedidos',ok:true,em:null,ultimo_ok_em:null}]});assert.equal(out.find(x=>x.lane==='coleta_pedidos').estado,'sem_registro');});


test('published unbranded media derives ownership only from same-response post IDs',()=>{
 const v=org();v.cx_post_midia=[{post_id:'fixture-1',tipo:'video',previa_url:'https://s.cdninstagram.com/fixture.jpg',email:'private@synthetic.invalid'},{post_id:'fixture-2',previa_url:'https://s.fbcdn.net/other.jpg'},{post_id:'orphan',previa_url:'https://s.fbcdn.net/orphan.jpg'}];
 const out=projectOrg(v);assert.deepEqual(out.cx_post_midia,[{marca:'fish',brand:'fish',post_id:'fixture-1',previa_url:'https://s.cdninstagram.com/fixture.jpg'}]);assert(!JSON.stringify(out.cx_post_midia).includes('other'));assert(!JSON.stringify(out).includes('private@'));
});
for(const fault of ['cross-brand-collision','media-brand-conflict','duplicate-media','unsafe-url','malformed-row'])test('media '+fault+' drops only previews and never changes core posts',()=>{
 const v=org();v.cx_post_midia=[{post_id:'fixture-1',previa_url:'https://s.cdninstagram.com/fixture.jpg'}];
 if(fault==='cross-brand-collision')v.cx_post[1].post_id='fixture-1';
 if(fault==='media-brand-conflict')v.cx_post_midia[0].marca='aristo';
 if(fault==='duplicate-media')v.cx_post_midia.push({...v.cx_post_midia[0]});
 if(fault==='unsafe-url')v.cx_post_midia[0].previa_url='https://cdninstagram.com.attacker.invalid/fixture.jpg';
 if(fault==='malformed-row')v.cx_post_midia.push(null);
 const out=projectOrg(v);assert(!Object.hasOwn(out,'cx_post_midia'));assert.equal(out.cx_post.length,1);assert.equal(out.cx_post[0].alcance,42);assert.equal(out.read_issues[0].section,'cx_post_midia');assert(!JSON.stringify(out.read_issues).includes('attacker'));
});
test('valid empty media differs from unavailable media',()=>{const v=org();v.cx_post_midia=[];const out=projectOrg(v);assert.deepEqual(out.cx_post_midia,[]);assert(!Object.hasOwn(out,'read_issues'));});
test('historical client aggregate need not belong to the current creator catalogue',()=>{
 const v=creators();v.clientes=[{marca:'fish',influ:'historical-fixture',pedidos:2,novos:1,recorrentes:1,sem_indice:0}];const out=projectCreators(v);assert.equal(out.clientes[0].pedidos,2);assert(!Object.hasOwn(out,'read_issues'));assert.equal(out.influs.length,1);
});
for(const section of ['clientes','conciliacao','saude','coleta'])test('invalid optional '+section+' does not remove core or publish partial totals',()=>{
 const v=creators();v[section]=section==='coleta'?{fish:'not-a-date'}:[{marca:'fish',email:'private@synthetic.invalid'}];const out=projectCreators(v);assert(!Object.hasOwn(out,section));assert.equal(out.influs.length,1);assert.equal(out.roi[0].receita,10);assert.equal(out.read_issues[0].section,section);assert(!JSON.stringify(out).includes('private@'));
});
test('one invalid optional client row rejects the full collection including otherwise valid rows',()=>{
 const v=creators();v.clientes=[{marca:'fish',influ:'fixture-creator',pedidos:1,novos:1,recorrentes:0,sem_indice:0},{marca:'fish',influ:'other-fixture',pedidos:1,novos:0,recorrentes:0,sem_indice:0}];const out=projectCreators(v);assert(!Object.hasOwn(out,'clientes'));assert.equal(out.receita_cupom[0].receita,10);
});
