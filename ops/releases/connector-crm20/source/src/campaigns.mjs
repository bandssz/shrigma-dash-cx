import {TOOLS,Refusal,identity,deny,validateDraft,draftFromRemote,snapshot,contentFingerprint,payload,scheduleTime,recipient,activeSubscriber,canonical,sha,PROTECTED_IDS,mailbox,INTERNAL_DOMAINS} from './policy.mjs';

const INTERNAL_TOOLS=new Set(['listmonk_campaign_get','listmonk_lists_get','listmonk_templates_get','listmonk_draft_create','listmonk_draft_update','listmonk_campaign_test']);

function resultOperation(op) {
  return {operation_id:op.id,actor:op.actor,brand:op.brand,campaign_id:op.campaign_id,action:op.action,state:op.state,code:op.code,created_at:op.created_at,updated_at:op.updated_at,before:op.before,after:op.after,diff:op.diff,automatic_retry:false};
}
export class CampaignService {
  constructor({store,clientFor,now=()=>Date.now(),environment='test',smtpConfirmed=false}) {this.store=store;this.clientFor=clientFor;this.now=now;this.environment=environment;this.smtpConfirmed=smtpConfirmed;this.internalAccess=null;}
  async prepareInternalAccess(grants,expiresAt) {
    const until=Date.parse(expiresAt),now=this.now(),seen=new Set();
    if(!Number.isFinite(until)||until<=now||until-now>604800000||!Array.isArray(grants)||grants.length<1||grants.length>2)deny('INTERNAL_ACCESS_REFUSED','Autorização interna exige prazo futuro de até sete dias e uma ou duas pessoas.');
    const targets=[];
    for(const g of grants){
      const user=identity(this.store.user(g.actor_id),g.brand),email=mailbox(g.self_email),id=g.self_subscriber_id??user.testRecipients[email];
      if(seen.has(user.id)||email!==mailbox(user.login)||!INTERNAL_DOMAINS.includes(email.split('@')[1])||!Number.isSafeInteger(id)||id<1)deny('INTERNAL_ACCESS_REFUSED','Use o inbox do próprio login e um ID de assinante interno comprovável.');
      const client=this.clientFor(user);await client.verify(user);
      let sub;try{sub=await client.get('/api/subscribers/'+id);}catch(error){if(error.status===403)deny('SELF_SUBSCRIBER_NOT_PERMITTED','O usuário API individual não pode ler esse assinante; nenhuma permissão ou lista foi ampliada.');throw error;}
      activeSubscriber(sub,{id,email},user);identity(this.store.user(user.id),user.brand);seen.add(user.id);targets.push(Object.freeze({actorId:user.id,brand:user.brand,selfEmail:email,selfSubscriberId:id}));
    }
    if(until<=this.now())deny('INTERNAL_ACCESS_REFUSED','A autorização expirou durante a validação.');
    return Object.freeze({expiresAt:new Date(until).toISOString(),targets:Object.freeze(targets)});
  }
  requireAccess(name,input,user,expectedTarget=null) {
    if(this.store.businessEnabled)return;
    if(!INTERNAL_TOOLS.has(name))deny('COMMERCIAL_USE_NOT_ENABLED','Agendar, pausar e desagendar continuam bloqueados; a autorização atual é somente interna.');
    const grant=this.internalAccess,target=grant?.targets.find(g=>g.actorId===user.id&&g.brand===user.brand);
    if(!target||this.now()>=Date.parse(grant.expiresAt))deny('FIRST_REAL_USE_APPROVAL_REQUIRED','Uso real bloqueado; falta autorização interna vigente para esta pessoa e marca.');
    if(name==='listmonk_campaign_test'&&mailbox(input.recipient)!==target.selfEmail)deny('INTERNAL_TEST_RECIPIENT_FORBIDDEN','Esta autorização permite testar somente no inbox próprio indicado pelo proprietário.');
    if(expectedTarget&&expectedTarget.id!==target.selfSubscriberId)deny('INTERNAL_TARGET_CHANGED','O destino interno mudou durante a preparação; nenhuma repetição automática.');
    return target;
  }
  campaignSnapshot(campaign,user,creationId=null){
    const id=creationId??this.store.db.prepare("SELECT id FROM operations WHERE action='listmonk_draft_create' AND campaign_id=? AND state='succeeded'").get(campaign.id)?.id;
    const attrs=campaign.attribs,marker=attrs?.mcp_connector;
    if(!id||canonical(Object.keys(attrs??{}))!==canonical(['mcp_connector'])||canonical(Object.keys(marker??{}).sort())!==canonical(['id','operation_id'])||marker.id!==this.store.meta('connector_id')||marker.operation_id!==id||canonical(campaign.tags)!==canonical(['mcp-operation-'+id]))deny('CAMPAIGN_BINDING_CHANGED','Vínculo ou metadados da campanha mudaram; somente o marcador original deste conector é admitido.');
    return snapshot(campaign,user);
  }
  async templateHash(client,id){const t=await client.get('/api/templates/'+id);if(t?.id!==id||t.type!=='campaign'||typeof t.body!=='string')deny('TEMPLATE_UNCONFIRMED','Template de campanha não comprovado.');return sha({id:t.id,type:t.type,body:t.body});}
  async activeLists(client,ids){for(const id of ids){const list=await client.get('/api/lists/'+id);if(list?.id!==id||list.status!=='active')deny('LIST_NOT_ACTIVE','Todas as listas da campanha precisam continuar ativas.');}}
  async call(name, raw, actor) {
    let input, user=this.store.user(actor);
    try{
      if(['listmonk_draft_create','listmonk_draft_update'].includes(name)){
        const source=name==='listmonk_draft_create'?raw?.draft:raw?.patch;
        if(!source?.from_email)deny('FROM_ROOT_REQUIRED','Inclua from_email na raiz do rascunho/patch; cabeçalho From não substitui esse campo.');
        if(!source?.reply_to)deny('REPLY_TO_REQUIRED','Inclua reply_to explicitamente no payload do rascunho/patch.');
      }
      const schema=TOOLS[name],parsed=schema?.safeParse(raw);
      if(!parsed?.success)deny('INPUT_REFUSED','Campos ausentes, inválidos ou não admitidos nesta ferramenta.');
      input=parsed.data;user=identity(user,input.brand??user?.brand);
      if(name==='listmonk_operation_get')return await this.operation(input,user);
      if(this.environment==='production')this.requireAccess(name,input,user);
      const client=this.clientFor(user);
      await client.verify(user);
      if(name==='listmonk_lists_get'){
        const lists=[];for(const id of user.listIds){const l=await client.get('/api/lists/'+id);if(l?.id!==id||l.status!=='active'||!Number.isSafeInteger(l.subscriber_count)||l.subscriber_count<0)deny('LIST_UNCONFIRMED','Lista ou contagem não comprovada.');lists.push({id:l.id,name:l.name,subscriber_count:l.subscriber_count});}
        this.store.audit(user.id,user.brand,name,null,'read',{listIds:lists.map(x=>x.id)});return{brand:user.brand,source:'Listmonk list statistics',observed_at:new Date(this.now()).toISOString(),statistics_refresh_at:null,lists};
      }
      if(name==='listmonk_templates_get'){
        const templates=[];for(const id of user.templateIds){const t=await client.get('/api/templates/'+id);if(t?.id!==id)deny('TEMPLATE_UNCONFIRMED','Template não comprovado.');templates.push({id:t.id,name:t.name,type:t.type,body:t.body});}
        this.store.audit(user.id,user.brand,name,null,'read',{templateIds:templates.map(x=>x.id)});return{brand:user.brand,templates};
      }
      if(name==='listmonk_campaign_get'){
        const local=this.store.owned(input.campaign_id,user.brand),remote=await client.get('/api/campaigns/'+local.id),current=this.campaignSnapshot(remote,user);
        if(remote.uuid!==local.uuid)deny('CAMPAIGN_UUID_CHANGED','A identidade da campanha mudou.');
        this.store.audit(user.id,user.brand,name,local.id,'read',{revision:local.revision,status:current.status});
        return{campaign_id:local.id,revision:local.revision,content_matches_saved_revision:contentFingerprint(current)===local.fingerprint,campaign:current,counts:{sent:remote.sent??null,to_send:remote.to_send??null,views:remote.views??null,clicks:remote.clicks??null,bounces:remote.bounces??null},delivery_not_proven:true};
      }
      const repeated=this.store.operation(input.operation_id,user.id,user.brand);
      if(repeated){if(repeated.actor!==user.id||repeated.action!==name||repeated.request_hash!==sha(input))deny('OPERATION_ID_CONFLICT','ID já consumido por outra ação.');this.store.audit(user.id,user.brand,name,repeated.campaign_id,'already_recorded',{operationId:input.operation_id,state:repeated.state,replayed:false});return resultOperation(repeated);}
      this.requireAccess(name,input,user);
      if(name==='listmonk_draft_create')return await this.create(input,user,client);
      const local=this.store.owned(input.campaign_id,user.brand);
      if(local.revision!==input.revision)deny('REVISION_CHANGED','Revisão desatualizada; releia a campanha.');
      const remote=await client.get('/api/campaigns/'+local.id),before=this.campaignSnapshot(remote,user);
      if(remote.uuid!==local.uuid||contentFingerprint(before)!==local.fingerprint)deny('REVISION_CHANGED','Conteúdo alterado fora desta revisão; nenhuma ação executada.');
      const stopping=['listmonk_campaign_pause','listmonk_campaign_to_draft'].includes(name);
      if(!stopping){
        if(await this.templateHash(client,before.template_id)!==local.template_sha)deny('TEMPLATE_CHANGED','Template mudou depois da criação/revisão; revisão humana necessária.');
        await this.activeLists(client,before.lists);
      }
      let prepared, target=null;
      if(name==='listmonk_draft_update'){
        if(before.status!=='draft')deny('DRAFT_REQUIRED','Somente rascunho pode ser editado.');
        prepared=validateDraft({...draftFromRemote(remote),...input.patch},user);
      }else if(name==='listmonk_campaign_test'){
        if(before.status!=='draft')deny('DRAFT_REQUIRED','Teste exige rascunho.');
        if(this.environment==='production'&&!this.smtpConfirmed)deny('SMTP_NOT_CONFIRMED','Teste real bloqueado enquanto a correção SMTP não estiver comprovada.');
        const internal=this.requireAccess(name,input,user),testUser=internal?{...user,testRecipients:{[internal.selfEmail]:internal.selfSubscriberId}}:user;
        target=recipient(input.recipient,testUser);activeSubscriber(await client.get('/api/subscribers/'+target.id),target,user);
        prepared={...payload(draftFromRemote(remote)),subscribers:[target.email]};
      }else if(name==='listmonk_campaign_schedule'){
        if(before.status!=='draft')deny('DRAFT_REQUIRED','Só rascunho pode ser agendado.');prepared={send_at:scheduleTime(input.send_at,this.now())};
      }else if(name==='listmonk_campaign_to_draft'){
        if(before.status!=='scheduled')deny('SCHEDULED_REQUIRED','Somente agendada pode voltar a rascunho.');prepared={status:'draft'};
      }else if(name==='listmonk_campaign_pause'){
        if(before.status!=='running')deny('RUNNING_REQUIRED','Somente campanha em andamento pode ser pausada.');prepared={status:'paused'};
      }else deny('TOOL_NOT_ALLOWED','Ferramenta não admitida.');
      const templateSha=name==='listmonk_draft_update'?await this.templateHash(client,prepared.template_id):local.template_sha;
      if(name==='listmonk_draft_update')await this.activeLists(client,prepared.lists);
      this.requireAccess(name,input,user,target);
      const claim=this.store.claim({id:input.operation_id,actor:user.id,brand:user.brand,action:name,campaignId:local.id,request:input,prepared,before,revision:local.revision,test:name==='listmonk_campaign_test',expectedLocalSnapshot:canonical(local.snapshot)});
      if(claim.existing)return resultOperation(this.store.operation(input.operation_id,user.id));
      try{
        const send=async(phase,route,body)=>{identity(this.store.user(user.id),user.brand);this.requireAccess(name,input,user);this.store.phase(input.operation_id,phase,'PUT',route,body);return client.request('PUT',route,body);};
        if(name==='listmonk_draft_update'){
          if(contentFingerprint({...prepared,status:'draft',send_at:null})!==local.fingerprint)await send('save-draft','/api/campaigns/'+local.id,payload(prepared,null,remote.attribs,remote.tags));
        }else if(name==='listmonk_campaign_test'){
          // Recheck the actual subscription immediately before the only POST.
          activeSubscriber(await client.get('/api/subscribers/'+target.id),target,user);identity(this.store.user(user.id),user.brand);this.requireAccess(name,input,user,target);
          this.store.phase(input.operation_id,'test-once','POST','/api/campaigns/'+local.id+'/test',prepared);
          const accepted=await client.request('POST','/api/campaigns/'+local.id+'/test',prepared);
          if(accepted!==true)throw Error('TEST_ACK_UNCONFIRMED');
          const result=this.store.complete(input.operation_id,before,{campaign:remote,user,templateSha});
          return{...result,test_result:'Listmonk API accepted; SMTP and delivery unconfirmed',smtp_delivery_proven:false,automatic_retry:false};
        }else if(name==='listmonk_campaign_schedule'){
          scheduleTime(prepared.send_at,this.now());
          await send('save-send-at','/api/campaigns/'+local.id,payload(draftFromRemote(remote),prepared.send_at,remote.attribs,remote.tags));
          const saved=await client.get('/api/campaigns/'+local.id),savedSnapshot=this.campaignSnapshot(saved,user);
          if(saved.uuid!==local.uuid||savedSnapshot.status!=='draft'||Date.parse(savedSnapshot.send_at)!==Date.parse(prepared.send_at)||contentFingerprint(savedSnapshot)!==local.fingerprint)throw Error('SCHEDULE_PREPARATION_UNCONFIRMED');
          scheduleTime(prepared.send_at,this.now());
          await send('schedule','/api/campaigns/'+local.id+'/status',{status:'scheduled'});
        }else if(name==='listmonk_campaign_to_draft'){
          await send('to-draft','/api/campaigns/'+local.id+'/status',{status:'draft'});
          await send('clear-send-at','/api/campaigns/'+local.id,payload(draftFromRemote(remote),null,remote.attribs,remote.tags));
        }else await send('pause','/api/campaigns/'+local.id+'/status',{status:'paused'});
        const final=await client.get('/api/campaigns/'+local.id),after=this.campaignSnapshot(final,user);
        const expected=name==='listmonk_campaign_schedule'?'scheduled':name==='listmonk_campaign_pause'?'paused':'draft';
        const expectedFingerprint=name==='listmonk_draft_update'?contentFingerprint(prepared):local.fingerprint;
        if(final.uuid!==local.uuid||after.status!==expected||contentFingerprint(after)!==expectedFingerprint||name==='listmonk_campaign_to_draft'&&after.send_at!==null||name==='listmonk_campaign_schedule'&&Date.parse(after.send_at)!==Date.parse(prepared.send_at))throw Error('FINAL_STATE_UNCONFIRMED');
        if(!stopping&&await this.templateHash(client,after.template_id)!==templateSha)throw Error('TEMPLATE_CHANGED_DURING_OPERATION');
        return this.store.complete(input.operation_id,after,{campaign:final,user,templateSha});
      }catch(error){this.store.uncertain(input.operation_id,error.code??'UPSTREAM_OUTCOME_UNKNOWN');return{...resultOperation(this.store.operation(input.operation_id,user.id)),message:'Resultado incerto. Consulte este ID; nenhuma repetição automática.'};}
    }catch(error){
      if(error instanceof Refusal){this.store.refusal(user,input?.brand??raw?.brand,name,input?.campaign_id,error);return{refused:true,code:error.code,message:error.message,customer_mutations:0};}
      // No response body, credential or raw exception is sent to a model/log.
      throw Error('CONNECTOR_READ_OR_LEDGER_UNCONFIRMED');
    }
  }
  async create(input,user,client) {
    const draft=validateDraft(input.draft,user),marker='mcp-operation-'+input.operation_id;
    const templateSha=await this.templateHash(client,draft.template_id);
    await this.activeLists(client,draft.lists);
    const prepared=payload(draft,null,{mcp_connector:{id:this.store.meta('connector_id'),operation_id:input.operation_id}},[marker]);
    this.requireAccess('listmonk_draft_create',input,user);
    const claim=this.store.claim({id:input.operation_id,actor:user.id,brand:user.brand,action:'listmonk_draft_create',request:input,prepared});
    if(claim.existing)return resultOperation(this.store.operation(input.operation_id,user.id));
    try{
      identity(this.store.user(user.id),user.brand);this.requireAccess('listmonk_draft_create',input,user);this.store.phase(input.operation_id,'create-draft','POST','/api/campaigns',prepared);
      const created=await client.request('POST','/api/campaigns',prepared);
      if(!Number.isSafeInteger(created?.id)||PROTECTED_IDS.includes(created.id)||typeof created.uuid!=='string')throw Error('CREATION_ID_UNCONFIRMED');
      this.store.acknowledge(input.operation_id,created);
      const remote=await client.get('/api/campaigns/'+created.id),after=this.campaignSnapshot(remote,user,input.operation_id);
      if(remote.uuid!==created.uuid||after.status!=='draft'||after.send_at!==null||contentFingerprint(after)!==contentFingerprint(draft))throw Error('CREATED_STATE_UNCONFIRMED');
      if(await this.templateHash(client,draft.template_id)!==templateSha)throw Error('TEMPLATE_CHANGED_DURING_CREATION');
      return this.store.complete(input.operation_id,after,{campaign:remote,user,templateSha});
    }catch(error){this.store.uncertain(input.operation_id,error.code??'CREATION_OUTCOME_UNKNOWN');return{...resultOperation(this.store.operation(input.operation_id,user.id)),message:'Criação incerta: consulte o ID operacional. Não criar novamente.'};}
  }
  async operation(input,user) {
    const op=this.store.operation(input.operation_id,user.id);if(!op)deny('OPERATION_NOT_FOUND','ID ainda não encontrado. Isso não comprova que nada ocorreu: a preparação pode estar em andamento. Não repita; conserve o ID e confira novamente.');
    const result=resultOperation(op);
    if(op.campaign_id!==null){
      try{const local=this.store.owned(op.campaign_id,user.brand),client=this.clientFor(user);await client.verify(user);const remote=await client.get('/api/campaigns/'+local.id);if(remote.uuid!==local.uuid)throw Error('UUID');result.current_campaign=this.campaignSnapshot(remote,user);result.reconciliation='read-only; no mutation replayed';}catch{result.reconciliation='unconfirmed; no mutation replayed';}
    }
    else if(op.ack_json){
      try{const ack=JSON.parse(op.ack_json),client=this.clientFor(user);await client.verify(user);const remote=await client.get('/api/campaigns/'+ack.id);if(remote.uuid!==ack.uuid)throw Error('ACK_IDENTITY');result.current_campaign={id:ack.id,uuid:ack.uuid,...this.campaignSnapshot(remote,user,op.id)};result.reconciliation='read-only ACK; ownership and uncertain state not promoted';}catch{result.reconciliation='ACK reconciliation unconfirmed; no mutation replayed';}
    }else if(op.action==='listmonk_draft_create'){
      try{
        const client=this.clientFor(user);await client.verify(user);
        const found=await client.get('/api/campaigns?tag=mcp-operation-'+op.id+'&page=1&per_page=2&order_by=created_at&order=ASC');
        if(!Array.isArray(found?.results)||found.results.length!==1||found.total!==1)throw Error('MARKER_AMBIGUOUS');
        const row=found.results[0];if(PROTECTED_IDS.includes(row.id))throw Error('PROTECTED');
        const remote=await client.get('/api/campaigns/'+row.id),saved=this.campaignSnapshot(remote,user,op.id),prepared=JSON.parse(op.request_json).input.draft;
        if(remote.uuid!==row.uuid||remote.attribs?.mcp_connector?.id!==this.store.meta('connector_id')||remote.attribs.mcp_connector.operation_id!==op.id||saved.status!=='draft'||saved.send_at!==null||contentFingerprint(saved)!==contentFingerprint(validateDraft(prepared,user)))throw Error('MARKER_CONTENT');
        result.current_campaign={id:row.id,uuid:row.uuid,...saved};result.reconciliation='unique operation marker, read-only evidence; uncertain state not promoted';
      }catch{result.reconciliation='creation lookup unconfirmed or ambiguous; do not recreate';}
    }
    this.store.audit(user.id,user.brand,'listmonk_operation_get',op.campaign_id,'read',{operationId:op.id,state:op.state});return result;
  }
}
