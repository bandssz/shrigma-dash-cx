import crypto from 'node:crypto';
import {promisify} from 'node:util';
import Provider, {errors,interactionPolicy} from 'oidc-provider';
import {OAuthError,OAuthErrorCode} from '@modelcontextprotocol/server';
import {sha,canonical,deny} from './policy.mjs';

const INTERACTION_MARK=Symbol('oauth.interaction.stage');
const INTERACTION_CODES=Object.freeze({ORIGIN:'ORIGIN',CSRF:'CSRF',ACCOUNT:'ACCOUNT',LOGIN_RATE:'RATE_LIMIT',LOGIN_BUSY:'RATE_LIMIT',INTERACTION_CLIENT_REFUSED:'CLIENT',INTERACTION:'INTERACTION_SESSION',PROMPT:'PROMPT'});
const interactionError=code=>Object.assign(Error(code),{code:'OAUTH_INTERACTION_'+code});
export function interactionRefusalResponse(error,req,res,store){
  if(!req[INTERACTION_MARK])return false;
  const stage=['login','consent'].includes(req[INTERACTION_MARK].stage)?req[INTERACTION_MARK].stage:'unknown';
  let reason='UNKNOWN';try{const code=error?.code;if(typeof code==='string'&&code.startsWith('OAUTH_INTERACTION_')&&Object.hasOwn(INTERACTION_CODES,code.slice(18)))reason=INTERACTION_CODES[code.slice(18)];else if(error instanceof errors.SessionNotFound)reason='INTERACTION_SESSION';else if(error instanceof errors.OIDCProviderError)reason='PROVIDER';else if(['entity.parse.failed','entity.too.large'].includes(error?.type))reason='BODY_FORMAT';else if(['SQLITE_BUSY','SQLITE_LOCKED'].includes(code)||code==='ERR_SQLITE_ERROR'&&[5,6].includes(error?.errcode))reason='STORE_BUSY';}catch{}
  const detail={stage,reason,correlation:crypto.randomUUID()};
  try{store.audit('unauthenticated',null,'oauth_interaction_refused',null,'refused',detail);}catch{try{console.error(JSON.stringify({event:'oauth_interaction_refused',...detail,auditPersisted:false}));}catch{}}
  if(!res.headersSent)res.status(400).set({'Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",'Referrer-Policy':'same-origin','X-Content-Type-Options':'nosniff'}).type('html').send('<!doctype html><meta charset="utf-8"><title>Conexão não concluída</title><p>'+(['INTERACTION_SESSION','CSRF'].includes(reason)?'Esta sessão pode ter expirado ou já ter sido usada. ':'Não foi possível concluir esta sessão. ')+'Volte ao Claude, escolha Conectar e entre novamente.</p><p>Referência: <code>'+stage+'.'+reason+' / '+detail.correlation+'</code></p>');
  return true;
}

const scrypt=promisify(crypto.scrypt);
const DUMMY_HASH='scrypt:'+Buffer.alloc(16).toString('base64')+':'+Buffer.alloc(64).toString('base64');
let passwordChecks=0;
export const SCOPE='mcp:campaigns';
export const CLAUDE_CALLBACK='https://claude.ai/api/mcp/auth_callback';
export async function hashPassword(password) {
  if(typeof password!=='string'||password.length<16||password.length>256)deny('PASSWORD_LENGTH','Senha inicial precisa de16 a256 caracteres.');
  const salt=crypto.randomBytes(16),key=await scrypt(password,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024});
  return 'scrypt:'+salt.toString('base64')+':'+key.toString('base64');
}
export async function checkPassword(password,hash) {
  if(passwordChecks>=2)throw interactionError('LOGIN_BUSY');
  if(typeof password!=='string'||password.length>256)return false;
  const [kind,salt,key,...extra]=String(hash).split(':');
  if(kind!=='scrypt'||extra.length||!salt||!key)return false;
  const expected=Buffer.from(key,'base64');if(expected.length!==64)return false;
  passwordChecks++;
  try{const got=await scrypt(password,Buffer.from(salt,'base64'),64,{N:32768,r:8,p:1,maxmem:64*1024*1024});return crypto.timingSafeEqual(got,expected);}
  finally{passwordChecks--;}
}
export function adapter(store) {
  return class SQLiteAdapter {
    constructor(model){this.model=model;}
    async upsert(id,payload,expiresIn){
      const expires=typeof expiresIn==='number'?Math.floor(Date.now()/1000)+expiresIn:null;
      store.db.prepare('INSERT INTO oauth(model,id,payload,expires_at,consumed_at,grant_id,uid,account_id,user_code) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(model,id) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at,grant_id=excluded.grant_id,uid=excluded.uid,account_id=excluded.account_id,user_code=excluded.user_code').run(this.model,id,JSON.stringify(payload),expires,payload.consumed??null,this.model==='Grant'?id:payload.grantId??null,payload.uid??null,payload.accountId??payload.session?.accountId??payload.result?.login?.accountId??null,payload.userCode??null);
    }
    unpack(row){if(!row||(row.expires_at!==null&&row.expires_at<=Date.now()/1000))return undefined;return{...JSON.parse(row.payload),...(row.consumed_at===null?{}:{consumed:row.consumed_at})};}
    async find(id){return this.unpack(store.db.prepare('SELECT * FROM oauth WHERE model=? AND id=?').get(this.model,id));}
    async findByUid(uid){return this.unpack(store.db.prepare('SELECT * FROM oauth WHERE model=? AND uid=?').get(this.model,uid));}
    async findByUserCode(code){return this.unpack(store.db.prepare('SELECT * FROM oauth WHERE model=? AND user_code=?').get(this.model,code));}
    async consume(id){
      let conflict=false;
      store.tx(()=>{const row=store.db.prepare('SELECT grant_id,consumed_at FROM oauth WHERE model=? AND id=?').get(this.model,id);if(!row)throw new errors.InvalidGrant();if(row.consumed_at!==null){if(row.grant_id)store.db.prepare('DELETE FROM oauth WHERE grant_id=?').run(row.grant_id);conflict=true;}else store.db.prepare('UPDATE oauth SET consumed_at=? WHERE model=? AND id=? AND consumed_at IS NULL').run(Math.floor(Date.now()/1000),this.model,id);});
      if(conflict)throw new errors.InvalidGrant('authorization already consumed');
    }
    async destroy(id){store.db.prepare('DELETE FROM oauth WHERE model=? AND id=?').run(this.model,id);}
    async revokeByGrantId(id){store.db.prepare('DELETE FROM oauth WHERE grant_id=?').run(id);}
  };
}
const escapeHtml = value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function createIdentityProvider({store,origin,clientId,jwks,cookieKeys}) {
  const resource=origin+'/mcp';
  const policy=interactionPolicy.base();
  // A new CRM connection authenticates again through the provider's existing
  // login prompt. Its seven-day SSO cookie must not keep an expired CRM login.
  policy.get('login').checks.add(new interactionPolicy.Check('crm_reauthentication','CRM authentication is required',ctx=>
    !!ctx.oidc.session.accountId&&store.user(ctx.oidc.session.accountId)?.crm===true&&!ctx.oidc.result?.login
  ));
  const provider=new Provider(origin,{
    adapter:adapter(store),jwks,cookies:{keys:cookieKeys},
    clients:[{client_id:clientId,application_type:'web',grant_types:['authorization_code','refresh_token'],response_types:['code'],redirect_uris:[CLAUDE_CALLBACK],token_endpoint_auth_method:'none'}],
    pkce:{required:()=>true},rotateRefreshToken:true,
    issueRefreshToken:(_ctx,client,code)=>client.clientId===clientId&&client.grantTypeAllowed('refresh_token')&&String(code.scope??'').split(' ').includes(SCOPE),
    scopes:['openid','offline_access'],claims:{openid:['sub']},
    features:{devInteractions:{enabled:false},registration:{enabled:false},introspection:{enabled:false},revocation:{enabled:true},resourceIndicators:{enabled:true,defaultResource:()=>resource,useGrantedResource:()=>true,getResourceServerInfo:(_ctx,target,client)=>{if(target!==resource||client.clientId!==clientId)throw new errors.InvalidTarget();return{scope:SCOPE,audience:resource,accessTokenTTL:900,accessTokenFormat:'opaque'};}}},
    ttl:{AccessToken:900,AuthorizationCode:60,Grant:604800,IdToken:900,Interaction:300,RefreshToken:604800,Session:604800},
    interactions:{url:(_ctx,interaction)=>'/interaction/'+interaction.uid,policy},
    findAccount:async(_ctx,id)=>store.user(id)?.active?{accountId:id,claims:async()=>({sub:id})}:undefined,
    renderError:async(ctx)=>{ctx.type='html';ctx.body='<!doctype html><title>Acesso recusado</title><p>Não foi possível autorizar. Volte ao conector e entre novamente.</p>';}
  });
  provider.proxy=true;
  provider.on('server_error',()=>{});
  provider.on('error',()=>{});
  async function verifyAccessToken(raw) {
    const invalid=()=>{throw new OAuthError(OAuthErrorCode.InvalidToken,'Identidade, concessão ou audiência inválida.');};
    const token=await provider.AccessToken.find(raw,{ignoreExpiration:false,ignoreSessionBinding:false});
    if(!token?.isValid||token.clientId!==clientId||token.aud!==resource||!token.accountId||!token.grantId||!Number.isFinite(token.exp))invalid();
    const grant=await provider.Grant.find(token.grantId,{ignoreExpiration:false});
    if(!grant?.isValid||grant.clientId!==clientId||grant.accountId!==token.accountId||!store.user(token.accountId)?.active)invalid();
    const scopes=String(token.scope??'').split(' ').filter(Boolean);
    if(!scopes.includes(SCOPE))invalid();
    return{token:raw,clientId:token.clientId,scopes,expiresAt:token.exp,resource:new URL(resource),extra:{actor:token.accountId,issuer:origin,sub:token.accountId}};
  }
  return{provider,verifyAccessToken,resource};
}
export function mountInteractions(app,{provider,store,origin,clientId,urlencoded,crmLogin}) {
  const html=(res,body)=>res.set({'Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; form-action 'self' https://claude.ai/api/mcp/auth_callback; frame-ancestors 'none'; base-uri 'none'",'Referrer-Policy':'same-origin','X-Content-Type-Options':'nosniff'}).type('html').send('<!doctype html><meta charset="utf-8"><title>CRM Shrigma</title>'+body);
  const details=async(req,res)=>{const d=await provider.interactionDetails(req,res);if(d.uid!==req.params.uid||d.params.client_id!==clientId)throw interactionError('INTERACTION_CLIENT_REFUSED');req[INTERACTION_MARK]={stage:['login','consent'].includes(d.prompt?.name)?d.prompt.name:'unknown'};return d;};
  // The provider validates signed interaction cookies; the form has an additional one-use CSRF token.
  app.get('/interaction/:uid',async(req,res,next)=>{req[INTERACTION_MARK]={stage:'unknown'};try{
    const d=await details(req,res);if(d.uid!==req.params.uid)throw interactionError('INTERACTION');
    const csrf=crypto.randomBytes(32).toString('base64url');store.db.prepare('INSERT INTO csrf VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET token_sha=excluded.token_sha,expires_at=excluded.expires_at').run(d.uid,sha(csrf),Date.now()+300000);
    const hidden='<input type="hidden" name="csrf" value="'+csrf+'">';
    if(d.prompt.name==='login')return html(res,'<h1>Entrar no CRM</h1><form method="post">'+hidden+'<label>E-mail <input name="login" type="email" required autocomplete="username"></label><label>Senha <input name="password" type="password" required autocomplete="current-password"></label><button>Entrar</button></form>');
    if(d.prompt.name==='consent'){
      const user=store.user(d.session?.accountId);if(!user?.active)throw interactionError('ACCOUNT');
      return html(res,'<h1>Conectar ao Claude</h1><p>'+escapeHtml(user.login)+' · '+escapeHtml(user.brand)+'</p><p>Permitir as operações de campanha da sua marca. O serviço aplica as travas e registra cada ação.</p><form method="post">'+hidden+'<button>Permitir acesso</button></form>');
    }
    throw interactionError('PROMPT');
  }catch(error){next(error);}});
  app.post('/interaction/:uid',(req,_res,next)=>{req[INTERACTION_MARK]={stage:'unknown'};next();},urlencoded,async(req,res,next)=>{try{
    if(req.get('origin')!==origin)throw interactionError('ORIGIN');const d=await details(req,res);if(d.uid!==req.params.uid)throw interactionError('INTERACTION');
    store.tx(()=>{const c=store.db.prepare('SELECT * FROM csrf WHERE id=?').get(d.uid);if(!c||c.expires_at<Date.now()||typeof req.body?.csrf!=='string'||c.token_sha!==sha(req.body.csrf))throw interactionError('CSRF');store.db.prepare('DELETE FROM csrf WHERE id=?').run(d.uid);});
    if(d.prompt.name==='login'){
      const login=String(req.body.login??'').toLowerCase(),now=Date.now();
      store.tx(()=>{for(const [key,limit] of [['ip:'+sha(req.ip),20],['login:'+sha(login),5]]){
        const row=store.db.prepare('SELECT * FROM login_attempts WHERE key=?').get(key);if(row&&row.until>now&&row.attempts>=limit)throw interactionError('LOGIN_RATE');
        store.db.prepare('INSERT INTO login_attempts VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN until<? THEN 1 ELSE attempts+1 END,until=CASE WHEN until<? THEN? ELSE until END').run(key,1,now+900000,now,now,now+900000);
      }});
      const entry=store.loginUser(login);
      let valid=false;
      if(entry?.user.active&&entry.user.crm===true&&typeof crmLogin==='function'){try{const crm=await crmLogin({login,password:req.body.password,brand:entry.user.brand});store.db.prepare('UPDATE analysts SET credential=? WHERE id=? AND active=1').run(store.seal({crm},entry.user.id),entry.user.id);valid=true;}catch{}}
      else valid=await checkPassword(req.body.password,entry?.hash??DUMMY_HASH);
      req.body.password='';
      if(!entry?.user.active||!valid){store.audit('unauthenticated',null,'oauth_login',null,'refused',{loginSha:sha(login)});return html(res.status(401),'<p>Acesso recusado. Reinicie a conexão e confira sua identificação.</p>');}
      store.audit(entry.user.id,entry.user.brand,'oauth_login',null,'succeeded',{});
      return await provider.interactionFinished(req,res,{login:{accountId:entry.user.id}},{mergeWithLastSubmission:false});
    }
    if(d.prompt.name==='consent'){
      const user=store.user(d.session?.accountId);if(!user?.active)throw interactionError('ACCOUNT');
      const grant=d.grantId?await provider.Grant.find(d.grantId):new provider.Grant({accountId:user.id,clientId:d.params.client_id});
      const oidcScopes=(d.prompt.details.missingOIDCScope??[]).filter(s=>['openid','offline_access'].includes(s));
      if(oidcScopes.length)grant.addOIDCScope(oidcScopes.join(' '));
      grant.addResourceScope(origin+'/mcp',SCOPE);
      const grantId=await grant.save();return await provider.interactionFinished(req,res,{consent:{grantId}},{mergeWithLastSubmission:true});
    }
    throw interactionError('PROMPT');
  }catch(error){next(error);}});
}
