'use strict';
// Explicit composition alongside the sealed original transport. Production
// bootstraps do not enable it until all write/version consumers are migrated.
const {createExecutor,AUTH_SQL,unavailable}=require('./transport.cjs');
function createNativeExecutor({pool,native,nativeReads,enabled=false,...originalOptions}){
 const fallback=createExecutor({pool,native,...originalOptions});
 if(enabled&&(!nativeReads||typeof nativeReads.supports!=='function'||typeof nativeReads.execute!=='function'))throw Error('NATIVE_READ_CONFIG');
 return async input=>{
  if(!enabled||!nativeReads.supports(input.command))return fallback(input);
  try{
   const rows=(await pool.query(AUTH_SQL,[input.key]))?.rows;if(rows?.length!==1)throw Error('AUTH_RESPONSE_INVALID');
   const auth=rows[0].auth;
   if(!auth||typeof auth.actor!=='string'||!auth.actor.trim()||!Array.isArray(auth.caps)||auth.caps.some(c=>typeof c!=='string'))return {status:401,body:{error:'UNAUTHORIZED',message:'Autenticação necessária.'}};
   if(Object.hasOwn(auth,'brand')&&(!['fish','aristo'].includes(auth.brand)||auth.brand!==input.command.brand))return {status:403,body:{error:'BRAND_DENIED',message:'Acesso não autorizado para esta marca.'}};
   return await nativeReads.execute({...input,auth});
  }catch(e){return e.status&&e.body?{status:e.status,body:e.body}:unavailable();}
 };
}
module.exports={createNativeExecutor};
