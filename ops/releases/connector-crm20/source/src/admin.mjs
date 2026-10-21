import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {z} from 'zod';
import {settings,initialize} from './config.mjs';
import {BRANDS,INTERNAL_DOMAINS,mailbox,canonical,sha,deny,Refusal} from './policy.mjs';
import {hashPassword} from './auth.mjs';
import {Listmonk} from './listmonk.mjs';

const ids=z.array(z.number().int().positive()).min(1).max(100).refine(x=>new Set(x).size===x.length);
const brandSchema=z.strictObject({listIds:ids,templateIds:ids,fromEmails:z.array(z.string()).min(1).max(20),replyToEmails:z.array(z.string()).min(1).max(20),testRecipients:z.record(z.string(),z.number().int().positive())});
const policySchema=z.strictObject({aristo:brandSchema,fish:brandSchema});
const analystSchema=z.strictObject({login:z.email().max(254),brand:z.enum(['aristo','fish']),password:z.string().min(16).max(256),apiUserId:z.number().int().min(2),username:z.string().min(1).max(100),token:z.string().min(16).max(512),listIds:ids});
export function policy(store){const p=store.meta('brand_policy');if(!p)deny('BRAND_POLICY_MISSING','Catálogo de marcas ainda não configurado pelo proprietário.');return JSON.parse(p);}
function sanitizeUser(user){const{id,login,brand,active,apiUserId,listIds}=user;return{id,login,brand,active,apiUserId,listIds,...(user.crm===true?{operator:'crm'}:{})};}
export function mountAdmin(app,{store,secret,config,service,json}){
  app.use('/owner',(req,res,next)=>{
    const value=req.get('authorization')??'',expected=Buffer.from(secret.adminSha,'hex'),got=Buffer.from(sha(value.startsWith('Bearer ')?value.slice(7):''),'hex');
    if(!crypto.timingSafeEqual(expected,got))return res.status(401).json({error:'OWNER_AUTH_REQUIRED'});
    res.set('Cache-Control','no-store');next();
  });
  app.get('/owner/status',(_req,res)=>res.json({environment:config.environment,ledger_id:store.meta('ledger_id'),connector_id:store.meta('connector_id'),business_enabled:store.businessEnabled,smtp_confirmed:service.smtpConfirmed,internal_access:service.internalAccess,brand_policy_configured:!!store.meta('brand_policy'),audit_head:store.db.prepare('SELECT sha FROM audit ORDER BY seq DESC LIMIT 1').get()?.sha??null,uncertain_or_running:store.db.prepare('SELECT count(*) n FROM locks').get().n,analysts:store.db.prepare('SELECT id FROM analysts').all().map(x=>sanitizeUser(store.user(x.id)))}));
  const action=(handler)=>async(req,res)=>{try{res.json(await handler(req.body));}catch(error){const code=error instanceof Refusal?error.code:'OWNER_INPUT_OR_UPSTREAM_UNCONFIRMED';store.audit('administrator',null,'owner_request',null,'refused',{code});res.status(400).json({error:code,message:error instanceof Refusal?error.message:'Nenhuma repetição automática; confira a operação e a configuração.'});}};
  app.post('/owner/brand-policy',json,action(async raw=>{
    if(store.meta('brand_policy'))deny('BRAND_POLICY_ALREADY_SET','Catálogo já fixado; não sobrescrever por tentativa.');
    const p=policySchema.parse(raw),seen=new Set();
    for(const[brand,b]of Object.entries(p)){
      for(const id of b.listIds){if(seen.has(id))deny('CROSS_BRAND_LIST','Uma lista não pode pertencer às duas marcas.');seen.add(id);}
      b.fromEmails=b.fromEmails.map(x=>mailbox(x));b.replyToEmails=b.replyToEmails.map(x=>mailbox(x));
      if(b.fromEmails.some(x=>x.split('@')[1]!==BRANDS[brand])||b.replyToEmails.some(x=>x.split('@')[1]!==BRANDS[brand]))deny('BRAND_ADDRESS_REFUSED','Remetente e Reply-To precisam do domínio raiz da marca.');
      for(const email of Object.keys(b.testRecipients))if(mailbox(email)!==email||!INTERNAL_DOMAINS.includes(email.split('@')[1]))deny('TEST_REGISTRY_REFUSED','Registro de testes admite somente endereços internos normalizados.');
    }
    store.tx(()=>{store.setMeta('brand_policy',canonical(p));store.audit('administrator',null,'brand_policy_initialize',null,'succeeded',{policy:p});});return{configured:true};
  }));
  app.post('/owner/analysts',json,action(async raw=>{
    const a=analystSchema.parse(raw),b=policy(store)[a.brand];
    if(a.listIds.some(id=>!b.listIds.includes(id)))deny('LIST_BRAND_FORBIDDEN','Listas fora da marca.');
    const binding={apiUserId:a.apiUserId,listIds:a.listIds,templateIds:b.templateIds,fromEmails:b.fromEmails,replyToEmails:b.replyToEmails,testRecipients:b.testRecipients};
    const credential={username:a.username,token:a.token},candidate={...binding,brand:a.brand};
    const client=new Listmonk({origin:config.upstream,environment:config.environment,credentials:()=>({...credential})});
    await client.verify(candidate);
    for(const id of binding.listIds){const list=await client.get('/api/lists/'+id);if(list?.id!==id||list.status!=='active')deny('LIST_UNCONFIRMED','Lista precisa existir e estar ativa.');}
    for(const id of binding.templateIds){const t=await client.get('/api/templates/'+id);if(t?.id!==id||t.type!=='campaign')deny('TEMPLATE_UNCONFIRMED','Template de campanha não confirmado.');}
    const user=store.addUser({login:a.login.toLowerCase(),brand:a.brand,passwordHash:await hashPassword(a.password),credential,...binding});
    a.token='';a.password='';credential.token='';return{analyst:sanitizeUser(user)};
  }));
  app.post('/owner/analyst-credential',json,action(async raw=>{
    const p=z.strictObject({id:z.uuid(),apiUserId:z.number().int().min(2),username:z.string().min(1).max(100),token:z.string().min(16).max(512)}).parse(raw);
    const user=store.user(p.id);
    if(!user?.active||user.crm===true)deny('API_ANALYST_REQUIRED','Selecione a identidade API ativa existente.');
    const credential={username:p.username,token:p.token},candidate={...user,apiUserId:p.apiUserId};
    const client=new Listmonk({origin:config.upstream,environment:config.environment,credentials:()=>({...credential})});
    await client.verify(candidate);
    const previous=new Listmonk({origin:config.upstream,environment:config.environment,credentials:()=>store.credentials(p.id)});
    const before=await previous.get('/api/profile'),after=await client.get('/api/profile');
    if(canonical(before.user_role)!==canonical(after.user_role)||canonical(before.list_role)!==canonical(after.list_role))deny('API_ROLE_CHANGED','A nova chave precisa conservar os mesmos papéis e listas.');
    const row=store.db.prepare('SELECT config FROM analysts WHERE id=? AND active=1').get(p.id),binding=JSON.parse(row.config);
    binding.apiUserId=p.apiUserId;
    store.tx(()=>{
      store.db.prepare('UPDATE analysts SET config=?,credential=? WHERE id=? AND active=1').run(canonical(binding),store.seal(credential,p.id),p.id);
      store.audit('administrator',user.brand,'analyst_credential_update',null,'succeeded',{analystId:p.id,previousApiUserId:user.apiUserId,apiUserId:p.apiUserId});
    });
    p.token='';credential.token='';return{analyst:sanitizeUser(store.user(p.id)),credential_updated:true};
  }));
  app.post('/owner/crm-analysts',json,action(async raw=>{
    const a=z.strictObject({login:z.email(),brand:z.enum(['aristo','fish'])}).parse(raw);
    // This sprint enrolls only the two existing QA editor identities. Their
    // own CRM login, during OAuth, supplies the encrypted session later.
    if(a.login!=='editor-qa-'+a.brand+'@shrigma.com.br')deny('CRM_QA_ENROLLMENT_ONLY','A abertura das demais contas aguarda o aceite de Felipe.');
    const user=store.addUser({login:a.login,brand:a.brand,passwordHash:'CRM_LOGIN',credential:{},crm:true,apiUserId:null,listIds:[],templateIds:[],fromEmails:[],replyToEmails:[],testRecipients:{}});
    return{analyst:sanitizeUser(user),connectionRequired:true};
  }));
  app.post('/owner/revoke',json,action(async raw=>{const{id}=z.strictObject({id:z.uuid()}).parse(raw);store.revoke(id);return{revoked:true,id,listmonk_key_revocation:'Revogar também o usuário API correspondente no Listmonk; o conector já recusa imediatamente.'};}));
  app.post('/owner/internal-test-enable',json,action(async raw=>{
    const confirmation=z.strictObject({owner_assertion:z.literal('SMTP_NATURAL_OBSERVATION_CONFIRMED'),observed_at:z.iso.datetime({offset:true}),evidence_sha256:z.string().regex(/^[a-f0-9]{64}$/)});
    const p=z.strictObject({ledger_id:z.uuid(),audit_head:z.string().regex(/^[a-f0-9]{64}$/),owner_approval:z.literal('SOMENTE_TESTE_INTERNO_APROVADO'),expires_at:z.iso.datetime({offset:true}),grants:z.array(z.strictObject({actor_id:z.uuid(),brand:z.enum(['aristo','fish']),self_email:z.email().max(254),self_subscriber_id:z.number().int().positive().optional()})).min(1).max(2),smtp_confirmation:confirmation.optional()}).parse(raw);
    if(config.environment!=='production'||store.businessEnabled)deny('INTERNAL_ACCESS_REFUSED','Esta liberação exige produção com envio comercial bloqueado.');
    const head=store.db.prepare('SELECT sha FROM audit ORDER BY seq DESC LIMIT 1').get()?.sha;
    if(p.ledger_id!==store.meta('ledger_id')||p.audit_head!==head||store.db.prepare('SELECT count(*) n FROM locks').get().n!==0)deny('LEDGER_REVIEW_REQUIRED','Ledger mudou ou há operação incerta; nenhuma liberação.');
    const grant=await service.prepareInternalAccess(p.grants,p.expires_at),observed=p.smtp_confirmation?Date.parse(p.smtp_confirmation.observed_at):null;
    if(observed!==null&&observed>service.now())deny('SMTP_EVIDENCE_REFUSED','A confirmação SMTP precisa vir de uma observação natural já realizada.');
    if(p.audit_head!==store.db.prepare('SELECT sha FROM audit ORDER BY seq DESC LIMIT 1').get()?.sha||store.db.prepare('SELECT count(*) n FROM locks').get().n!==0)deny('LEDGER_REVIEW_REQUIRED','Ledger mudou durante a validação; nenhuma liberação.');
    policy(store);store.audit('administrator',null,'internal_test_access_enable',null,'succeeded',{ledgerId:p.ledger_id,grant,smtpConfirmation:p.smtp_confirmation??null,businessEnabled:false});
    service.internalAccess=grant;service.smtpConfirmed=!!p.smtp_confirmation;
    return{internal_access_until_process_restart:true,expires_at:grant.expiresAt,business_enabled:false,smtp_confirmed:service.smtpConfirmed,commercial_actions_enabled:false};
  }));
  app.post('/owner/enable',json,action(async raw=>{
    const p=z.strictObject({ledger_id:z.uuid(),audit_head:z.string().length(64),owner_approval:z.literal('PRIMEIRO_USO_REAL_APROVADO'),smtp_evidence:z.string().min(20).max(500)}).parse(raw);
    if(config.environment!=='production')deny('PRODUCTION_ONLY','Ativação real só existe no ambiente de produção.');
    const head=store.db.prepare('SELECT sha FROM audit ORDER BY seq DESC LIMIT 1').get()?.sha;
    if(p.ledger_id!==store.meta('ledger_id')||p.audit_head!==head||store.db.prepare('SELECT count(*) n FROM locks').get().n!==0)deny('LEDGER_REVIEW_REQUIRED','Ledger mudou ou há operação incerta; nenhuma ativação.');
    policy(store);store.audit('administrator',null,'first_real_use_enable',null,'succeeded',{ledgerId:p.ledger_id,smtpEvidence:p.smtp_evidence});service.smtpConfirmed=true;store.businessEnabled=true;return{enabled_until_process_restart:true};
  }));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{if(process.argv[2]!=='initialize')throw Error('COMMAND_REFUSED');initialize(settings(),process.env.OWNER_TOKEN,process.env.OWNER_PUBLIC_KEY);console.log(JSON.stringify({initialized:true,secrets_printed:false}));}catch{console.error('INITIALIZATION_REFUSED');process.exitCode=1;}
}
