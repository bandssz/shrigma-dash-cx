'use strict';
// API16 lists plus original business metadata. API16's denied template GET is
// never tried. The original pool needs reviewed column SELECT before enabling.
const {brandOf}=require('./native-read.cjs');
const SQL=`WITH verified AS MATERIALIZED (SELECT public.shrigma_crm_campaign_auth_v1($1::text) auth)
 SELECT jsonb_build_object('auth',v.auth,'metadata',
 CASE WHEN v.auth->>'actor'=$2::text AND v.auth->'caps' ? 'read_content' THEN
 jsonb_build_object('read_at',clock_timestamp(),
  'templates',coalesce((SELECT jsonb_agg(jsonb_build_object('id',t.id,'name',t.name,'type',t.type,
   'available',true,'version',md5(to_jsonb(t)::text)) ORDER BY t.id)
   FROM public.templates t WHERE t.type::text='campaign'),'[]'::jsonb),
  'initiatives',coalesce((SELECT jsonb_agg(jsonb_build_object('utm_campaign',f.utm_campaign,'key',f.familia) ORDER BY f.utm_campaign)
   FROM public.crm_familia_campanha f WHERE f.marca=$3::text),'[]'::jsonb))
 ELSE NULL END) result FROM verified v`;
const fail=(status,error)=>Object.assign(Error(error),{status,body:{error,message:'Catálogo não confirmado.'}});
function createNativeCatalog({request,query}){
 if(typeof request!=='function'||typeof query!=='function')throw Error('NATIVE_CATALOG_CONFIG');
 const supports=command=>command?.acao==='campanha_catalogo';
 async function execute({key,auth,command,interrupted=()=>false}){
  if(!supports(command))return null;
  const brand=command.brand;if(!['aristo','fish'].includes(brand))throw fail(422,'BRAND_INVALID');
  if(!auth?.actor||!Array.isArray(auth.caps)||!auth.caps.includes('read_content'))throw fail(403,'CAPABILITY_MISSING');
  if(Object.hasOwn(auth,'brand')&&auth.brand!==brand)throw fail(403,'BRAND_DENIED');
  if(interrupted())throw fail(503,'READ_UNAVAILABLE');
  const data=await request('/api/lists?minimal=true&per_page=all'),lists=Array.isArray(data)?data:data?.results;
  if(!Array.isArray(lists))throw fail(503,'CATALOG_UNAVAILABLE');
  const rows=(await query(SQL,[key,auth.actor,brand]))?.rows,proof=rows?.length===1?rows[0].result:null;
  if(proof?.auth?.actor!==auth.actor||!Array.isArray(proof.auth.caps)||!proof.auth.caps.includes('read_content')||Object.hasOwn(proof.auth,'brand')&&proof.auth.brand!==brand||interrupted())throw fail(403,'AUTHORIZATION_CHANGED');
  const meta=proof.metadata;if(!meta||!Array.isArray(meta.templates)||!Array.isArray(meta.initiatives)||!Number.isFinite(Date.parse(meta.read_at)))throw fail(503,'CATALOG_UNAVAILABLE');
  return {status:200,body:{brand,current:true,read_at:meta.read_at,
   lists:lists.filter(l=>brandOf(l)===brand).map(l=>({id:l.id,name:l.name,brand,available:l.status==='active'})),
   templates:meta.templates,initiatives:meta.initiatives}};
 }
 return Object.freeze({supports,execute});
}
module.exports={createNativeCatalog,SQL};
