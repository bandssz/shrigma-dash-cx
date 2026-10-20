import {z} from 'zod';
import {identity,deny,PROTECTED_IDS} from './policy.mjs';

const ORIGIN='https://crm.shrigma.com.br';
const brand=z.enum(['aristo','fish']),id=z.number().int().positive();
const definition=z.record(z.string(),z.unknown()),object=z.record(z.string(),z.unknown());
const current={brand,id,attribs:object,media:z.array(z.number().int()),headers:z.array(object)};
export const CRM_TOOLS=Object.freeze({
 crm_status:z.strictObject({}),
 crm_campaign_catalog:z.strictObject({brand}),
 crm_campaign_list:z.strictObject({brand,page:z.number().int().positive().optional()}),
 crm_campaign_get:z.strictObject({brand,id}),
 crm_campaign_create:z.strictObject({brand,definition,audience_id:z.string().optional(),audience_name:z.string().optional()}),
 crm_campaign_save:z.strictObject({...current,definition}),
 crm_campaign_test:z.strictObject({...current,definition,recipient:z.string().max(254)}),
 crm_campaign_schedule:z.strictObject({brand,id,send_at:z.string().max(40),confirm:z.literal('agendar')}),
 crm_campaign_cancel:z.strictObject({brand,id,list_ids:z.array(z.number().int().positive()),attribs:object,media:z.array(z.number().int()),confirm:z.literal('cancelar')}),
 crm_audience_list:z.strictObject({brand,offset:z.number().int().nonnegative().optional(),limit:z.number().int().min(1).max(100).optional()}),
 crm_audience_get:z.strictObject({brand,id:z.string()}),
 crm_models_list:z.strictObject({brand,offset:z.number().int().nonnegative().optional()}),
 crm_model_get:z.strictObject({brand,id:z.string()}),
 crm_model_save:z.strictObject({brand,name:z.string(),subject:z.string(),html:z.string(),idempotency_key:z.uuid()}),
 crm_model_operation:z.strictObject({brand,idempotency_key:z.uuid()})
});
export const CRM_DESCRIPTIONS=Object.freeze({
 crm_status:'Confere a sessão individual do CRM e as permissões da pessoa conectada.',
 crm_campaign_catalog:'Consulta listas e layout de campanha pelo CRM da própria marca.',
 crm_campaign_list:'Consulta campanhas no CRM da própria marca.',
 crm_campaign_get:'Relê a campanha no CRM. Use para conferir o resultado; nunca repete uma escrita.',
 crm_campaign_create:'Cria um rascunho pelo CRM. Não agenda e não envia. Em resultado incerto releia a lista; não repita.',
 crm_campaign_save:'Salva a campanha pelo CRM com os metadados da última leitura. Não agenda.',
 crm_campaign_test:'Envia um único [TESTE] interno pelo CRM, com autorização explícita. Em resultado incerto confira a caixa e não repita.',
 crm_campaign_schedule:'Agenda pelo CRM o horário já salvo, mediante confirmação específica. O Listmonk é o executor.',
 crm_campaign_cancel:'Cancela pelo CRM e limpa a data. Confira draft, send_at null e sent zero.',
 crm_audience_list:'Consulta os públicos e o catálogo original do CRM da própria marca.',
 crm_audience_get:'Relê um público do CRM da própria marca.',
 crm_models_list:'Consulta os rascunhos de peças no CRM da própria marca.',
 crm_model_get:'Relê o rascunho de peça pelo CRM.',
 crm_model_save:'Salva um novo rascunho de peça pelo CRM com a chave da tentativa existente. Preserve essa chave; não gere outra em timeout.',
 crm_model_operation:'Consulta o mesmo salvamento de peça no CRM, sem repetir POST.'
});

async function response(r){
 if(r.status===401)deny('CRM_RECONNECT_REQUIRED','Reconecte com sua conta do CRM.');
 let size=0,parts=[];
 for await(const part of r.body){size+=part.length;if(size>8*1024*1024)deny('CRM_RESPONSE_LIMIT','Resposta do CRM não confirmada.');parts.push(part);}
 let body;try{body=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{deny('CRM_RESULT_UNCONFIRMED','Resultado do CRM não confirmado; não repita a escrita.');}
 if(!r.ok)deny(typeof body?.error==='string'&&/^[A-Z0-9_]{1,80}$/.test(body.error)?body.error:'CRM_REQUEST_REFUSED','O CRM recusou a operação. Atualize a leitura antes de continuar.');
 return body;
}
export async function loginCrm({login,password,brand,fetchImpl=fetch}){
 const r=await fetchImpl(ORIGIN+'/auth/login',{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{Origin:ORIGIN,'Content-Type':'application/json'},body:JSON.stringify({email:login,password})});
 const cookie=r.headers.getSetCookie().map(x=>x.split(';')[0]).find(x=>x.startsWith('__Host-shrigma_sid='));
 await response(r);if(!cookie)deny('CRM_LOGIN_REFUSED','Confira seu acesso individual do CRM.');
 const session=await response(await fetchImpl(ORIGIN+'/auth/session',{redirect:'error',signal:AbortSignal.timeout(20000),headers:{Cookie:cookie}}));
 if(session.authenticated!==true||session.user?.email?.toLowerCase()!==login||!session.user.brands?.includes(brand)||session.user.permissions?.growth?.read!==true||typeof session.csrf!=='string')deny('CRM_IDENTITY_REFUSED','A sessão do CRM não corresponde à conta e marca conectadas.');
 return{cookie,csrf:session.csrf,userId:session.user.id,email:login};
}

// CRM owns permission, rollout, campaign state and native transport. This
// branch never invokes CampaignService, claim(), operation() or a local lock.
export class Crm {
 constructor({store,fetchImpl=fetch}){this.store=store;this.fetchImpl=fetchImpl;}
 async call(name,input,actor){
  const user=this.store.user(actor);identity(user,input.brand??user?.brand);
  if(user.crm!==true||!CRM_TOOLS[name])deny('CRM_ACCOUNT_REQUIRED','Conecte a conta individual do CRM.');
  const q=CRM_TOOLS[name].parse(input),session=this.store.credentials(actor).crm;
  if(!session?.cookie||!session.csrf||session.email!==user.login)deny('CRM_RECONNECT_REQUIRED','Reconecte com sua conta do CRM.');
  let path,method='GET',body,query;
  if(name==='crm_status')path='/auth/session';
  else if(name.startsWith('crm_campaign_')){
   path='/api/campaigns';const action={catalog:'campanha_catalogo',list:'campanha_listar',get:'campanha_obter',create:'campanha_criar',save:'campanha_salvar',test:'campanha_teste',schedule:'campanha_agendar',cancel:'campanha_cancelar'}[name.slice(13)];
   if(!['catalog','list','get'].includes(name.slice(13))){method='POST';if(PROTECTED_IDS.includes(q.id)||[281,282].includes(q.id))deny('CAMPAIGN_PROTECTED','Campanha preservada nesta operação.');body={acao:action,...q};}else query={acao:action,...q};
  }else if(name==='crm_audience_list'||name==='crm_audience_get'){
   path='/api/segments';query={acao:name==='crm_audience_list'?'segmentos_listar':'segmento_obter',...q};
  }else{
   path='/api/model-pieces';
   if(name==='crm_model_save'){method='POST';body={acao:'rascunho',idempotency_key:q.idempotency_key,rascunho:{marca:user.brand,canal:'email',nome:q.name.trim(),assunto:q.subject.trim(),corpo:q.html,idioma:'pt_BR',categoria:'MARKETING',peca:'campanha',cabecalho:'',rodape:'',exemplos:{},botoes:[]}};}
   else if(name==='crm_model_operation')query={acao:'operacao',operacao:'rascunho',marca:user.brand,idempotency_key:q.idempotency_key};
   else query={acao:name==='crm_models_list'?'rascunhos_listar':'rascunho_obter',marca:user.brand,...(name==='crm_model_get'?{draft_id:q.id}:{offset:q.offset??0})};
  }
  const url=new URL(path,ORIGIN);if(query)for(const[k,v]of Object.entries(query))url.searchParams.set(k,String(v));
  let r;try{r=await this.fetchImpl(url.href,{method,redirect:'error',cache:'no-store',signal:AbortSignal.timeout(method==='POST'?85000:30000),headers:{Cookie:session.cookie,Origin:ORIGIN,'X-Shrigma-View-Brand':user.brand,...(method==='POST'?{'X-CSRF-Token':session.csrf,'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});}
  catch{deny('CRM_RESULT_UNCONFIRMED','Resultado não confirmado. Atualize o CRM; não repita a escrita.');}
  const result=await response(r);
  if(name==='crm_status'){
   if(result.authenticated!==true||result.user?.id!==session.userId||result.user.email!==user.login||!result.user.brands?.includes(user.brand))deny('CRM_IDENTITY_REFUSED','Reconecte com sua conta do CRM.');
   return{authenticated:true,user:{id:result.user.id,email:result.user.email,brands:result.user.brands,permissions:result.user.permissions},operator:'crm',brand:user.brand};
  }
  return result;
 }
}
