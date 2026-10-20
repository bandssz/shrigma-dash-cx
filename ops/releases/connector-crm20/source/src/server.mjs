import express from 'express';
import {pathToFileURL} from 'node:url';
import {McpServer,createMcpHandler} from '@modelcontextprotocol/server';
import {toNodeHandler} from '@modelcontextprotocol/node';
import {createMcpExpressApp,requireBearerAuth,getOAuthProtectedResourceMetadataUrl} from '@modelcontextprotocol/express';
import {settings,open} from './config.mjs';
import {createIdentityProvider,mountInteractions,interactionRefusalResponse,SCOPE} from './auth.mjs';
import {mountAdmin} from './admin.mjs';
import {TOOLS,Refusal} from './policy.mjs';
import {Listmonk} from './listmonk.mjs';
import {CampaignService} from './campaigns.mjs';
import {Crm,CRM_TOOLS,CRM_DESCRIPTIONS,loginCrm} from './crm.mjs';

const readOnlyTool=name=>name.startsWith('crm_')?['crm_status','crm_campaign_catalog','crm_campaign_list','crm_campaign_get','crm_audience_list','crm_audience_get','crm_models_list','crm_model_get','crm_model_operation'].includes(name):name.endsWith('_get');
const DESCRIPTIONS={
  listmonk_campaign_get:'Lê campanha nova deste conector e da marca admitida. Retorna revisão e contadores; aceitação não comprova entrega.',
  listmonk_lists_get:'Lê somente as listas autorizadas da própria marca com contagem do Listmonk. Frescor da estatística pode ser desconhecido.',
  listmonk_templates_get:'Lê somente os templates admitidos da marca. Não altera templates.',
  listmonk_draft_create:'Cria rascunho novo. Gere operation_id UUID uma vez e preserve-o. Exige from_email raiz, reply_to e listas da marca. Em timeout consulte operation_get, nunca repita com outro ID.',
  listmonk_draft_update:'Edita somente rascunho com revisão atual, preserva antes e devolve diff. From_email e reply_to explícitos. Não altera campanhas preexistentes.',
  listmonk_campaign_test:'Único teste desta revisão. Somente destinatário interno registrado, enabled e confirmado. Consome o teste antes do POST; resultado incerto nunca é repetido.',
  listmonk_campaign_schedule:'Agenda rascunho com pelo menos15 minutos de folga no relógio do servidor. Em falha consulte operation_id, não repita.',
  listmonk_campaign_to_draft:'Retorna campanha agendada a rascunho e limpa send_at. Não muda o conteúdo nem libera outro teste da mesma revisão.',
  listmonk_campaign_pause:'Pausa somente campanha running criada por este conector. Nunca reenvia.',
  listmonk_operation_get:'Consulta resultado por operation_id do próprio analista e reconcilia por leitura. Nunca repete a operação; incerto exige revisão humana.'
};
export function buildApp({config,store,secret,clientFor,crmFetch=fetch}){
  const app=createMcpExpressApp({host:'0.0.0.0',allowedHosts:[new URL(config.origin).hostname],allowedOrigins:[new URL(config.origin).hostname,'claude.ai'],jsonLimit:'600kb'});
  app.disable('x-powered-by');app.set('trust proxy',1);
  app.use((_req,res,next)=>{res.set({'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cache-Control':'no-store'});next();});
  const idp=createIdentityProvider({store,origin:config.origin,clientId:config.clientId,jwks:secret.jwks,cookieKeys:secret.cookieKeys});
  const service=new CampaignService({store,environment:config.environment,smtpConfirmed:false,clientFor:clientFor??(user=>new Listmonk({origin:config.upstream,environment:config.environment,credentials:()=>store.credentials(user.id)}))});
  const crm=new Crm({store,fetchImpl:crmFetch});
  const json=express.json({limit:'600kb',strict:true});
  mountInteractions(app,{...idp,store,origin:config.origin,clientId:config.clientId,crmLogin:args=>loginCrm({...args,fetchImpl:crmFetch}),urlencoded:express.urlencoded({extended:false,limit:'4kb',parameterLimit:8})});
  mountAdmin(app,{store,secret,config,service,json});
  app.get('/health',(_req,res)=>res.json({ok:true,environment:config.environment,version:'0.1.0',real_use_enabled:store.businessEnabled&&config.environment==='production'}));
  app.get('/',(_req,res)=>res.type('text').send('CRM Shrigma · MCP de campanhas. Configure /mcp no Claude com OAuth individual.'));
  // Ciphertext only. The owner's private RSA key never enters this service or its deployment.
  app.get('/.well-known/shrigma-owner-enrollment',(_req,res)=>secret.ownerEnrollment?res.json(secret.ownerEnrollment):res.sendStatus(404));
  const resource=config.origin+'/mcp';
  const metadata={resource,authorization_servers:[config.origin],scopes_supported:[SCOPE],bearer_methods_supported:['header'],resource_name:'CRM Shrigma Listmonk'};
  app.get(['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp'],(_req,res)=>res.json(metadata));
  app.get('/.well-known/oauth-authorization-server',(_req,res)=>res.json({issuer:config.origin,authorization_endpoint:config.origin+'/auth',token_endpoint:config.origin+'/token',jwks_uri:config.origin+'/jwks',revocation_endpoint:config.origin+'/token/revocation',response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],token_endpoint_auth_methods_supported:['none'],code_challenge_methods_supported:['S256'],scopes_supported:['openid','offline_access',SCOPE]}));
  const auth=requireBearerAuth({verifier:{verifyAccessToken:idp.verifyAccessToken},requiredScopes:[SCOPE],expectedResource:new URL(resource),resourceMetadataUrl:getOAuthProtectedResourceMetadataUrl(new URL(resource))});
  const handler=createMcpHandler(({authInfo})=>{
    const actor=authInfo?.extra?.actor;if(typeof actor!=='string')throw Error('IDENTITY_REQUIRED');
    const server=new McpServer({name:'shrigma-listmonk',version:'0.1.0'});
    for(const[name,schema]of Object.entries(store.user(actor)?.crm===true?CRM_TOOLS:TOOLS))server.registerTool(name,{description:CRM_DESCRIPTIONS[name]??DESCRIPTIONS[name],inputSchema:schema,annotations:{readOnlyHint:readOnlyTool(name),destructiveHint:!readOnlyTool(name),idempotentHint:readOnlyTool(name),openWorldHint:true}},async input=>{
      try{const result=await (store.user(actor)?.crm===true?crm:service).call(name,input,actor);return{content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result,isError:!!result.refused};}
      catch(error){if(error instanceof Refusal&&store.user(actor)?.crm===true){const result={refused:true,error:error.code,message:error.message};return{content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result,isError:true};}store.audit(actor,store.user(actor)?.brand??null,name,null,'unconfirmed',{code:'CONNECTOR_READ_OR_LEDGER_UNCONFIRMED'});return{content:[{type:'text',text:JSON.stringify({error:'CONNECTOR_READ_OR_LEDGER_UNCONFIRMED',message:'Não há comprovação. Consulte o ID operacional quando houver; não repita automaticamente.'})}],isError:true};}
    });return server;
  },{legacy:'stateless',onerror:()=>{}});
  const node=toNodeHandler(handler,{maxRequestBodySize:600000,onerror:()=>{}});
  app.all('/mcp',(req,res,next)=>{if(req.get('origin')&&![config.origin,'https://claude.ai'].includes(req.get('origin')))return res.status(403).json({error:'ORIGIN_REFUSED'});next();},auth,json,async(req,res)=>{
    if(req.body?.method==='tools/call'){
      const actor=req.auth.extra.actor,name=req.body?.params?.name,args=req.body?.params?.arguments;
      store.audit(actor,store.user(actor)?.brand??null,'mcp_tool_request',Number.isSafeInteger(args?.campaign_id)?args.campaign_id:null,'received',{tool:typeof name==='string'?name.slice(0,100):null,operationId:typeof args?.operation_id==='string'&&/^[a-f0-9-]{36}$/.test(args.operation_id)?args.operation_id:null});
    }
    await node(req,res,req.body);
    if(req.body?.method==='tools/call')store.audit(req.auth.extra.actor,store.user(req.auth.extra.actor)?.brand??null,'mcp_tool_response',null,'returned',{httpStatus:res.statusCode,businessResult:'see action/operation audit; transport status is not delivery'});
  });
  app.use(idp.provider.callback());
  app.use((error,req,res,_next)=>{if(interactionRefusalResponse(error,req,res,store))return;if(!res.headersSent)res.status(400).json({error:'REQUEST_REFUSED'});});
  return{app,service,...idp,close:()=>handler.close()};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{const config=settings(),{store,secret}=open(config);
    if(process.env.FIXTURE_MODE==='1'){
      if(config.environment!=='test'||config.upstream!=='http://127.0.0.1:3001')throw Error('FIXTURE_ENVIRONMENT_REFUSED');
      const {createFixture,fakeProfile}=await import('./test-fixture.mjs');const {createServer}=await import('node:http');
      const minNextId=Math.max(500,(store.db.prepare('SELECT max(id) n FROM campaigns').get().n??499)+1);
      const fixture=createFixture({file:config.data+'/fixture-campaigns.json',minNextId});for(const [brand,index]of[['aristo',1],['fish',2]])fixture.profiles.set('fixture-'+index,fakeProfile(brand,index));await new Promise(resolve=>createServer(fixture.handler).listen(3001,'127.0.0.1',resolve));
    }
    store.recoverInterrupted();const{app}=buildApp({config,store,secret});const server=app.listen(config.port,'0.0.0.0',()=>console.log(JSON.stringify({event:'started',environment:config.environment,real_use_enabled:false})));server.requestTimeout=30000;server.headersTimeout=10000;server.keepAliveTimeout=5000;
    process.on('SIGTERM',()=>{server.close(()=>{store.close();process.exit(0);});setTimeout(()=>process.exit(1),15000).unref();});
  }catch{console.error('STARTUP_REFUSED');process.exitCode=1;}
}
