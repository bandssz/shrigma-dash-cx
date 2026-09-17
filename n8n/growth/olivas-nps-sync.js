'use strict';
// The caller persists the note before this optional external synchronization.
async function syncOlivasNps(job, config, http) {
  const v = job.payload;
  let taskId = v.task_id || null;
  if (v.brand !== 'olivas' || !config.CU_TOKEN || !config.LISTS.olivas) return {sync_id:job.sync_id,ok:false,task_id:taskId};
  const call = (method,path,body) => http({method,url:'https://api.clickup.com/api/v2/'+path,headers:{Authorization:config.CU_TOKEN,'Content-Type':'application/json'},...(body?{body}:{}),json:true,timeout:15000});
  try {
    if (!taskId) {
      let complete = false;
      for (let page=0;page<50;page++) {
        const data = await call('GET','list/'+config.LISTS.olivas+'/task?archived=false&include_closed=true&order_by=created&reverse=true&page='+page);
        if (!data || !Array.isArray(data.tasks)) throw Error('Invalid page');
        const matches=data.tasks.filter(t=>/^NPS \d+ · Pedido /.test(t.name||'')&&(t.name||'').split(' · Pedido ').slice(1).join(' · Pedido ')===String(v.order));
        if(matches.length>1)throw Error('Ambiguous tasks');
        if(matches.length){taskId=matches[0].id;complete=true;break;}
        if(data.last_page===true||data.tasks.length<100){complete=true;break;}
      }
      if(!complete)throw Error('Incomplete search');
    }
    const name='NPS '+v.score+' · Pedido '+v.order,priority=v.score<=6?1:v.score>=9?4:3;
    if(taskId){
      if(v.sync_kind!=='comment')await call('PUT','task/'+taskId,{name,priority});
      await call('POST','task/'+taskId+'/comment',{comment_text:v.sync_kind==='comment'?'Comentário do cliente: '+v.comment:'Nota (re)registrada: '+v.score+' ('+v.bucket+')'});
    } else {
      const task=await call('POST','list/'+config.LISTS.olivas+'/task',{name,priority,tags:[v.bucket],markdown_description:'**Nota:** '+v.score+' ('+v.bucket+')\n**Pedido:** '+v.order+'\n**Marca:** Olivas do Campo\n**Email:** '+v.email+'\n**Data:** '+v.date+'\n**Origem:** NPS pós-entrega'+(v.comment?'\n**Comentário:** '+v.comment:'')});
      if(!task||!task.id)throw Error('Missing task ID');taskId=task.id;
    }
    return {sync_id:job.sync_id,ok:true,task_id:taskId};
  } catch (_) {return {sync_id:job.sync_id,ok:false,task_id:taskId};}
}
module.exports={syncOlivasNps};
