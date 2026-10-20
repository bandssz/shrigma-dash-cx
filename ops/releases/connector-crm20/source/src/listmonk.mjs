import {deny, canonical} from './policy.mjs';

export const API_PERMISSIONS = Object.freeze(['campaigns:get','campaigns:manage','campaigns:send','subscribers:get','templates:get']);
export class UpstreamError extends Error {
  constructor(code, status=null) {super(code);this.code=code;this.status=status;}
}
export function verifyProfile(profile, user, username) {
  const role=profile?.user_role, listRole=profile?.list_role;
  if (!profile || profile.id!==user.apiUserId || profile.username!==username || profile.type!=='api' || profile.status!=='enabled' || (profile.password!==undefined && profile.password!==null && profile.password!=='')) deny('API_IDENTITY_MISMATCH','A credencial não corresponde ao usuário API individual admitido.');
  if (!role || !Number.isSafeInteger(role.id) || role.id<=1 || !Array.isArray(role.permissions) || canonical([...role.permissions].sort())!==canonical([...API_PERMISSIONS].sort())) process.emitWarning('O papel API difere do conjunto mínimo; confira os privilégios no Listmonk.',{code:'API_PERMISSIONS_NOT_MINIMAL'});
  if (!listRole || !Number.isSafeInteger(listRole.id) || !Array.isArray(listRole.lists) || canonical(listRole.lists.map(x=>x.id).sort((a,b)=>a-b))!==canonical([...user.listIds].sort((a,b)=>a-b)) || listRole.lists.some(x=>canonical(x.permissions)!==canonical(['list:get']))) process.emitWarning('O papel de listas difere das listas admitidas; confira o vínculo no Listmonk.',{code:'API_LIST_ROLE_MISMATCH'});
  return true;
}
export class Listmonk {
  constructor({origin,environment,credentials,fetcher=fetch,timeoutMs=10000}) {
    const u=new URL(origin);
    if(u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('UPSTREAM_ORIGIN_REFUSED');
    if(environment==='production'&&u.origin!=='https://email.shrigma.com.br')throw Error('PRODUCTION_ORIGIN_REFUSED');
    if(environment==='test'&&!((u.protocol==='http:')&&['127.0.0.1','localhost','listmonk-fixture','listmonk-isolated'].includes(u.hostname)))throw Error('TEST_ORIGIN_REFUSED');
    this.origin=u.origin;this.credentials=credentials;this.fetcher=fetcher;this.timeoutMs=timeoutMs;
  }
  async request(method,route,body) {
    if(!['GET','POST','PUT'].includes(method) || !/^\/api\/(?:profile|lists\/[1-9]\d*|templates\/[1-9]\d*|subscribers\/[1-9]\d*|campaigns(?:\/[1-9]\d*(?:\/(?:status|test))?)?)(?:\?[^#]*)?$/.test(route))throw Error('UPSTREAM_ROUTE_REFUSED');
    if(method!=='GET'&&!/^\/api\/campaigns(?:\/[1-9]\d*(?:\/(?:status|test))?)?$/.test(route))throw Error('UPSTREAM_MUTATION_REFUSED');
    const credential=await this.credentials();
    if(typeof credential.username!=='string'||!credential.username||typeof credential.token!=='string'||!credential.token||/[\r\n:]/.test(credential.username)||/[\r\n]/.test(credential.token))throw Error('INDIVIDUAL_CREDENTIAL_REQUIRED');
    let response;
    try {
      response=await this.fetcher(this.origin+route,{method,redirect:'error',credentials:'omit',signal:AbortSignal.timeout(this.timeoutMs),headers:{Authorization:'Basic '+Buffer.from(credential.username+':'+credential.token).toString('base64'),Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
      if(!response.ok){await response.body?.cancel();throw new UpstreamError('LISTMONK_HTTP_'+response.status,response.status);}
      if(!String(response.headers.get('content-type')).toLowerCase().startsWith('application/json'))throw new UpstreamError('LISTMONK_RESPONSE_UNCONFIRMED');
      const reader=response.body.getReader(),parts=[];let size=0;
      for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>1500000){await reader.cancel();throw new UpstreamError('LISTMONK_RESPONSE_LIMIT');}parts.push(value);}
      const parsed=JSON.parse(Buffer.concat(parts).toString('utf8'));
      if(!Object.hasOwn(parsed,'data'))throw new UpstreamError('LISTMONK_RESPONSE_UNCONFIRMED');
      return parsed.data;
    }catch(error){if(error instanceof UpstreamError)throw error;throw new UpstreamError('LISTMONK_OUTCOME_UNCONFIRMED');}
    finally{credential.token='';}
  }
  get(route){return this.request('GET',route);}
  async verify(user) {const c=await this.credentials();try{return verifyProfile(await this.get('/api/profile'),user,c.username);}finally{c.token='';}}
}
