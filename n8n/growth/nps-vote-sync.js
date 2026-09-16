'use strict';
// Executed only AFTER the vote transaction and webhook response. Never writes
// subscriber attributes. Unknown remote outcomes are recorded, never retried blindly.
async function syncNpsVote(job,C,http){
 const v=job.payload;let taskId=v.task_id||null;
 if(!C.CU_TOKEN||!C.LISTS[v.brand])return {sync_id:job.sync_id,ok:false,task_id:taskId};
 const headers={Authorization:C.CU_TOKEN,'Content-Type':'application/json'};
 const call=(method,path,body)=>http({method,url:'https://api.clickup.com/api/v2/'+path,headers,...(body?{body}:{}),json:true,timeout:15000});
 try{
  if(!taskId){
   let complete=false;
   for(let page=0;page<50;page++){
    const data=await call('GET','list/'+C.LISTS[v.brand]+'/task?archived=false&include_closed=true&order_by=created&reverse=true&page='+page);
    if(!data||!Array.isArray(data.tasks))throw Error('Invalid task page');
    const matches=data.tasks.filter(t=>/^NPS \d+ · Pedido /.test(t.name||'')&&(t.name||'').split(' · Pedido ').slice(1).join(' · Pedido ')===String(v.order));
    if(matches.length>1)throw Error('Ambiguous tasks');
    if(matches.length){taskId=matches[0].id;complete=true;break;}
    if(data.last_page===true||data.tasks.length<100){complete=true;break;}
   }
   if(!complete)throw Error('Incomplete task search');
  }
  const priority=v.score<=6?1:v.score>=9?4:3,name='NPS '+v.score+' · Pedido '+v.order;
  if(taskId){
   await call('PUT','task/'+taskId,{name,priority});
   await call('POST','task/'+taskId+'/comment',{comment_text:'Nota (re)registrada: '+v.score+' ('+v.bucket+')'});
  }else{
   const desc='**Nota:** '+v.score+' ('+v.bucket+')\n**Pedido:** '+v.order+'\n**Marca:** '+v.brand+'\n**Email:** '+v.email+'\n**Data:** '+v.date+'\n**Origem:** NPS pos-entrega';
   const task=await call('POST','list/'+C.LISTS[v.brand]+'/task',{name,markdown_description:desc,priority,tags:[v.bucket]});
   if(!task||!task.id)throw Error('Missing task ID');taskId=task.id;
  }
  return {sync_id:job.sync_id,ok:true,task_id:taskId};
 }catch(_){return {sync_id:job.sync_id,ok:false,task_id:taskId};}
}
module.exports={syncNpsVote};
