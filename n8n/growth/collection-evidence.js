function collectionEvidence(pagesByBrand,readAt,executionId){
 return ['fish','aristo','olivas'].map(brand=>{
  const pages=pagesByBrand[brand]||[];
  return {brand,pages:pages.length,checked_at:readAt,execution_id:String(executionId),
   complete:pages.length>0&&pages.every(p=>!p?.errors?.length&&Array.isArray(p?.data?.orders?.nodes))&&pages.at(-1)?.data?.orders?.pageInfo?.hasNextPage===false};
 });
}
module.exports={collectionEvidence};
