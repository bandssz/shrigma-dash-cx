'use strict';
// Public inert proposal. No client, env, filesystem, logger, socket or retry.
const crypto=require('node:crypto');
const SOURCES=require('./sources.cjs');
const PROFILE='4f5b8bdec729d2924c043da6bd3c0f8f2ce01a82af614187cefa1322ecef11c9';
const PINS=Object.freeze({profile:'a20c51e10dfff6c781b94158ed392a38c1ec64d30966281ecd2ede72e52f62e9',objects:'00ebc821445ec653bd96b01fa1b74a82207551a1cebd1498e7ddd512bc41a370',empty:'a55f9a2fe863f5797383915b0239f3aab5e3733dcdc8ee222b7ff3f4a9fdb697',installer:'33a412f3d8b8fc4293010e2aec95dc5a8ba3f1296f86000d50e79cfb87ec0bd9'});
const SPEC=Object.freeze({issuerId:'b2dc78c6-5f5c-4a7d-b8c8-1dc8bea378d3',namespaceId:'80e261a9-37b5-45cf-b7aa-374c0d4dfe4b',loginRole:'crm_manager_provisioner',allowedEmailDomain:'oaristocrata.com'});
const COUNT_KEYS=['tables','relations','indexes','functions','types','roles','no_login_roles','restricted_roles','membership_edges','passworded_roles'];
const COUNTS=Object.freeze({tables:4,relations:13,indexes:2,functions:7,types:8,roles:2,no_login_roles:2,restricted_roles:2,membership_edges:0,passworded_roles:0});
const STATE_KEYS=['issuerRows','issuerMatches','issuerActive','subjects','operations','generations','liveKeys','serviceScram','ownerPasswordAbsent','serviceSessions','serviceLogin','ownerNoLogin','serviceRestricted','ownerRestricted'];
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
function refuse(){throw Error('READ_ACTIVATION_REVIEW_REFUSED');}
function closed(v,keys){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k)))refuse();}
function validateSources(s=SOURCES){closed(s,['profile','objects','empty']);for(const k of Object.keys(s))if(typeof s[k]!=='string'||sha(s[k])!==PINS[k])refuse();return s;}
function validateVerifier(v){
 if(typeof v!=='string'||!/^SCRAM-SHA-256\$4096:([A-Za-z0-9+/]{22}==)\$([A-Za-z0-9+/]{43}=):([A-Za-z0-9+/]{43}=)$/.test(v))refuse();
 const [,a,b]=v.split('$'),parts=[a.slice(5),...b.split(':')];
 if(parts.some((x,i)=>Buffer.from(x,'base64').length!==(i===0?16:32)||Buffer.from(x,'base64').toString('base64')!==x))refuse();return v;
}
function passwordQuery(verifier){
 validateVerifier(verifier);
 // pg consumes .values normally, but accidental JSON/console inspection of
 // the descriptor does not enumerate the secret. Caller must never log it.
 const q={text:"SELECT length(pg_catalog.set_config('shrigma.read.scram',$1,true)) BETWEEN 120 AND 256 AS accepted"};
 Object.defineProperty(q,'values',{value:Object.freeze([verifier]),enumerable:false});return Object.freeze(q);
}
const strip=s=>s.trim().replace(/;$/,'');
const STATE_SQL=`SELECT jsonb_build_object(
 'issuerRows',(SELECT count(*) FROM public.shrigma_crm_manager_issuer_v1),
 'issuerMatches',(SELECT count(*)=1 FROM public.shrigma_crm_manager_issuer_v1 WHERE issuer_id=current_setting('shrigma.read.issuer')::uuid AND namespace_id=current_setting('shrigma.read.namespace')::uuid AND login_role='crm_manager_provisioner' AND allowed_email_domains=ARRAY['oaristocrata.com']),
 'issuerActive',coalesce((SELECT active FROM public.shrigma_crm_manager_issuer_v1 WHERE issuer_id=current_setting('shrigma.read.issuer')::uuid),false),
 'subjects',(SELECT count(*) FROM public.shrigma_crm_manager_subject_v1),
 'operations',(SELECT count(*) FROM public.shrigma_crm_manager_operation_v1),
 'generations',(SELECT count(*) FROM public.shrigma_crm_manager_generation_v1),
 'liveKeys',(SELECT count(*) FROM public.shrigma_crm_manager_generation_v1 g JOIN public.crm_dash_chave k ON k.chave=g.principal_id WHERE g.namespace_id=current_setting('shrigma.read.namespace')::uuid AND (g.state IN ('prepared','active') OR k.ativo OR k.revogada_em IS NULL)),
 'serviceScram',(SELECT rolpassword IS NOT NULL AND rolpassword ~ '^SCRAM-SHA-256[$]4096:[A-Za-z0-9+/]{22}==[$][A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$' FROM pg_authid WHERE rolname='crm_manager_provisioner'),
 'ownerPasswordAbsent',(SELECT rolpassword IS NULL FROM pg_authid WHERE rolname='crm_manager_function_owner_v1'),
 'serviceSessions',(SELECT count(*) FROM pg_stat_activity WHERE usename='crm_manager_provisioner' AND pid<>pg_backend_pid()),
 'serviceLogin',(SELECT rolcanlogin FROM pg_roles WHERE rolname='crm_manager_provisioner'),
 'ownerNoLogin',(SELECT NOT rolcanlogin FROM pg_roles WHERE rolname='crm_manager_function_owner_v1'),
 'serviceRestricted',(SELECT NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolinherit AND NOT rolreplication AND NOT rolbypassrls AND rolconnlimit=2 FROM pg_roles WHERE rolname='crm_manager_provisioner'),
 'ownerRestricted',(SELECT NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolinherit AND NOT rolreplication AND NOT rolbypassrls AND rolconnlimit=-1 FROM pg_roles WHERE rolname='crm_manager_function_owner_v1')
) AS state;`;
const SCOPE_QUERY=Object.freeze({text:"SELECT pg_catalog.set_config('shrigma.read.issuer',$1,true) IS NOT NULL AND pg_catalog.set_config('shrigma.read.namespace',$2,true) IS NOT NULL AS accepted",values:Object.freeze([SPEC.issuerId,SPEC.namespaceId])});
const LOG_SETTINGS="SET LOCAL log_statement='none'; SET LOCAL log_min_error_statement='panic'; SET LOCAL log_parameter_max_length=0; SET LOCAL log_parameter_max_length_on_error=0; SET LOCAL log_min_duration_statement=-1; SET LOCAL log_min_duration_sample=-1; SET LOCAL log_transaction_sample_rate=0; SET LOCAL log_error_verbosity='terse'; SET LOCAL client_min_messages='error';";
const LOG_GUARD=`current_setting('log_statement')='none' AND current_setting('log_min_error_statement')='panic'
 AND current_setting('log_parameter_max_length')='0' AND current_setting('log_parameter_max_length_on_error')='0'
 AND current_setting('log_min_duration_statement')='-1' AND current_setting('log_min_duration_sample')='-1'
 AND current_setting('log_transaction_sample_rate')::numeric=0 AND current_setting('log_error_verbosity')='terse'
 AND coalesce(current_setting('shared_preload_libraries',true),'')='' AND coalesce(current_setting('session_preload_libraries',true),'')=''
 AND coalesce(current_setting('local_preload_libraries',true),'')='' AND current_setting('pgaudit.log',true) IS NULL
 AND current_setting('server_version_num')::int/10000=17 AND NOT EXISTS(SELECT 1 FROM pg_extension WHERE NOT (extname='plpgsql' AND extversion='1.0' OR extname='pgcrypto' AND extversion='1.3'))`;
// Closed diagnostic only. A vector-containing image is not itself proof that
// its installed extension version/binary has no observers. No raw settings,
// extension names/versions, SQL rows, passwords or verifier leave this query.
const POLICY_QUERY=Object.freeze({text:`SELECT jsonb_build_object('schema','crm-manager-read-activation-policy-v1',
 'loggingVerified',current_setting('log_statement')='none' AND current_setting('log_min_error_statement')='panic' AND current_setting('log_parameter_max_length')='0' AND current_setting('log_parameter_max_length_on_error')='0' AND current_setting('log_min_duration_statement')='-1' AND current_setting('log_min_duration_sample')='-1' AND current_setting('log_transaction_sample_rate')::numeric=0 AND current_setting('log_error_verbosity')='terse',
 'preloadAbsent',coalesce(current_setting('shared_preload_libraries',true),'')='' AND coalesce(current_setting('session_preload_libraries',true),'')='' AND coalesce(current_setting('local_preload_libraries',true),'')='',
 'pgcryptoPresent',EXISTS(SELECT 1 FROM pg_extension WHERE extname='pgcrypto'),
 'pgcryptoVersionSupported',NOT EXISTS(SELECT 1 FROM pg_extension WHERE extname='pgcrypto' AND extversion<>'1.3'),
 'vectorPresent',EXISTS(SELECT 1 FROM pg_extension WHERE extname='vector'),
 'auditPresent',EXISTS(SELECT 1 FROM pg_extension WHERE extname IN ('pgaudit','pg_stat_statements','auto_explain')) OR current_setting('pgaudit.log',true) IS NOT NULL,
 'unknownExtensionsPresent',EXISTS(SELECT 1 FROM pg_extension WHERE extname NOT IN ('plpgsql','pgcrypto','vector','pgaudit','pg_stat_statements','auto_explain')),
 'extensionPolicySupported',current_setting('server_version_num')::int/10000=17 AND NOT EXISTS(SELECT 1 FROM pg_extension WHERE NOT (extname='plpgsql' AND extversion='1.0' OR extname='pgcrypto' AND extversion='1.3'))) AS policy;`});
function observations(s){return `SELECT profile_sha256 INTO core FROM (${strip(s.profile)}) p; SELECT to_jsonb(o) INTO objects FROM (${strip(s.objects)}) o; SELECT state INTO observed FROM (${strip(STATE_SQL)}) a;`;}
function expectedCounts(phase){return {...COUNTS,...(phase==='empty'?{}:{no_login_roles:phase==='disabled'?2:1,restricted_roles:phase==='disabled'?2:1,passworded_roles:1})};}
function predicate(phase){
 const c=expectedCounts(phase),base=COUNT_KEYS.map(k=>`objects->>'${k}'='${c[k]}'`).join(' AND ');
 let state=`observed->>'ownerPasswordAbsent'='true' AND observed->>'serviceSessions'='0' AND observed->>'ownerNoLogin'='true' AND observed->>'ownerRestricted'='true' AND observed->>'serviceRestricted'='true' AND observed->>'serviceLogin'='${['staged','active'].includes(phase)}'`;
 if(phase==='empty')state+=` AND observed->>'issuerRows'='0' AND observed->>'issuerMatches'='false' AND observed->>'issuerActive'='false' AND observed->>'serviceScram'='false' AND observed->>'subjects'='0' AND observed->>'operations'='0' AND observed->>'generations'='0' AND observed->>'liveKeys'='0'`;
 else {state+=` AND observed->>'issuerRows'='1' AND observed->>'issuerMatches'='true' AND observed->>'issuerActive'='${phase==='active'}' AND observed->>'serviceScram'='true'`;
  if(phase==='staged')state+=` AND observed->>'subjects'='0' AND observed->>'operations'='0' AND observed->>'generations'='0' AND observed->>'liveKeys'='0'`;
  if(phase==='disabled')state+=` AND observed->>'liveKeys'='0'`;
 }
 return `core='${PROFILE}' AND objects->>'context_verified'='true' AND ${base} AND ${state}`;
}
function doBlock(body){return `DO $read_activation$ DECLARE core text;objects jsonb;observed jsonb;secret text;changed integer; BEGIN ${body} END $read_activation$;`;}
function coreGuard(phase,s){return `${observations(s)} IF (${predicate(phase)}) IS DISTINCT FROM true THEN RAISE EXCEPTION USING MESSAGE='READ_ACTIVATION_REVIEW_REFUSED'; END IF;`;}
const CONTEXT=`IF current_database()<>'listmonk' OR current_user<>'postgres' OR session_user<>'postgres' OR current_setting('server_version_num')::int/10000<>17 OR current_setting('transaction_read_only')<>'off' OR current_setting('transaction_timeout')<>'500ms' THEN RAISE EXCEPTION USING MESSAGE='READ_ACTIVATION_REVIEW_REFUSED'; END IF;
 IF NOT pg_try_advisory_xact_lock(1609296685,1) THEN RAISE EXCEPTION USING MESSAGE='READ_ACTIVATION_REVIEW_REFUSED'; END IF;
 LOCK TABLE public.shrigma_crm_manager_issuer_v1,public.shrigma_crm_manager_subject_v1,public.shrigma_crm_manager_operation_v1,public.shrigma_crm_manager_generation_v1 IN SHARE ROW EXCLUSIVE MODE NOWAIT;`;
const SECRET_GUARD=`secret:=current_setting('shrigma.read.scram',true);
 IF secret IS NULL OR secret !~ '^SCRAM-SHA-256[$]4096:[A-Za-z0-9+/]{22}==[$][A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$'
 OR encode(decode(split_part(split_part(secret,'$',2),':',2),'base64'),'base64')<>split_part(split_part(secret,'$',2),':',2)
 OR encode(decode(split_part(split_part(secret,'$',3),':',1),'base64'),'base64')<>split_part(split_part(secret,'$',3),':',1)
 OR encode(decode(split_part(split_part(secret,'$',3),':',2),'base64'),'base64')<>split_part(split_part(secret,'$',3),':',2)
 THEN RAISE EXCEPTION USING MESSAGE='READ_ACTIVATION_REVIEW_REFUSED'; END IF;`;
function mutation(action){
 if(action==='stage')return `${SECRET_GUARD} EXECUTE format('ALTER ROLE crm_manager_provisioner LOGIN PASSWORD %L',secret); secret:=NULL;
 INSERT INTO public.shrigma_crm_manager_issuer_v1(issuer_id,namespace_id,login_role,allowed_email_domains,active) VALUES(current_setting('shrigma.read.issuer')::uuid,current_setting('shrigma.read.namespace')::uuid,'crm_manager_provisioner',ARRAY['oaristocrata.com'],false);`;
 if(action==='activate')return `IF observed->>'subjects'<>'0' OR observed->>'operations'<>'0' OR observed->>'generations'<>'0' OR observed->>'liveKeys'<>'0' THEN RAISE EXCEPTION USING MESSAGE='READ_ACTIVATION_REVIEW_REFUSED'; END IF;
 UPDATE public.shrigma_crm_manager_issuer_v1 SET active=true WHERE issuer_id=current_setting('shrigma.read.issuer')::uuid AND namespace_id=current_setting('shrigma.read.namespace')::uuid AND NOT active; GET DIAGNOSTICS changed=ROW_COUNT; IF changed<>1 THEN RAISE EXCEPTION USING MESSAGE='READ_ACTIVATION_REVIEW_REFUSED'; END IF;`;
 return `IF observed->>'liveKeys'<>'0' THEN RAISE EXCEPTION USING MESSAGE='READ_ACTIVATION_REVIEW_REFUSED'; END IF;
 UPDATE public.shrigma_crm_manager_issuer_v1 SET active=false WHERE issuer_id=current_setting('shrigma.read.issuer')::uuid AND namespace_id=current_setting('shrigma.read.namespace')::uuid; GET DIAGNOSTICS changed=ROW_COUNT; IF changed<>1 THEN RAISE EXCEPTION USING MESSAGE='READ_ACTIVATION_REVIEW_REFUSED'; END IF; ALTER ROLE crm_manager_provisioner NOLOGIN;`;
}
function buildPlan(action,options={}){
 if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(k=>!['fromPhase','sources'].includes(k)))refuse();
 const {fromPhase,sources=SOURCES}=options;
 validateSources(sources);if(!['stage','activate','disable'].includes(action))refuse();
 const before=action==='stage'?'empty':action==='activate'?'staged':fromPhase;
 if(action==='disable'&&!['staged','active'].includes(before)||action!=='disable'&&fromPhase!==undefined)refuse();
 const after={stage:'staged',activate:'active',disable:'disabled'}[action];
 const guards=CONTEXT+` IF (${LOG_GUARD}) IS DISTINCT FROM true THEN RAISE EXCEPTION USING MESSAGE='READ_ACTIVATION_REVIEW_REFUSED'; END IF;`+coreGuard(before,sources);
 const commands=[Object.freeze({text:"SET transaction_timeout='500ms';"}),Object.freeze({text:"BEGIN ISOLATION LEVEL SERIALIZABLE; SET LOCAL search_path=pg_catalog; SET LOCAL statement_timeout='4s'; SET LOCAL lock_timeout='500ms'; SET LOCAL idle_in_transaction_session_timeout='5s';"}),Object.freeze({text:LOG_SETTINGS}),SCOPE_QUERY,Object.freeze({text:doBlock(guards)})];
 // The only password binding occurs after the complete same-transaction guard.
 // The future executor must durably record intent before the mutating command.
 const mutating=Object.freeze({text:doBlock(guards+'/* MUTATION START */'+mutation(action)+'/* MUTATION END */'+coreGuard(after,sources))});
 return Object.freeze({schema:'crm-manager-read-activation-plan-v1',action,before,after,spec:SPEC,profile:PROFILE,sourcePins:PINS,commands:Object.freeze(commands),requiresSecret:action==='stage',passwordQuery:action==='stage'?passwordQuery:null,mutating,commit:Object.freeze({text:'COMMIT;'}),readback:Object.freeze({text:sources.profile+sources.objects+STATE_SQL}),readOnlyBegin:Object.freeze({text:"BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY; SET LOCAL search_path=pg_catalog; SET LOCAL statement_timeout='4s'; SET LOCAL lock_timeout='500ms'; SET LOCAL idle_in_transaction_session_timeout='5s';"}),scopeQuery:SCOPE_QUERY,policyQuery:POLICY_QUERY,rollback:Object.freeze({text:'ROLLBACK;'})});
}
function admitSnapshot(snapshot,phase){
 if(!['empty','staged','active','disabled'].includes(phase))refuse();closed(snapshot,['profileSha256','objects','state']);
 if(snapshot.profileSha256!==PROFILE)refuse();closed(snapshot.objects,['context_verified',...COUNT_KEYS]);closed(snapshot.state,STATE_KEYS);
 if(snapshot.objects.context_verified!==true||COUNT_KEYS.some(k=>snapshot.objects[k]!==expectedCounts(phase)[k]))refuse();
 const s=snapshot.state;for(const k of ['issuerRows','subjects','operations','generations','liveKeys','serviceSessions'])if(!Number.isSafeInteger(s[k])||s[k]<0||s[k]>100000)refuse();
 for(const k of ['issuerMatches','issuerActive','serviceScram','ownerPasswordAbsent','serviceLogin','ownerNoLogin','serviceRestricted','ownerRestricted'])if(typeof s[k]!=='boolean')refuse();
 if(!s.ownerPasswordAbsent||!s.ownerNoLogin||!s.ownerRestricted||!s.serviceRestricted||s.serviceLogin!==['staged','active'].includes(phase)||s.serviceSessions!==0||s.issuerRows!==(phase==='empty'?0:1)||s.issuerMatches!==(phase!=='empty')||s.issuerActive!==(phase==='active')||s.serviceScram!==(phase!=='empty'))refuse();
 if(['empty','staged'].includes(phase)&&(s.subjects||s.operations||s.generations||s.liveKeys)||phase==='disabled'&&s.liveKeys)refuse();
 return Object.freeze({schema:'crm-manager-read-activation-admission-v1',phase,coreVerified:true,rolePolicyVerified:true,issuerBound:phase!=='empty',issuerActive:phase==='active',ownerNoLogin:true,serviceLogin:['staged','active'].includes(phase),publicResidueAccepted:false,counts:Object.freeze({subjects:s.subjects,operations:s.operations,generations:s.generations,liveKeys:s.liveKeys})});
}
function admitPolicy(v){closed(v,['schema','loggingVerified','preloadAbsent','pgcryptoPresent','pgcryptoVersionSupported','vectorPresent','auditPresent','unknownExtensionsPresent','extensionPolicySupported']);if(v.schema!=='crm-manager-read-activation-policy-v1'||Object.keys(v).some(k=>k!=='schema'&&typeof v[k]!=='boolean'))refuse();
 const phase=!v.loggingVerified?'refused_logging':!v.preloadAbsent||v.auditPresent?'refused_observer':!v.extensionPolicySupported||!v.pgcryptoVersionSupported||v.unknownExtensionsPresent||v.vectorPresent?'refused_extension_review':'supported';
 return Object.freeze({...v,phase});
}
module.exports=Object.freeze({buildPlan,admitSnapshot,admitPolicy,validateSources,validateVerifier,passwordQuery,STATE_SQL,SPEC,PINS,PROFILE,COUNTS,POLICY_QUERY});
