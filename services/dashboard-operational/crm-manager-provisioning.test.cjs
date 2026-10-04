'use strict';
// Every request is an EventEmitter fixture. No socket, environment or database.
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),crypto=require('node:crypto');
const {createProvisioningClient,ProvisioningError,MANAGEMENT_ORIGIN,PATHS,POLICY,REQUEST_SCHEMA,RECEIPT_SCHEMA,STATUS_SCHEMA,ERROR_SCHEMA,MAX_RESPONSE,TIMEOUT_MS}=require('./crm-manager-provisioning.cjs');
const NOW=1790956800000;
const id=n=>'123e4567-e89b-42d3-a456-'+String(n).padStart(12,'0');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}':JSON.stringify(value);
const managerBearer='SYNTHETIC_MANAGER_BEARER_NEVER_TRANSMITTED';
const input=(n=1)=>({operationId:id(n),userId:id(10),lifecycleId:id(20),owner:'gestor@synthetic.invalid',principalId:'dcrm-'+'a'.repeat(32),keySha256:sha(managerBearer)});
const revoke=(n=4)=>({operationId:id(n),userId:id(10),lifecycleId:id(20),owner:'gestor@synthetic.invalid'});
function responseReceipt(request){
 const base={schema:RECEIPT_SCHEMA,issuerId:request.issuerId,namespaceId:request.namespaceId,operationId:request.operationId,action:request.action,requestSha256:sha(canonical(request)),userId:request.userId,lifecycleId:request.lifecycleId,owner:request.owner};
 if(request.action==='revoke_read')return {...base,state:'revoked',revocationMode:'lifecycle',allGenerationsRevoked:true,effectiveAt:NOW,revokedCount:2};
 const issuedAt=request.issuedAt??NOW;
 return {...base,state:request.action==='commit_read'?'committed':'prepared',principalId:request.principalId,generation:request.generation,expectedGeneration:request.expectedGeneration,area:'growth',slot:'crm-panel-read',role:'manager',caps:[...POLICY.caps],issuedAt,candidateExpiresAt:issuedAt+POLICY.candidateTtlMs,expiresAt:issuedAt+POLICY.lifetimeMs,...(request.action==='commit_read'?{prepareOperationId:request.prepareOperationId,committedAt:issuedAt+100,revokedGeneration:request.expectedGeneration===0?null:request.expectedGeneration}:{})};
}
function fixture(handler=({body})=>({value:responseReceipt(body)}),extra={}){
 const calls=[];
 const requestImpl=(url,options,callback)=>{
  const request=new EventEmitter();request.destroy=()=>{request.destroyed=true;};request.setTimeout=(ms,fn)=>{request.timeoutMs=ms;request.timeout=fn;};
  request.end=wire=>{
   const call={url,options,wire,body:JSON.parse(wire),request};calls.push(call);
   queueMicrotask(async()=>{
    let result;try{result=await handler(call);}catch(error){request.emit('error',error);return;}
    if(result?.timeout){request.timeout();return;}
    if(result?.silence)return;
    const value=result?.value??responseReceipt(call.body),bytes=result?.bytes??Buffer.from(JSON.stringify(value)),response=new EventEmitter();
    call.response=response;response.statusCode=result?.status??200;response.headers={'content-type':'application/json; charset=utf-8',...(result?.headers||{})};
    if(result?.rawHeaders)response.rawHeaders=result.rawHeaders;
    response.destroy=()=>{response.destroyed=true;};callback(response);
    if(response.destroyed)return;
    for(const chunk of result?.chunks??[bytes])response.emit('data',chunk);
    if(result?.aborted)response.emit('aborted');else response.emit('end');
    response.emit('close');
   });
  };
  return request;
 };
 const client=createProvisioningClient({issuerId:id(90),namespaceId:id(91),allowedEmailDomains:['synthetic.invalid'],provisionerToken:'SERVICE_FIXTURE_'.repeat(4),requestImpl,now:()=>NOW,...extra});
 return {client,calls,requestImpl};
}
const rejected=(code,uncertain)=>error=>error instanceof ProvisioningError&&error.code===code&&(uncertain===undefined||error.uncertain===uncertain);

test('fixed HTTPS RPC prepares and commits CRM read with digest and private service auth',async()=>{
 const {client,calls}=fixture(),prepared=await client.prepareRead(input());
 assert.equal(prepared.state,'prepared');assert.ok(Object.isFrozen(prepared));assert.ok(Object.isFrozen(prepared.caps));assert.equal(Object.hasOwn(prepared,'requestSha256'),false);
 const descriptor=client.describeCommit({operationId:id(2),prepared});assert.equal(descriptor.args.keySha256,sha(managerBearer));
 const committed=await client.commitRead({operationId:id(2),prepared});assert.equal(committed.state,'committed');assert.equal(committed.revokedGeneration,null);assert.equal(committed.expiresAt,NOW+POLICY.lifetimeMs);
 assert.equal(calls[0].url,MANAGEMENT_ORIGIN+PATHS.prepare_read);assert.equal(calls[1].url,MANAGEMENT_ORIGIN+PATHS.commit_read);
 for(const call of calls){assert.equal(call.options.rejectUnauthorized,true);assert.equal(call.options.agent,false);assert.equal(call.options.method,'POST');assert.match(call.options.headers.Authorization,/^CRM-Provisioner /);assert.equal(call.request.timeoutMs,TIMEOUT_MS);assert.equal(call.body.schema,REQUEST_SCHEMA);assert.equal(call.body.area,'growth');assert.equal(call.body.role,'manager');assert.equal(call.body.slot,'crm-panel-read');assert.deepEqual(call.body.caps,POLICY.caps);assert.equal(call.wire.includes(managerBearer),false);assert.equal(Object.hasOwn(call.body,'bearer'),false);}
});

test('renewal binds generation CAS and atomically revoked predecessor receipt',async()=>{
 const {client,calls}=fixture(),args={...input(),generation:4,expectedGeneration:3},prepared=await client.prepareRenewalRead(args);
 const committed=await client.commitRead({operationId:id(2),prepared});assert.equal(committed.revokedGeneration,3);assert.equal(calls[0].body.action,'renew_read');assert.equal(calls[1].body.expectedGeneration,3);
});

test('no automatic bootstrap/admin adoption or write preparation input',()=>{
 const {client,calls}=fixture();assert.throws(()=>client.prepareEdit({bearer:managerBearer}),rejected('EDIT_NOT_READY'));
 for(const key of ['bearer','masterKey','password','area','role','caps','slot','issuerId','namespaceId','lifetimeMs','candidateTtlMs','sql','url','endpoint','callback'])assert.throws(()=>client.prepareRead({...input(),[key]:managerBearer}),rejected('PROVISIONING_INPUT_INVALID'));
 assert.equal(calls.length,0);
});

test('closed canonical owner UUID digest principal and generation validation before transport',()=>{
 const {client,calls}=fixture();
 for(const owner of ['Gestor@synthetic.invalid',' gestor@synthetic.invalid','gestor@synthetic.invalid\n','gestor@synthetic.invalid.evil','gestor@synthetíc.invalid','a'.repeat(65)+'@synthetic.invalid','gestor@@synthetic.invalid'])assert.throws(()=>client.prepareRead({...input(),owner}),rejected('PROVISIONING_INPUT_INVALID'));
 for(const operationId of [id(1).toUpperCase(),id(1)+'\r','not-a-uuid',null,{},1])assert.throws(()=>client.prepareRead({...input(),operationId}),rejected('PROVISIONING_INPUT_INVALID'));
 for(const keySha256 of ['a'.repeat(63),'a'.repeat(65),'A'.repeat(64),'g'.repeat(64),managerBearer])assert.throws(()=>client.prepareRead({...input(),keySha256}),rejected('PROVISIONING_INPUT_INVALID'));
 for(const principalId of ['dcrm-'+'A'.repeat(32),id(30),'dcrm-'+'a'.repeat(31)])assert.throws(()=>client.prepareRead({...input(),principalId}),rejected('PROVISIONING_INPUT_INVALID'));
 for(const pair of [[1,0],[0,0],[3,1],[-1,-2],[1.5,.5],[1000000000,999999999],[NaN,1]])assert.throws(()=>client.prepareRenewalRead({...input(),generation:pair[0],expectedGeneration:pair[1]}),rejected('PROVISIONING_INPUT_INVALID'));
 const accessor={...input()};Object.defineProperty(accessor,'owner',{enumerable:true,get(){throw Error('SHOULD_NOT_RUN');}});assert.throws(()=>client.prepareRead(accessor),rejected('PROVISIONING_INPUT_INVALID'));
 assert.throws(()=>client.prepareRead(Object.assign(Object.create(null),input())),rejected('PROVISIONING_INPUT_INVALID'));assert.equal(calls.length,0);
});

test('invalid options fail closed without reading environment or requesting transport',()=>{
 const base={issuerId:id(90),namespaceId:id(91),allowedEmailDomains:['synthetic.invalid'],provisionerToken:'x'.repeat(43)};
 for(const options of [null,undefined,{}, {...base,endpoint:MANAGEMENT_ORIGIN}, {...base,issuerId:{}}, {...base,namespaceId:'bad'}, {...base,provisionerToken:'raw\nsecret'}, {...base,allowedEmailDomains:['Synthetic.invalid']}, {...base,allowedEmailDomains:['synthetic.invalid','synthetic.invalid']}, {...base,allowedEmailDomains:['synthetic.invalid.evil/']}, {...base,now:0}, {...base,requestImpl:null}])assert.throws(()=>createProvisioningClient(options),rejected('PROVISIONING_CONFIGURATION_INVALID'));
});

test('invalid clock refuses mutation and status before transport without raw exception data',async()=>{
 for(const now of [()=>NaN,()=>-1,()=>Infinity,()=>{throw Error(managerBearer);}]){const {client,calls}=fixture(undefined,{now});await assert.rejects(client.prepareRead(input()),rejected('PROVISIONING_CLOCK_INVALID'));await assert.rejects(client.operationStatus(client.describeRead(input())),rejected('PROVISIONING_CLOCK_INVALID'));assert.equal(calls.length,0);}
});

test('receipt binds scope subject generation policy digest principal and expiry',async()=>{
 const mutations=[r=>r.namespaceId=id(92),r=>r.issuerId=id(92),r=>r.operationId=id(92),r=>r.userId=id(92),r=>r.lifecycleId=id(92),r=>r.owner='other@synthetic.invalid',r=>r.requestSha256='a'.repeat(64),r=>r.principalId='dcrm-'+'b'.repeat(32),r=>r.generation=2,r=>r.expectedGeneration=1,r=>r.area='influs',r=>r.role='master',r=>r.slot='growth-read',r=>r.caps=['read_content','draft'],r=>r.caps=['read_content','read_content','submission'],r=>r.candidateExpiresAt++,r=>r.expiresAt++,r=>r.issuedAt=NOW+31000,r=>r.bearer=managerBearer,r=>r.error={body:managerBearer}];
 for(const mutate of mutations){const {client}=fixture(({body})=>{const r=responseReceipt(body);mutate(r);return {value:r};});await assert.rejects(client.prepareRead(input()),rejected('PROVISIONING_RECEIPT_INVALID',true));}
});

test('commit requires verified proof from the same client and rejects expired candidate before I/O',async()=>{
 let clock=NOW;const {client,calls}=fixture(undefined,{now:()=>clock}),prepared=await client.prepareRead(input());
 assert.throws(()=>client.commitRead({operationId:id(2),prepared:JSON.parse(JSON.stringify(prepared))}),rejected('PROVISIONING_PREPARED_PROOF_REQUIRED'));
 const other=fixture().client;assert.throws(()=>other.commitRead({operationId:id(2),prepared}),rejected('PROVISIONING_PREPARED_PROOF_REQUIRED'));
 clock=prepared.candidateExpiresAt;await assert.rejects(client.commitRead({operationId:id(2),prepared}),rejected('PROVISIONING_CANDIDATE_EXPIRED'));assert.equal(calls.length,1);
});

test('commit receipts must retain prepared dates and prove exact predecessor revocation',async()=>{
 const mutations=[r=>r.prepareOperationId=id(88),r=>r.revokedGeneration=null,r=>r.committedAt=r.candidateExpiresAt,r=>{r.issuedAt++;r.candidateExpiresAt++;r.expiresAt++;},r=>r.state='prepared'];
 for(const mutate of mutations){const {client}=fixture(({body})=>{const r=responseReceipt(body);if(body.action==='commit_read')mutate(r);return {value:r};});const prepared=await client.prepareRenewalRead({...input(),generation:2,expectedGeneration:1});await assert.rejects(client.commitRead({operationId:id(2),prepared}),rejected('PROVISIONING_RECEIPT_INVALID',true));}
});

test('same operation ID cannot change action payload owner or lifecycle before I/O',async()=>{
 const {client,calls}=fixture();await client.prepareRead(input());
 for(const change of [{owner:'other@synthetic.invalid'},{lifecycleId:id(21)},{keySha256:sha('different')},{principalId:'dcrm-'+'b'.repeat(32)}])await assert.rejects(async()=>client.prepareRead({...input(),...change}),rejected('PROVISIONING_IDEMPOTENCY_CONFLICT'));
 await assert.rejects(async()=>client.revokeRead(revoke(1)),rejected('PROVISIONING_IDEMPOTENCY_CONFLICT'));assert.equal(calls.length,1);
});

test('in-flight identical operations coalesce and caller mutation cannot change binding',async()=>{
 let release;const blocked=new Promise(resolve=>{release=resolve;});const {client,calls}=fixture(async({body})=>{await blocked;return {value:responseReceipt(body)};});
 const args=input(),first=client.prepareRead(args),second=client.prepareRead(input());args.owner='other@synthetic.invalid';args.keySha256=sha('different');release();const [a,b]=await Promise.all([first,second]);assert.equal(a,b);assert.equal(calls.length,1);assert.equal(a.owner,'gestor@synthetic.invalid');
});

test('replayed valid-looking receipt cannot extend expiry or change issuance',async()=>{
 let count=0;const {client,calls}=fixture(({body})=>{const r=responseReceipt(body);if(count++){r.issuedAt+=1000;r.candidateExpiresAt+=1000;r.expiresAt+=1000;}return {value:r};});
 await client.prepareRead(input());await assert.rejects(client.prepareRead(input()),rejected('PROVISIONING_REPLAY_RECEIPT_CHANGED',true));assert.equal(calls.length,2);
});

test('valid replay keeps original dates and binds unchanged payload',async()=>{
 const {client,calls}=fixture();const first=await client.prepareRead(input()),second=await client.prepareRead(input());assert.deepEqual(first,second);assert.equal(calls[0].wire,calls[1].wire);
});

test('uncertain transport failure retries same persisted operation and digest',async()=>{
 let count=0;const {client,calls}=fixture(({body})=>{if(!count++)throw Error('RAW_SECRET_'+managerBearer);return {value:responseReceipt(body)};});
 await assert.rejects(client.prepareRead(input()),rejected('PROVISIONING_TRANSPORT_UNAVAILABLE',true));await client.prepareRead(input());assert.equal(calls.length,2);assert.equal(calls[0].wire,calls[1].wire);
});

test('revoke requires lifecycle tombstone and blocks this client from late commit',async()=>{
 const {client,calls}=fixture(),prepared=await client.prepareRead(input()),r=await client.revokeRead(revoke());assert.equal(r.revocationMode,'lifecycle');assert.equal(r.allGenerationsRevoked,true);
 await assert.rejects(client.commitRead({operationId:id(2),prepared}),rejected('PROVISIONING_LIFECYCLE_REVOKED'));await assert.rejects(client.prepareRead({...input(5)}),rejected('PROVISIONING_LIFECYCLE_REVOKED'));assert.equal(calls.length,2);
 await client.prepareRead({...input(6),lifecycleId:id(21)});assert.equal(calls.length,3);
});

test('generation-only or unconfirmed revocation is refused',async()=>{
 for(const mutate of [r=>r.revocationMode='generation',r=>r.allGenerationsRevoked=false,r=>r.revokedCount=-1,r=>r.effectiveAt=NOW+31000]){const {client}=fixture(({body})=>{const r=responseReceipt(body);mutate(r);return {value:r};});await assert.rejects(client.revokeRead(revoke()),rejected('PROVISIONING_RECEIPT_INVALID',true));}
});

test('commit ACK arriving after acknowledged revocation cannot become an active proof',async()=>{
 let release;const blocked=new Promise(resolve=>{release=resolve;});const {client,calls}=fixture(async({body})=>{if(body.action==='commit_read')await blocked;return {value:responseReceipt(body)};});
 const prepared=await client.prepareRead(input()),committing=client.commitRead({operationId:id(2),prepared});
 await client.revokeRead(revoke());release();await assert.rejects(committing,rejected('PROVISIONING_LIFECYCLE_REVOKED',true));assert.equal(calls.length,3);
});

test('status descriptor verifies restored operation and yields a new prepared proof',async()=>{
 let preparedReceipt;const first=fixture(({body})=>{preparedReceipt=responseReceipt(body);return {value:preparedReceipt};}),descriptor=first.client.describeRead(input());await first.client.prepareRead(input());
 const restored=fixture(({body})=>body.action==='status'?{value:{schema:STATUS_SCHEMA,issuerId:body.issuerId,namespaceId:body.namespaceId,operationId:body.operationId,found:true,receipt:preparedReceipt}}:{value:responseReceipt(body)});
 const status=await restored.client.operationStatus(JSON.parse(JSON.stringify(descriptor)));assert.equal(status.found,true);assert.equal(status.receipt.state,'prepared');await restored.client.commitRead({operationId:id(2),prepared:status.receipt});assert.equal(restored.calls[0].body.expectedRequestSha256,preparedReceipt.requestSha256);
});

test('commit descriptor is persistible and status recovery does not require a runtime proof',async()=>{
 let commitReceipt;const first=fixture(({body})=>{const value=responseReceipt(body);if(body.action==='commit_read')commitReceipt=value;return {value};}),prepared=await first.client.prepareRead(input()),descriptor=first.client.describeCommit({operationId:id(2),prepared});await first.client.commitRead({operationId:id(2),prepared});
 const restored=fixture(({body})=>({value:{schema:STATUS_SCHEMA,issuerId:body.issuerId,namespaceId:body.namespaceId,operationId:body.operationId,found:true,receipt:commitReceipt}}));const status=await restored.client.operationStatus(JSON.parse(JSON.stringify(descriptor)));assert.equal(status.receipt.state,'committed');assert.equal(restored.calls.length,1);
});

test('status cannot reconcile another scope, operation, subject or arbitrary descriptor',async()=>{
 for(const mutate of [r=>r.namespaceId=id(92),r=>r.operationId=id(92),r=>r.receipt.lifecycleId=id(92),r=>r.receipt.requestSha256='a'.repeat(64)]){const {client}=fixture(({body})=>{const command={...fixture().client.describeRead(input())};const request={schema:REQUEST_SCHEMA,issuerId:id(90),namespaceId:id(91),action:command.action,...command.args,generation:1,expectedGeneration:0,area:'growth',slot:'crm-panel-read',role:'manager',caps:[...POLICY.caps],candidateTtlMs:POLICY.candidateTtlMs,lifetimeMs:POLICY.lifetimeMs};const r={schema:STATUS_SCHEMA,issuerId:body.issuerId,namespaceId:body.namespaceId,operationId:body.operationId,found:true,receipt:responseReceipt(request)};mutate(r);return {value:r};});await assert.rejects(client.operationStatus(client.describeRead(input())),error=>error instanceof ProvisioningError&&['PROVISIONING_STATUS_INVALID','PROVISIONING_RECEIPT_INVALID'].includes(error.code));}
 const {client,calls}=fixture();await assert.rejects(client.operationStatus({action:'write',args:input()}),rejected('PROVISIONING_INPUT_INVALID'));await assert.rejects(client.operationStatus({operationId:id(1)}),rejected('PROVISIONING_INPUT_INVALID'));assert.equal(calls.length,0);
});

test('unknown status must be a closed response without another receipt',async()=>{
 const {client}=fixture(({body})=>({value:{schema:STATUS_SCHEMA,issuerId:body.issuerId,namespaceId:body.namespaceId,operationId:body.operationId,found:false}}));assert.deepEqual(await client.operationStatus(client.describeRead(input())),{found:false});
 const bad=fixture(({body})=>({value:{schema:STATUS_SCHEMA,issuerId:body.issuerId,namespaceId:body.namespaceId,operationId:body.operationId,found:false,receipt:{bearer:managerBearer}}}));await assert.rejects(bad.client.operationStatus(bad.client.describeRead(input())),rejected('PROVISIONING_STATUS_INVALID'));
});

test('known acknowledged operation cannot disappear, including journal-required presence after restart',async()=>{
 const unknown=body=>({value:{schema:STATUS_SCHEMA,issuerId:body.issuerId,namespaceId:body.namespaceId,operationId:body.operationId,found:false}});
 const {client}=fixture(({body})=>body.action==='status'?unknown(body):{value:responseReceipt(body)});await client.prepareRead(input());await assert.rejects(client.operationStatus(client.describeRead(input())),rejected('PROVISIONING_STATUS_DISAPPEARED'));
 const restored=fixture(({body})=>unknown(body));await assert.rejects(restored.client.operationStatus({...restored.client.describeRead(input()),requireFound:true}),rejected('PROVISIONING_STATUS_DISAPPEARED'));
 await assert.rejects(restored.client.operationStatus({...restored.client.describeRead(input()),requireFound:'yes'}),rejected('PROVISIONING_INPUT_INVALID'));
});

test('typed remote conflict has no raw errors or data and is not an uncertain commit',async()=>{
 const {client}=fixture(({body})=>({status:409,value:{schema:ERROR_SCHEMA,issuerId:body.issuerId,namespaceId:body.namespaceId,operationId:body.operationId,requestSha256:sha(canonical(body)),code:'GENERATION_CONFLICT'}}));await assert.rejects(client.prepareRead(input()),rejected('PROVISIONING_GENERATION_CONFLICT',false));
 const raw=fixture(()=>({status:409,value:{message:'RAW_ERROR_'+managerBearer,bearer:managerBearer}}));await assert.rejects(raw.client.prepareRead(input()),error=>error instanceof ProvisioningError&&error.code==='PROVISIONING_RESPONSE_INVALID'&&error.uncertain&&!JSON.stringify(error).includes(managerBearer)&&!error.message.includes(managerBearer));
});

test('redirects unsupported statuses types encodings duplicate headers and excess declared size refuse',async()=>{
 for(const extra of [{status:302,headers:{location:'https://evil.invalid/'+managerBearer}},{status:202},{status:204},{headers:{'content-type':'text/html'}},{headers:{'content-encoding':'gzip'}},{headers:{'content-length':String(MAX_RESPONSE+1)}},{headers:{'content-length':'-1'}},{rawHeaders:['content-type','application/json','Content-Type','application/json']}]){const {client,calls}=fixture(({body})=>({value:responseReceipt(body),...extra}));await assert.rejects(client.prepareRead(input()),error=>error instanceof ProvisioningError&&error.uncertain&&!error.message.includes(managerBearer));assert.equal(calls.length,1);assert.equal(calls[0].request.destroyed,true);}
});

test('incremental max size, trailing UTF8 truncation and aborted bodies fail closed',async()=>{
 const valid=Buffer.from(JSON.stringify(responseReceipt({schema:REQUEST_SCHEMA,issuerId:id(90),namespaceId:id(91),action:'prepare_read',...input(),generation:1,expectedGeneration:0,area:'growth',slot:'crm-panel-read',role:'manager',caps:[...POLICY.caps],candidateTtlMs:POLICY.candidateTtlMs,lifetimeMs:POLICY.lifetimeMs})));
 for(const extra of [{chunks:[Buffer.alloc(4096,32),Buffer.alloc(4097,32)]},{bytes:Buffer.concat([valid,Buffer.from([0xc3])])},{bytes:Buffer.from('not json '+managerBearer)},{headers:{'content-length':'1'}},{aborted:true}]){const {client}=fixture(()=>extra);await assert.rejects(client.prepareRead(input()),error=>error instanceof ProvisioningError&&error.uncertain&&!error.message.includes(managerBearer));}
});

test('split UTF8 JSON and matched byte length parse without damaging identity',async()=>{
 const {client}=fixture(({body})=>{const bytes=Buffer.from(JSON.stringify(responseReceipt(body))),chunks=[bytes.subarray(0,23),bytes.subarray(23,100),bytes.subarray(100)];return {bytes,chunks,headers:{'content-length':String(bytes.length)}};});assert.equal((await client.prepareRead(input())).owner,'gestor@synthetic.invalid');
});

test('inactivity timeout destroys request and returns only typed uncertainty',async()=>{
 const {client,calls}=fixture(()=>({timeout:true}));await assert.rejects(client.prepareRead(input()),rejected('PROVISIONING_TRANSPORT_TIMEOUT',true));assert.equal(calls[0].request.destroyed,true);
});

test('absolute timeout bounds a transport that never invokes response or inactivity callback',async()=>{
 const {client,calls}=fixture(()=>({silence:true}));const started=Date.now();await assert.rejects(client.prepareRead(input()),rejected('PROVISIONING_TRANSPORT_TIMEOUT',true));const elapsed=Date.now()-started;assert.ok(elapsed>=TIMEOUT_MS-10&&elapsed<TIMEOUT_MS+2000);assert.equal(calls[0].request.destroyed,true);
});
